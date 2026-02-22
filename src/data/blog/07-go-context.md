---
title: "深入理解 Go context 包"
author: Tu
pubDatetime: 2024-08-29T10:00:00Z
featured: false
draft: false
tags:
  - Go
description: "全面解析 Go context 包的设计原理、四种 context 类型及其在实际项目中的正确使用方式"
---

`context` 包是 Go 并发编程中不可或缺的工具，用于在多个 goroutine 之间传递截止时间、取消信号和请求范围的值。正确使用 context 是写出健壮 Go 代码的关键。

## 为什么需要 context

想象一个 HTTP 请求的处理链路：

```
HTTP Handler → 业务层 → 数据库查询
                      → 调用外部 API
                      → Redis 缓存
```

如果客户端断开连接，所有正在进行的操作都应该立即取消，否则就是资源浪费。`context` 就是用来传播这个取消信号的。

## Context 接口

```go
type Context interface {
    // 返回 context 的截止时间
    Deadline() (deadline time.Time, ok bool)

    // 返回一个 channel，当 context 被取消时关闭
    Done() <-chan struct{}

    // context 被取消的原因（context.Canceled 或 context.DeadlineExceeded）
    Err() error

    // 从 context 中获取值
    Value(key any) any
}
```

## 四种 Context 类型

### 1. Background 和 TODO

```go
// Background 是所有 context 的根
ctx := context.Background()

// TODO 表示"还不确定用哪种 context"，是占位符
ctx := context.TODO()
```

### 2. WithCancel：手动取消

```go
func doWork(ctx context.Context) {
    for {
        select {
        case <-ctx.Done():
            fmt.Println("work cancelled:", ctx.Err())
            return
        default:
            fmt.Println("working...")
            time.Sleep(100 * time.Millisecond)
        }
    }
}

func main() {
    ctx, cancel := context.WithCancel(context.Background())

    go doWork(ctx)

    time.Sleep(500 * time.Millisecond)
    cancel() // 取消所有使用此 context 的操作
    time.Sleep(100 * time.Millisecond)
}
```

### 3. WithTimeout 和 WithDeadline：超时控制

```go
func fetchData(url string) ([]byte, error) {
    // 3 秒超时
    ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
    defer cancel() // 即使没有超时也要调用 cancel，释放资源

    req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
    if err != nil {
        return nil, err
    }

    resp, err := http.DefaultClient.Do(req)
    if err != nil {
        if errors.Is(err, context.DeadlineExceeded) {
            return nil, fmt.Errorf("request timed out: %w", err)
        }
        return nil, err
    }
    defer resp.Body.Close()

    return io.ReadAll(resp.Body)
}
```

### 4. WithValue：传递请求范围的值

```go
// 使用类型安全的 key 避免碰撞
type contextKey string

const (
    keyUserID    contextKey = "user_id"
    keyRequestID contextKey = "request_id"
)

func WithUserID(ctx context.Context, userID int64) context.Context {
    return context.WithValue(ctx, keyUserID, userID)
}

func GetUserID(ctx context.Context) (int64, bool) {
    userID, ok := ctx.Value(keyUserID).(int64)
    return userID, ok
}

// 在中间件中注入
func AuthMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        userID := validateToken(r.Header.Get("Authorization"))
        ctx := WithUserID(r.Context(), userID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// 在业务层读取
func (s *UserService) GetProfile(ctx context.Context) (*Profile, error) {
    userID, ok := GetUserID(ctx)
    if !ok {
        return nil, errors.New("user id not in context")
    }
    return s.repo.GetProfile(ctx, userID)
}
```

## 实战：数据库查询超时

```go
package repository

import (
    "context"
    "database/sql"
    "time"
)

type UserRepo struct {
    db *sql.DB
}

func (r *UserRepo) FindByID(ctx context.Context, id int64) (*User, error) {
    // 为数据库查询设置 2 秒超时（如果 ctx 没有更早的 deadline）
    queryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
    defer cancel()

    var user User
    err := r.db.QueryRowContext(queryCtx,
        "SELECT id, name, email FROM users WHERE id = ?", id,
    ).Scan(&user.ID, &user.Name, &user.Email)

    if err == sql.ErrNoRows {
        return nil, ErrNotFound
    }
    return &user, err
}
```

## context 的传播

context 应该在调用链中透传：

```go
// HTTP handler
func (h *Handler) GetUser(w http.ResponseWriter, r *http.Request) {
    // r.Context() 包含了客户端断开时的取消信号
    user, err := h.svc.GetUser(r.Context(), userID)
    // ...
}

// Service 层：继续传递 ctx
func (s *UserService) GetUser(ctx context.Context, id int64) (*User, error) {
    // 使用同一个 ctx，这样如果客户端断开，数据库查询也会取消
    user, err := s.repo.FindByID(ctx, id)
    if err != nil {
        return nil, err
    }

    // 调用外部 API 也传递 ctx
    extra, err := s.apiClient.FetchExtra(ctx, user.ID)
    // ...
}
```

## 取消信号的扇出

一个 context 取消，可以同时取消多个并行操作：

```go
func fetchAll(ctx context.Context, ids []int64) ([]*User, error) {
    // 创建可取消的子 context
    ctx, cancel := context.WithCancel(ctx)
    defer cancel()

    results := make([]*User, len(ids))
    errc := make(chan error, len(ids))

    for i, id := range ids {
        i, id := i, id // 捕获循环变量
        go func() {
            user, err := fetchUser(ctx, id)
            if err != nil {
                errc <- err
                cancel() // 任一失败，取消所有
                return
            }
            results[i] = user
            errc <- nil
        }()
    }

    for range ids {
        if err := <-errc; err != nil {
            return nil, err
        }
    }

    return results, nil
}
```

## 常见错误

**1. 不传 context**
```go
// 错误：硬编码 context，无法被外部取消
func badFetch() {
    ctx := context.Background() // 不应该在这里创建，应该从调用方传入
    http.NewRequestWithContext(ctx, "GET", url, nil)
}
```

**2. context 存储在结构体中**
```go
// 错误：context 是请求范围的，不应该存在结构体中
type Bad struct {
    ctx context.Context // 不要这样做
}

// 正确：context 作为函数参数传递
func (s *Good) DoSomething(ctx context.Context) error { ... }
```

**3. 忘记调用 cancel**
```go
// 错误：内存泄漏，子 context 的资源没有释放
ctx, cancel := context.WithTimeout(parent, time.Second)
// 没有 defer cancel()

// 正确
ctx, cancel := context.WithTimeout(parent, time.Second)
defer cancel()
```

## 总结

context 包的核心价值：
1. **取消传播**：客户端断开或超时，整个调用链自动取消
2. **超时控制**：`WithTimeout`/`WithDeadline` 保护系统免受慢请求影响
3. **请求范围数据**：`WithValue` 传递 requestID、userID 等元信息

使用规范：
- context 始终作为函数第一个参数（命名为 `ctx`）
- 永远不要存储 context 到结构体中
- `WithCancel`/`WithTimeout` 后必须 `defer cancel()`
- `WithValue` 的 key 使用私有类型，避免碰撞
