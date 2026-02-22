---
title: "Redis 在 Go 项目中的实战应用"
author: Tu
pubDatetime: 2024-08-14T10:00:00Z
featured: false
draft: false
tags:
  - Go
  - Redis
description: "使用 go-redis 客户端实现缓存、分布式锁、排行榜等 Redis 常用场景"
---

Redis 是后端开发中最常用的缓存和数据结构服务。本文通过实际代码演示如何在 Go 项目中高效使用 Redis，涵盖缓存、分布式锁、排行榜等常见场景。

## 安装与连接

```bash
go get github.com/redis/go-redis/v9
```

```go
package cache

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

var rdb *redis.Client

func Init(addr, password string, db int) {
    rdb = redis.NewClient(&redis.Options{
        Addr:         addr,
        Password:     password,
        DB:           db,
        PoolSize:     10,              // 连接池大小
        MinIdleConns: 5,               // 最小空闲连接
        DialTimeout:  5 * time.Second,
        ReadTimeout:  3 * time.Second,
        WriteTimeout: 3 * time.Second,
    })
}

func Client() *redis.Client {
    return rdb
}
```

## 场景一：缓存用户信息

```go
package cache

import (
    "context"
    "encoding/json"
    "fmt"
    "time"
)

type UserCache struct {
    rdb *redis.Client
    ttl time.Duration
}

func NewUserCache(rdb *redis.Client) *UserCache {
    return &UserCache{rdb: rdb, ttl: 30 * time.Minute}
}

func (c *UserCache) key(userID int64) string {
    return fmt.Sprintf("user:%d", userID)
}

// GetUser 先查缓存，缓存未命中则回源并写入缓存
func (c *UserCache) GetUser(ctx context.Context, userID int64, fetchFn func() (*User, error)) (*User, error) {
    key := c.key(userID)

    // 尝试从缓存获取
    data, err := c.rdb.Get(ctx, key).Bytes()
    if err == nil {
        var user User
        if err := json.Unmarshal(data, &user); err == nil {
            return &user, nil
        }
    }

    // 缓存未命中，回源查询
    user, err := fetchFn()
    if err != nil {
        return nil, err
    }

    // 写入缓存
    if data, err := json.Marshal(user); err == nil {
        c.rdb.Set(ctx, key, data, c.ttl)
    }

    return user, nil
}

func (c *UserCache) DeleteUser(ctx context.Context, userID int64) error {
    return c.rdb.Del(ctx, c.key(userID)).Err()
}
```

## 场景二：分布式锁

```go
package lock

import (
    "context"
    "errors"
    "time"

    "github.com/redis/go-redis/v9"
    "github.com/google/uuid"
)

var ErrLockFailed = errors.New("failed to acquire lock")

type RedisLock struct {
    rdb   *redis.Client
    key   string
    value string
    ttl   time.Duration
}

// TryLock 尝试获取锁，失败立即返回
func TryLock(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) (*RedisLock, error) {
    value := uuid.New().String() // 唯一值，确保只有锁的持有者能解锁

    // SET key value NX EX ttl
    ok, err := rdb.SetNX(ctx, key, value, ttl).Result()
    if err != nil {
        return nil, err
    }
    if !ok {
        return nil, ErrLockFailed
    }

    return &RedisLock{rdb: rdb, key: key, value: value, ttl: ttl}, nil
}

// Unlock 使用 Lua 脚本原子性地解锁（确保只解自己的锁）
func (l *RedisLock) Unlock(ctx context.Context) error {
    script := `
        if redis.call("GET", KEYS[1]) == ARGV[1] then
            return redis.call("DEL", KEYS[1])
        else
            return 0
        end
    `
    _, err := l.rdb.Eval(ctx, script, []string{l.key}, l.value).Result()
    return err
}

// 使用示例
func processOrder(ctx context.Context, rdb *redis.Client, orderID string) error {
    lockKey := fmt.Sprintf("lock:order:%s", orderID)

    lock, err := TryLock(ctx, rdb, lockKey, 30*time.Second)
    if errors.Is(err, ErrLockFailed) {
        return errors.New("order is being processed by another instance")
    }
    if err != nil {
        return err
    }
    defer lock.Unlock(ctx)

    // 处理订单...
    return nil
}
```

## 场景三：排行榜（Sorted Set）

