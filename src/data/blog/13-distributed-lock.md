---
title: "分布式锁的三种实现方式"
author: Tu
pubDatetime: 2024-11-06T10:00:00Z
featured: true
draft: false
tags:
  - 分布式
  - Redis
description: "对比基于 Redis、MySQL、ZooKeeper 三种分布式锁实现方案，分析各自的优缺点和适用场景"
---

在分布式系统中，多个服务实例可能同时操作共享资源，需要分布式锁来保证互斥性。本文对比三种主流实现方案。

## 为什么需要分布式锁

单机环境下，`sync.Mutex` 可以保证同一进程内的并发安全。但在分布式系统中：

```
用户下单 → 扣库存
         ↗
服务A ---         → 数据库
         ↘
服务B ---
```

服务A和服务B可能同时读到库存=1，同时下单，导致超卖。

## 方案一：Redis 分布式锁

### 基础实现

```go
// SET key value NX EX seconds
// NX: 不存在才设置
// EX: 设置过期时间（防止死锁）
func tryLock(ctx context.Context, rdb *redis.Client, key, value string, ttl time.Duration) (bool, error) {
    return rdb.SetNX(ctx, key, value, ttl).Result()
}

func unlock(ctx context.Context, rdb *redis.Client, key, value string) error {
    // Lua 脚本保证原子性：只删除自己的锁
    script := `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        else
            return 0
        end
    `
    return rdb.Eval(ctx, script, []string{key}, value).Err()
}
```

### 完整封装

```go
type RedisLock struct {
    client *redis.Client
    key    string
    value  string
    ttl    time.Duration
}

func NewRedisLock(client *redis.Client, key string, ttl time.Duration) *RedisLock {
    return &RedisLock{
        client: client,
        key:    key,
        value:  uuid.New().String(), // 唯一标识，防止误删
        ttl:    ttl,
    }
}

// TryLock 非阻塞尝试获取锁
func (l *RedisLock) TryLock(ctx context.Context) (bool, error) {
    return l.client.SetNX(ctx, l.key, l.value, l.ttl).Result()
}

// Lock 阻塞等待获取锁
func (l *RedisLock) Lock(ctx context.Context) error {
    for {
        ok, err := l.TryLock(ctx)
        if err != nil {
            return err
        }
        if ok {
            return nil
        }

        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-time.After(50 * time.Millisecond): // 重试间隔
        }
    }
}

// Unlock 释放锁
func (l *RedisLock) Unlock(ctx context.Context) error {
    script := redis.NewScript(`
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        end
        return 0
    `)
    return script.Run(ctx, l.client, []string{l.key}, l.value).Err()
}

// 续期（看门狗机制）
func (l *RedisLock) Renew(ctx context.Context) error {
    return l.client.Expire(ctx, l.key, l.ttl).Err()
}
```

### Redis 锁的问题

**主从切换导致锁丢失**：主节点设置锁后宕机，从节点升为主节点，但锁的数据未同步，导致锁丢失。

**Redlock 算法**解决此问题（需要至少5个独立Redis节点，在多数节点成功加锁才视为成功）：

```go
// 使用 github.com/go-redsync/redsync 库
import "github.com/go-redsync/redsync/v4"

rs := redsync.New(pool)
mutex := rs.NewMutex("mylock")
if err := mutex.Lock(); err != nil {
    return err
}
defer mutex.Unlock()
```

## 方案二：MySQL 分布式锁

### 基于唯一索引

```sql
CREATE TABLE distributed_lock (
    lock_key   VARCHAR(128) PRIMARY KEY,
    lock_value VARCHAR(64)  NOT NULL, -- 锁的持有者标识
    expire_at  DATETIME     NOT NULL, -- 过期时间
    created_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

```go
type MySQLLock struct {
    db    *sql.DB
    key   string
    value string
    ttl   time.Duration
}

