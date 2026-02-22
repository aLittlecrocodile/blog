---
title: "Go sync 包详解：Mutex、RWMutex 与 WaitGroup"
author: Tu
pubDatetime: 2024-09-18T10:00:00Z
featured: false
draft: false
tags:
  - Go
  - 并发
description: "深入理解 Go sync 包的核心原语：互斥锁、读写锁、等待组的原理与最佳实践"
---

当多个 goroutine 需要访问共享数据时，必须使用同步原语保证数据安全。Go 的 `sync` 包提供了多种同步工具，本文重点讲解 `Mutex`、`RWMutex`、`WaitGroup` 以及 `sync.Once`。

## Mutex：互斥锁

```go
package main

import (
    "fmt"
    "sync"
)

type SafeCounter struct {
    mu    sync.Mutex
    count int
}

func (c *SafeCounter) Inc() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.count++
}

func (c *SafeCounter) Value() int {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}

func main() {
    counter := &SafeCounter{}
    var wg sync.WaitGroup

    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            counter.Inc()
        }()
    }

    wg.Wait()
    fmt.Println("Final count:", counter.Value()) // 1000
}
```

**注意**：`sync.Mutex` 是不可重入的，同一个 goroutine 重复加锁会死锁：

```go
func (c *SafeCounter) bad() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.Inc() // deadlock! Inc() 也会加锁
}
```

## RWMutex：读写锁

读多写少的场景用 `RWMutex` 性能更好：

```go
type Cache struct {
    mu   sync.RWMutex
    data map[string]string
}

func NewCache() *Cache {
    return &Cache{data: make(map[string]string)}
}

// 写操作：排他锁
func (c *Cache) Set(key, value string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.data[key] = value
}

// 读操作：共享锁，多个 goroutine 可以同时读
func (c *Cache) Get(key string) (string, bool) {
    c.mu.RLock()
    defer c.mu.RUnlock()
    val, ok := c.data[key]
    return val, ok
}

func (c *Cache) Delete(key string) {
    c.mu.Lock()
    defer c.mu.Unlock()
    delete(c.data, key)
}
```

RWMutex 的规则：
- 可以多个 goroutine 同时持有读锁
- 写锁期间，所有读锁和其他写锁都被阻塞
- 读锁期间，写锁被阻塞

## WaitGroup：等待多个 goroutine 完成

```go
func processItems(items []string) []string {
    var (
        wg      sync.WaitGroup
        mu      sync.Mutex
        results []string
    )

    for _, item := range items {
        wg.Add(1)
        go func(s string) {
            defer wg.Done()

            result := process(s) // 耗时处理

            mu.Lock()
            results = append(results, result)
            mu.Unlock()
        }(item)
    }

    wg.Wait()
    return results
}
```

**常见错误**：`wg.Add()` 必须在 goroutine 启动前调用：

```go
// 错误：可能在 Wait() 之前没有 Add
for _, item := range items {
    go func(s string) {
        wg.Add(1)    // 错误！可能在 Wait() 之后才调用
        defer wg.Done()
        process(s)
    }(item)
}

// 正确
for _, item := range items {
    wg.Add(1)        // 在 goroutine 启动前调用
    go func(s string) {
        defer wg.Done()
        process(s)
    }(item)
}
```

## sync.Once：只执行一次

常用于单例模式或延迟初始化：

```go
type DB struct {
    conn *sql.DB
}

var (
    dbInstance *DB
    once       sync.Once
)

func GetDB() *DB {
    once.Do(func() {
        conn, err := sql.Open("mysql", dsn)
        if err != nil {
            panic(err)
        }
        dbInstance = &DB{conn: conn}
    })
    return dbInstance
}
```

`sync.Once` 保证 `Do` 中的函数只执行一次，即使多个 goroutine 同时调用。

## sync.Map：并发安全的 Map

适用于**读多写少**，或 **key 集合相对固定**的场景：

```go
var m sync.Map

// 存储
m.Store("key", "value")

// 读取
val, ok := m.Load("key")

// 存在则读取，不存在则存储（原子操作）
actual, loaded := m.LoadOrStore("key", "new_value")

// 删除
m.Delete("key")

// 遍历
m.Range(func(key, value interface{}) bool {
    fmt.Printf("%v: %v\n", key, value)
    return true // 返回 false 停止遍历
})
```

**注意**：`sync.Map` 不适合所有场景，对于写多读少的场景，带 `sync.RWMutex` 的普通 map 性能更好。

## sync.Pool：对象池

减少 GC 压力，复用临时对象：

```go
var bufPool = sync.Pool{
    New: func() interface{} {
        return new(bytes.Buffer)
    },
}

func processRequest(data []byte) string {
    buf := bufPool.Get().(*bytes.Buffer)
    defer func() {
        buf.Reset()
        bufPool.Put(buf)
    }()

    buf.Write(data)
    // 处理数据...
    return buf.String()
}
```

`sync.Pool` 适合：
- 频繁分配、释放的临时对象
- 对象创建代价高，但使用时间短

不适合：持久化的对象（Pool 中的对象可能随时被 GC 回收）。

## atomic 包：原子操作

对于简单的数值操作，`atomic` 比 `Mutex` 性能更好：

```go
import "sync/atomic"

type AtomicCounter struct {
    count int64
}

func (c *AtomicCounter) Inc() {
    atomic.AddInt64(&c.count, 1)
}

func (c *AtomicCounter) Value() int64 {
    return atomic.LoadInt64(&c.count)
}

// CAS（Compare And Swap）：乐观锁的基础
func (c *AtomicCounter) CompareAndSwap(old, new int64) bool {
    return atomic.CompareAndSwapInt64(&c.count, old, new)
}
```

## 死锁避免

```go
// 常见死锁场景：加锁顺序不一致
var mu1, mu2 sync.Mutex

// goroutine 1
mu1.Lock()
mu2.Lock() // 如果 goroutine2 已持有 mu2 并等待 mu1，死锁！

// goroutine 2
mu2.Lock()
mu1.Lock()

// 解决：保证加锁顺序一致
// 始终先加 mu1，再加 mu2
```

使用 `go build -race` 检测数据竞争：

```bash
go build -race ./...
go test -race ./...
```

## 总结

| 工具 | 适用场景 |
|------|----------|
| `sync.Mutex` | 保护共享数据，读写都需要锁 |
| `sync.RWMutex` | 读多写少的共享数据 |
| `sync.WaitGroup` | 等待多个 goroutine 完成 |
| `sync.Once` | 只执行一次的初始化 |
| `sync.Map` | 并发安全的 map，key 相对稳定 |
| `sync.Pool` | 复用临时对象，减少 GC |
| `atomic` | 单个数值的原子操作 |

核心原则：**能用 channel 通信的，优先用 channel；必须共享内存时，用最细粒度的锁**。
