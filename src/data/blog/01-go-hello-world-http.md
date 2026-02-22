---
title: "Go 语言入门：从 Hello World 到 HTTP 服务器"
author: Tu
pubDatetime: 2024-06-12T10:00:00Z
featured: false
draft: false
tags:
  - Go
  - 入门
description: "从零开始学习 Go 语言，掌握基础语法，并实现一个完整的 HTTP 服务器"
---

Go 语言自 2009 年发布以来，凭借其简洁的语法、强大的并发支持和优秀的性能，逐渐成为后端开发的主流语言之一。本文将带你从最基础的 Hello World 程序开始，一步步实现一个完整的 HTTP 服务器。

## Hello World

```go
package main

import "fmt"

func main() {
    fmt.Println("Hello, World!")
}
```

运行：
```bash
go run main.go
# 输出：Hello, World!
```

这短短几行代码包含了 Go 程序的基本结构：
- `package main` 声明这是一个可执行程序的入口包
- `import "fmt"` 导入标准库中的格式化 I/O 包
- `func main()` 是程序的入口函数

## 基础数据类型

```go
package main

import "fmt"

func main() {
    // 基础类型
    var name string = "Gopher"
    var age int = 5
    var score float64 = 98.5
    var isActive bool = true

    // 短变量声明（更常用）
    language := "Go"
    version := 1.22

    fmt.Printf("Name: %s, Age: %d\n", name, age)
    fmt.Printf("Score: %.2f, Active: %v\n", score, isActive)
    fmt.Printf("Language: %s %.2f\n", language, version)
}
```

## 函数与多返回值

Go 支持多返回值，这在错误处理上非常有用：

```go
package main

import (
    "errors"
    "fmt"
)

// 除法函数，返回结果和可能的错误
func divide(a, b float64) (float64, error) {
    if b == 0 {
        return 0, errors.New("除数不能为零")
    }
    return a / b, nil
}

func main() {
    result, err := divide(10, 3)
    if err != nil {
        fmt.Println("Error:", err)
        return
    }
    fmt.Printf("10 / 3 = %.4f\n", result)

    _, err = divide(5, 0)
    if err != nil {
        fmt.Println("Error:", err) // Error: 除数不能为零
    }
}
```

## 结构体与方法

```go
package main

import "fmt"

type User struct {
    ID    int
    Name  string
    Email string
}

// 值接收者方法
func (u User) String() string {
    return fmt.Sprintf("User{ID: %d, Name: %s}", u.ID, u.Name)
}

// 指针接收者方法（可修改结构体）
func (u *User) UpdateEmail(email string) {
    u.Email = email
}

func main() {
    user := User{ID: 1, Name: "Alice", Email: "alice@example.com"}
    fmt.Println(user.String())

    user.UpdateEmail("alice@newdomain.com")
    fmt.Println("Updated email:", user.Email)
}
```

## 实现 HTTP 服务器

使用 Go 标准库 `net/http` 可以非常简单地实现一个 HTTP 服务器：

```go
package main

import (
    "encoding/json"
    "fmt"
    "log"
    "net/http"
    "time"
)

type Response struct {
    Message   string    `json:"message"`
    Timestamp time.Time `json:"timestamp"`
}

// 处理根路径请求
func homeHandler(w http.ResponseWriter, r *http.Request) {
    fmt.Fprintf(w, "Welcome to Go HTTP Server!")
}

// 返回 JSON 响应
func apiHandler(w http.ResponseWriter, r *http.Request) {
    w.Header().Set("Content-Type", "application/json")

    resp := Response{
        Message:   "Hello from Go API",
        Timestamp: time.Now(),
    }

    if err := json.NewEncoder(w).Encode(resp); err != nil {
        http.Error(w, "Internal Server Error", http.StatusInternalServerError)
        return
    }
}

// 日志中间件
func loggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
    })
}

func main() {
    mux := http.NewServeMux()
    mux.HandleFunc("/", homeHandler)
    mux.HandleFunc("/api/hello", apiHandler)

    // 应用中间件
    handler := loggingMiddleware(mux)

    server := &http.Server{
        Addr:         ":8080",
        Handler:      handler,
        ReadTimeout:  15 * time.Second,
        WriteTimeout: 15 * time.Second,
    }

    log.Println("Server starting on :8080")
    if err := server.ListenAndServe(); err != nil {
        log.Fatal(err)
    }
}
```

运行后访问：
- `http://localhost:8080/` → 欢迎页面
- `http://localhost:8080/api/hello` → JSON 响应

## 总结

通过本文，我们完成了：
1. Go 程序的基本结构和语法
2. 变量声明、函数定义、多返回值
3. 结构体和方法的使用
4. 使用标准库构建 HTTP 服务器

Go 的标准库非常强大，`net/http` 包提供了构建 Web 服务所需的一切基础设施。对于生产环境，通常会选择 Gin 或 Echo 这样的框架来简化路由管理和中间件处理，这些我们会在后续文章中详细介绍。