func (l *MySQLLock) TryLock(ctx context.Context) (bool, error) {
    expireAt := time.Now().Add(l.ttl)
    _, err := l.db.ExecContext(ctx, `
        INSERT INTO distributed_lock (lock_key, lock_value, expire_at)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            lock_value = IF(expire_at < NOW(), VALUES(lock_value), lock_value),
            expire_at  = IF(expire_at < NOW(), VALUES(expire_at), expire_at)
    `, l.key, l.value, expireAt)

    if err != nil {
        return false, err
    }

    // 检查是否是我们的锁
    var storedValue string
    err = l.db.QueryRowContext(ctx,
        "SELECT lock_value FROM distributed_lock WHERE lock_key = ?",
        l.key,
    ).Scan(&storedValue)

    return storedValue == l.value, err
}

func (l *MySQLLock) Unlock(ctx context.Context) error {
    _, err := l.db.ExecContext(ctx,
        "DELETE FROM distributed_lock WHERE lock_key = ? AND lock_value = ?",
        l.key, l.value,
    )
    return err
}
```

### 基于 SELECT FOR UPDATE

```go
func processWithLock(ctx context.Context, db *sql.DB, orderID string, fn func(*sql.Tx) error) error {
    tx, err := db.BeginTx(ctx, nil)
    if err != nil {
        return err
    }
    defer tx.Rollback()

    // 加行锁，其他事务的 SELECT FOR UPDATE 会阻塞
    var locked int
    err = tx.QueryRowContext(ctx,
        "SELECT 1 FROM orders WHERE id = ? FOR UPDATE",
        orderID,
    ).Scan(&locked)
    if err != nil {
        return err
    }

    if err := fn(tx); err != nil {
        return err
    }

    return tx.Commit()
}
```

## 方案三：etcd 分布式锁

etcd 基于 Raft 协议，强一致性，适合对正确性要求极高的场景：

```go
import (
    "go.etcd.io/etcd/client/v3"
    "go.etcd.io/etcd/client/v3/concurrency"
)

func withEtcdLock(client *clientv3.Client, key string, fn func() error) error {
    // 创建会话，TTL 秒后自动过期（会话续期由 etcd 自动处理）
    session, err := concurrency.NewSession(client, concurrency.WithTTL(15))
    if err != nil {
        return err
    }
    defer session.Close()

    // 创建互斥锁
    mutex := concurrency.NewMutex(session, "/locks/"+key)

    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()

    // 获取锁（阻塞等待）
    if err := mutex.Lock(ctx); err != nil {
        return err
    }
    defer mutex.Unlock(ctx)

    return fn()
}
```

## 三种方案对比

| 维度 | Redis | MySQL | etcd |
|------|-------|-------|------|
| 性能 | 极高 | 中等 | 高 |
| 可靠性 | 中等（主从问题） | 高 | 极高 |
| 实现复杂度 | 低 | 中 | 低（有封装库） |
| 适用场景 | 高并发、短暂锁 | 低频、数据库已有 | 对一致性要求高 |
| 依赖 | Redis | MySQL | etcd |

## 实际项目选择建议

1. **绝大多数场景**：Redis 分布式锁（简单、高性能）
2. **强一致性要求**（如金融转账）：etcd 或 MySQL 行锁 + 事务
3. **已有 MySQL 且并发不高**：MySQL 唯一索引方案，减少依赖

## 常见问题

**Q：锁超时了但业务还没完成怎么办？**

答：使用"看门狗"机制，在锁快到期时自动续期：

```go
func (l *RedisLock) startWatchdog(ctx context.Context) {
    ticker := time.NewTicker(l.ttl / 3) // 在 TTL 1/3 时续期
    go func() {
        defer ticker.Stop()
        for {
            select {
            case <-ctx.Done():
                return
            case <-ticker.C:
                l.Renew(context.Background())
            }
        }
    }()
}
```

**Q：锁的 value 为什么要用 UUID？**

答：防止误删。假设A持有锁，锁恰好超时，B获取了锁，此时A完成业务去删锁，如果只判断key不判断value，A会把B的锁删掉。

## 总结

分布式锁的核心要求：
1. **互斥性**：同一时刻只有一个持有者
2. **防死锁**：持有者宕机后锁自动释放（TTL）
3. **防误删**：只能删除自己的锁（UUID value + Lua 原子操作）
4. **容错性**：锁服务部分故障不影响整体（Redlock / etcd）
