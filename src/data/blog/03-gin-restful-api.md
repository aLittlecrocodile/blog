---
title: "使用 Gin 构建 RESTful API"
author: Tu
pubDatetime: 2024-07-09T10:00:00Z
featured: false
draft: false
tags:
  - Go
  - Gin
  - Web
description: "从零开始使用 Gin 框架构建一套完整的 RESTful API，包括路由、中间件、参数绑定和错误处理"
---

Gin 是 Go 生态中最流行的 Web 框架，以高性能和简洁的 API 著称。本文将带你用 Gin 构建一套完整的用户管理 RESTful API。

## 安装与初始化

```bash
mkdir user-api && cd user-api
go mod init user-api
go get github.com/gin-gonic/gin
```

## 项目结构

```
user-api/
├── main.go
├── handlers/
│   └── user.go
├── models/
│   └── user.go
└── middleware/
    └── auth.go
```

## 定义数据模型

```go
// models/user.go
package models

import "time"

type User struct {
    ID        uint      `json:"id"`
    Name      string    `json:"name" binding:"required,min=2,max=50"`
    Email     string    `json:"email" binding:"required,email"`
    Age       int       `json:"age" binding:"required,min=1,max=150"`
    CreatedAt time.Time `json:"created_at"`
}

type CreateUserRequest struct {
    Name  string `json:"name" binding:"required,min=2,max=50"`
    Email string `json:"email" binding:"required,email"`
    Age   int    `json:"age" binding:"required,min=1,max=150"`
}

type UpdateUserRequest struct {
    Name  string `json:"name" binding:"omitempty,min=2,max=50"`
    Email string `json:"email" binding:"omitempty,email"`
    Age   int    `json:"age" binding:"omitempty,min=1,max=150"`
}
```

## 实现 Handler

```go
// handlers/user.go
package handlers

import (
    "net/http"
    "strconv"
    "sync"
    "time"
    "user-api/models"

    "github.com/gin-gonic/gin"
)

// 简单的内存存储
var (
    users  = make(map[uint]*models.User)
    nextID uint = 1
    mu     sync.RWMutex
)

func GetUsers(c *gin.Context) {
    mu.RLock()
    defer mu.RUnlock()

    list := make([]*models.User, 0, len(users))
    for _, u := range users {
        list = append(list, u)
    }
    c.JSON(http.StatusOK, gin.H{
        "data":  list,
        "total": len(list),
    })
}

func GetUser(c *gin.Context) {
    id, err := strconv.ParseUint(c.Param("id"), 10, 64)
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
        return
    }

    mu.RLock()
    user, ok := users[uint(id)]
    mu.RUnlock()

    if !ok {
        c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
        return
    }
    c.JSON(http.StatusOK, user)
}

func CreateUser(c *gin.Context) {
    var req models.CreateUserRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    mu.Lock()
    user := &models.User{
        ID:        nextID,
        Name:      req.Name,
        Email:     req.Email,
        Age:       req.Age,
        CreatedAt: time.Now(),
    }
    users[nextID] = user
    nextID++
    mu.Unlock()

    c.JSON(http.StatusCreated, user)
}

func UpdateUser(c *gin.Context) {
    id, err := strconv.ParseUint(c.Param("id"), 10, 64)
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
        return
    }

    var req models.UpdateUserRequest
    if err := c.ShouldBindJSON(&req); err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
        return
    }

    mu.Lock()
    defer mu.Unlock()

    user, ok := users[uint(id)]
    if !ok {
        c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
        return
    }

    if req.Name != "" {
        user.Name = req.Name
    }
    if req.Email != "" {
        user.Email = req.Email
    }
    if req.Age != 0 {
        user.Age = req.Age
    }

    c.JSON(http.StatusOK, user)
}

func DeleteUser(c *gin.Context) {
    id, err := strconv.ParseUint(c.Param("id"), 10, 64)
    if err != nil {
        c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
        return
    }

    mu.Lock()
    defer mu.Unlock()

    if _, ok := users[uint(id)]; !ok {
        c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
        return
    }

    delete(users, uint(id))
    c.Status(http.StatusNoContent)
}
```

## 中间件

```go
// middleware/auth.go
package middleware

import (
    "net/http"
    "strings"

    "github.com/gin-gonic/gin"
)

func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        authHeader := c.GetHeader("Authorization")
        if authHeader == "" {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
                "error": "authorization header required",
            })
            return
        }

        parts := strings.SplitN(authHeader, " ", 2)
        if len(parts) != 2 || parts[0] != "Bearer" {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
                "error": "invalid authorization format",
            })
            return
        }

        token := parts[1]
        // 实际项目中这里应该验证 JWT token
        if token != "valid-token" {
            c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
                "error": "invalid token",
            })
            return
        }

        // 可以将用户信息存到 context 中
        c.Set("user_id", 1)
        c.Next()
    }
}

// 日志中间件
func Logger() gin.HandlerFunc {
    return gin.LoggerWithFormatter(func(param gin.LogFormatterParams) string {
        return fmt.Sprintf("[%s] %s %s %d %s\n",
            param.TimeStamp.Format("2006-01-02 15:04:05"),
            param.Method,
            param.Path,
            param.StatusCode,
            param.Latency,
        )
    })
}
```

## 主程序与路由

```go
// main.go
package main

import (
    "user-api/handlers"
    "user-api/middleware"

    "github.com/gin-gonic/gin"
)

func main() {
    r := gin.New()
    r.Use(gin.Recovery()) // 自动恢复 panic
    r.Use(middleware.Logger())

    // 公开路由
    r.GET("/health", func(c *gin.Context) {
        c.JSON(200, gin.H{"status": "ok"})
    })

    // 需要认证的路由组
    api := r.Group("/api/v1")
    api.Use(middleware.AuthMiddleware())
    {
        users := api.Group("/users")
        users.GET("", handlers.GetUsers)
        users.GET("/:id", handlers.GetUser)
        users.POST("", handlers.CreateUser)
        users.PUT("/:id", handlers.UpdateUser)
        users.DELETE("/:id", handlers.DeleteUser)
    }

    r.Run(":8080")
}
```

## 测试接口

```bash
# 创建用户
curl -X POST http://localhost:8080/api/v1/users \
  -H "Authorization: Bearer valid-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice","email":"alice@example.com","age":28}'

# 获取用户列表
curl http://localhost:8080/api/v1/users \
  -H "Authorization: Bearer valid-token"

# 更新用户
curl -X PUT http://localhost:8080/api/v1/users/1 \
  -H "Authorization: Bearer valid-token" \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice Smith"}'
```

## 参数绑定总结

Gin 提供了多种参数绑定方式：

| 方法 | 用途 |
|------|------|
| `c.Param("id")` | URL 路径参数 |
| `c.Query("page")` | URL 查询参数 |
| `c.ShouldBindJSON(&req)` | JSON body，失败不终止 |
| `c.MustBindJSON(&req)` | JSON body，失败返回 400 |
| `c.ShouldBind(&req)` | 根据 Content-Type 自动选择 |

## 总结

Gin 框架让构建 RESTful API 变得非常高效：
- `binding` 标签实现参数验证，减少样板代码
- 路由分组（Group）使代码结构清晰
- 中间件机制灵活处理横切关注点
- `ShouldBind` vs `MustBind` 提供错误处理的灵活性

下一步可以集成 GORM 操作数据库，或添加 Swagger 文档生成。