```go
package rank

import (
    "context"
    "strconv"

    "github.com/redis/go-redis/v9"
)

const leaderboardKey = "game:leaderboard"

// AddScore 添加或更新分数
func AddScore(ctx context.Context, rdb *redis.Client, userID string, score float64) error {
    return rdb.ZAdd(ctx, leaderboardKey, redis.Z{
        Score:  score,
        Member: userID,
    }).Err()
}

// IncrScore 增加分数
func IncrScore(ctx context.Context, rdb *redis.Client, userID string, delta float64) (float64, error) {
    return rdb.ZIncrBy(ctx, leaderboardKey, delta, userID).Result()
}

// TopN 获取前 N 名（从高到低）
func TopN(ctx context.Context, rdb *redis.Client, n int) ([]redis.Z, error) {
    return rdb.ZRevRangeWithScores(ctx, leaderboardKey, 0, int64(n-1)).Result()
}

// GetRank 获取用户排名（从 1 开始）
func GetRank(ctx context.Context, rdb *redis.Client, userID string) (int64, error) {
    rank, err := rdb.ZRevRank(ctx, leaderboardKey, userID).Result()
    if err != nil {
        return 0, err
    }
    return rank + 1, nil // ZRevRank 从 0 开始，转为从 1 开始
}
```

## 场景四：限流（令牌桶）

```go
package ratelimit

import (
    "context"
    "time"

    "github.com/redis/go-redis/v9"
)

// 使用 Lua 脚本实现原子性限流
var rateLimitScript = redis.NewScript(`
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])

    local current = redis.call("INCR", key)
    if current == 1 then
        redis.call("EXPIRE", key, window)
    end

    if current > limit then
        return 0
    end
    return 1
`)

// Allow 检查是否允许请求（滑动窗口限流）
func Allow(ctx context.Context, rdb *redis.Client, key string, limit int, window time.Duration) (bool, error) {
    result, err := rateLimitScript.Run(ctx, rdb,
        []string{key},
        limit,
        int(window.Seconds()),
    ).Int()
    if err != nil {
        return true, err // 限流服务异常时放行
    }
    return result == 1, nil
}

// 使用示例：每个 IP 每分钟最多 100 次请求
func RateLimitMiddleware(rdb *redis.Client) gin.HandlerFunc {
    return func(c *gin.Context) {
        key := fmt.Sprintf("ratelimit:%s", c.ClientIP())
        allowed, err := Allow(c.Request.Context(), rdb, key, 100, time.Minute)
        if err != nil {
            c.Next() // 限流服务异常时放行
            return
        }
        if !allowed {
            c.AbortWithStatusJSON(429, gin.H{"error": "too many requests"})
            return
        }
        c.Next()
    }
}
```

## 场景五：消息队列（List）

```go
// 生产者
func Publish(ctx context.Context, rdb *redis.Client, queue string, msg interface{}) error {
    data, err := json.Marshal(msg)
    if err != nil {
        return err
    }
    return rdb.RPush(ctx, queue, data).Err()
}

// 消费者（阻塞等待）
func Subscribe(ctx context.Context, rdb *redis.Client, queue string, handler func([]byte) error) {
    for {
        select {
        case <-ctx.Done():
            return
        default:
        }

        // BLPOP 阻塞等待，超时 5 秒重试
        result, err := rdb.BLPop(ctx, 5*time.Second, queue).Result()
        if err != nil {
            if errors.Is(err, redis.Nil) {
                continue // 超时，继续等待
            }
            log.Printf("BLPOP error: %v", err)
            continue
        }

        if len(result) < 2 {
            continue
        }

        if err := handler([]byte(result[1])); err != nil {
            log.Printf("handler error: %v", err)
        }
    }
}
```

## Pipeline 批量操作

当需要执行多个 Redis 命令时，使用 Pipeline 减少网络往返：

```go
func BatchSet(ctx context.Context, rdb *redis.Client, items map[string]string) error {
    pipe := rdb.Pipeline()

    for k, v := range items {
        pipe.Set(ctx, k, v, time.Hour)
    }

    _, err := pipe.Exec(ctx)
    return err
}
```

## 总结

Redis 在 Go 项目中的核心应用场景：

| 场景 | Redis 数据结构 | 关键命令 |
|------|---------------|----------|
| 缓存 | String | GET/SET/DEL |
| 分布式锁 | String | SET NX + Lua |
| 排行榜 | Sorted Set | ZADD/ZREVRANK |
| 限流 | String + Lua | INCR/EXPIRE |
| 消息队列 | List | RPUSH/BLPOP |
| 去重/标记 | Set | SADD/SISMEMBER |

使用 `go-redis` 时的关键注意点：
1. 合理配置连接池（`PoolSize`、`MinIdleConns`）
2. 设置合适的超时时间（`DialTimeout`、`ReadTimeout`）
3. 原子操作尽量用 Lua 脚本
4. 缓存 key 统一格式，避免 key 碰撞
