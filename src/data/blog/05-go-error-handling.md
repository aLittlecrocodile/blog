---
title: "Go 错误处理进化史：从 error 到 errors.Is/As"
author: Tu
pubDatetime: 2024-07-31T10:00:00Z
featured: false
draft: false
tags:
  - Go
description: "系统梳理 Go 错误处理的演进过程，掌握 errors.Is、errors.As、%w 包装的正确用法"
---

Go 的错误处理一直是社区讨论的热点话题。从最简单的 `error` 接口，到 Go 1.13 引入的错误链，再到现代的结构化错误处理，本文系统梳理 Go 错误处理的最佳实践。

## 基础：error 接口

```go
// error 接口定义
type error interface {
    Error() string
}
```

最简单的错误返回：

```go
import "errors"

func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, errors.New("division by zero")
    }
    return a / b, nil
}

func main() {
    result, err := divide(10, 0)
    if err != nil {
        fmt.Println("Error:", err)
        return
    }
    fmt.Println(result)
}
```

## 哨兵错误（Sentinel Errors）

预定义的特定错误值，用于判断特定错误类型：

```go
package db

import "errors"

// 哨兵错误：包级别的错误变量
var (
    ErrNotFound    = errors.New("record not found")
    ErrDuplicate   = errors.New("duplicate record")
    ErrInvalidInput = errors.New("invalid input")
)

func FindUser(id int) (*User, error) {
    if id <= 0 {
        return nil, ErrInvalidInput
    }
    // 查询数据库...
    return nil, ErrNotFound // 假设没找到
}
```

调用方可以直接比较：

```go
user, err := db.FindUser(1)
if err == db.ErrNotFound {
    // 处理未找到的情况
}
```

**问题**：`==` 比较无法处理错误被包装的情况。

## Go 1.13：错误包装与 errors.Is/As

Go 1.13 引入了 `%w` 格式化动词和 `errors.Is`/`errors.As` 函数：

```go
// 使用 %w 包装错误（保留原始错误）
func GetUser(id int) (*User, error) {
    user, err := db.FindUser(id)
    if err != nil {
        // %w 包装错误，调用方可以通过 errors.Is 检测原始错误
        return nil, fmt.Errorf("GetUser id=%d: %w", id, err)
    }
    return user, nil
}
```

### errors.Is：检测错误链中是否有目标错误

```go
err := GetUser(1)
// errors.Is 会递归检查错误链
if errors.Is(err, db.ErrNotFound) {
    fmt.Println("user not found")
    // 可以安全地处理
}
```

`errors.Is` 的实现原理：
1. 直接比较 `err == target`
2. 如果 err 实现了 `Is(error) bool` 方法，调用它
3. 如果 err 实现了 `Unwrap() error`，递归检查 Unwrap() 的结果

### errors.As：提取错误链中的特定类型

```go
// 自定义错误类型
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("validation failed on field %s: %s", e.Field, e.Message)
}

func validateAge(age int) error {
    if age < 0 || age > 150 {
        return &ValidationError{
            Field:   "age",
            Message: "must be between 0 and 150",
        }
    }
    return nil
}

func processUser(age int) error {
    if err := validateAge(age); err != nil {
        return fmt.Errorf("processUser: %w", err)
    }
    return nil
}

func main() {
    err := processUser(-1)

    var valErr *ValidationError
    if errors.As(err, &valErr) {
        // 提取到具体的 ValidationError
        fmt.Printf("Field: %s, Message: %s\n", valErr.Field, valErr.Message)
    }
}
```

## 自定义错误类型的最佳实践

```go
// 带有错误码的业务错误
type AppError struct {
    Code    int
    Message string
    Err     error // 原始错误
}

func (e *AppError) Error() string {
    if e.Err != nil {
        return fmt.Sprintf("[%d] %s: %v", e.Code, e.Message, e.Err)
    }
    return fmt.Sprintf("[%d] %s", e.Code, e.Message)
}

// 实现 Unwrap 让 errors.Is/As 能递归检查
func (e *AppError) Unwrap() error {
    return e.Err
}

// 错误码常量
const (
    ErrCodeNotFound   = 404
    ErrCodeBadRequest = 400
    ErrCodeInternal   = 500
)

func NewNotFoundError(msg string, err error) *AppError {
    return &AppError{Code: ErrCodeNotFound, Message: msg, Err: err}
}
```

## 实际项目中的错误处理模式

### 在 HTTP handler 中处理错误

```go
func (h *UserHandler) GetUser(c *gin.Context) {
    id, _ := strconv.Atoi(c.Param("id"))

    user, err := h.svc.GetUser(id)
    if err != nil {
        var appErr *AppError
        if errors.As(err, &appErr) {
            c.JSON(appErr.Code, gin.H{"error": appErr.Message})
            return
        }
        // 未知错误
        c.JSON(500, gin.H{"error": "internal server error"})
        return
    }

    c.JSON(200, user)
}
```

### 错误日志与上下文信息

```go
func (s *UserService) GetUser(ctx context.Context, id int) (*User, error) {
    const op = "UserService.GetUser"

    user, err := s.repo.Find(ctx, id)
    if err != nil {
        if errors.Is(err, ErrNotFound) {
            return nil, fmt.Errorf("%s: %w", op, err)
        }
        // 非预期错误，记录详细日志
        s.logger.Error("database query failed",
            "op", op,
            "id", id,
            "error", err,
        )
        return nil, fmt.Errorf("%s: %w", op, ErrInternal)
    }

    return user, nil
}
```

## 不要忽视 error

```go
// 错误：忽略返回的 error
os.Remove("temp.txt") // 如果删除失败，你不会知道

// 正确：处理所有 error
if err := os.Remove("temp.txt"); err != nil {
    log.Printf("failed to remove temp file: %v", err)
}
```

使用 `errcheck` 工具可以检测未处理的 error：

```bash
go install github.com/kisielk/errcheck@latest
errcheck ./...
```

## 总结

Go 错误处理的演进清晰体现了其设计哲学：

| 时期 | 方式 | 问题 |
|------|------|------|
| 早期 | `errors.New` + `==` | 无法处理包装错误 |
| Go 1.13 | `%w` + `errors.Is/As` | 支持错误链 |
| 现代 | 结构化错误类型 | 携带更多上下文信息 |

核心原则：
1. **不要吞掉错误**：要么处理，要么往上传递
2. **包装时添加上下文**：`fmt.Errorf("op: %w", err)`
3. **使用 errors.Is/As**：而不是类型断言或字符串比较
4. **区分预期错误和非预期错误**：前者返回给调用方，后者记录日志
