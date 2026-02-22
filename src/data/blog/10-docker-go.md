---
title: "Docker 容器化 Go 应用实践"
author: Tu
pubDatetime: 2024-09-27T10:00:00Z
featured: false
draft: false
tags:
  - Go
  - Docker
description: "使用多阶段构建打造极小的 Go Docker 镜像，并配合 Docker Compose 搭建完整的开发环境"
---

Docker 容器化让应用部署更加一致和可靠。本文介绍如何为 Go 应用编写高质量的 Dockerfile，并使用 Docker Compose 搭建包含数据库和缓存的完整开发环境。

## 基础 Dockerfile

最简单的 Go 应用 Dockerfile：

```dockerfile
FROM golang:1.22-alpine

WORKDIR /app
COPY . .
RUN go build -o server .

EXPOSE 8080
CMD ["./server"]
```

问题：镜像体积大（golang:alpine 约 300MB），包含了编译工具链。

## 多阶段构建

利用多阶段构建，最终镜像只包含二进制文件：

```dockerfile
# 构建阶段
FROM golang:1.22-alpine AS builder

# 安装必要的系统依赖
RUN apk add --no-cache git ca-certificates

WORKDIR /app

# 先复制依赖文件，利用 Docker 层缓存
COPY go.mod go.sum ./
RUN go mod download

# 复制源码并构建
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-w -s" -o server ./cmd/server

# 运行阶段
FROM scratch

# 从构建阶段复制必要文件
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/
COPY --from=builder /app/server /server

EXPOSE 8080
ENTRYPOINT ["/server"]
```

构建说明：
- `CGO_ENABLED=0`：禁用 CGO，生成静态二进制文件
- `-ldflags="-w -s"`：去除调试信息，减小体积
- `FROM scratch`：空镜像，最小体积（通常 < 20MB）

## 使用 distroless 基础镜像

如果需要一些基础工具（如 shell），使用 distroless：

```dockerfile
FROM gcr.io/distroless/static-debian11

COPY --from=builder /app/server /server
EXPOSE 8080
ENTRYPOINT ["/server"]
```

## 处理配置文件

```dockerfile
FROM golang:1.22-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o server .

FROM alpine:3.19
RUN apk --no-cache add ca-certificates tzdata

WORKDIR /app
COPY --from=builder /app/server .
# 复制配置文件模板（实际配置通过环境变量或挂载提供）
COPY config/config.yaml.example ./config/

# 非 root 用户运行，增加安全性
RUN adduser -D -s /bin/sh appuser
USER appuser

EXPOSE 8080
CMD ["./server"]
```

## .dockerignore 文件

```
# .dockerignore
.git
.gitignore
README.md
*.md
Dockerfile
docker-compose.yml
.env
vendor/    # 如果使用 go mod，不需要 vendor 目录
*_test.go
```

## Docker Compose：完整开发环境

```yaml
# docker-compose.yml
version: "3.9"

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    ports:
      - "8080:8080"
    environment:
      - DB_HOST=mysql
      - DB_PORT=3306
      - DB_USER=root
      - DB_PASSWORD=secret
      - DB_NAME=myapp
      - REDIS_ADDR=redis:6379
    depends_on:
      mysql:
        condition: service_healthy
      redis:
        condition: service_started
    networks:
      - backend

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: secret
      MYSQL_DATABASE: myapp
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
      - ./scripts/init.sql:/docker-entrypoint-initdb.d/init.sql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5
    networks:
      - backend

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    networks:
      - backend

volumes:
  mysql_data:
  redis_data:

networks:
  backend:
    driver: bridge
```

## 开发模式：热重载

```yaml
# docker-compose.dev.yml
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.dev
    volumes:
      - .:/app  # 挂载源码目录
    command: air  # 使用 air 实现热重载
```

```dockerfile
# Dockerfile.dev
FROM golang:1.22-alpine

RUN go install github.com/air-verse/air@latest

WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download

EXPOSE 8080
CMD ["air"]
```

```bash
# 启动开发环境
docker-compose -f docker-compose.yml -f docker-compose.dev.yml up
```

## 生产环境最佳实践

### 健康检查

```go
// 在应用中实现健康检查端点
func healthHandler(w http.ResponseWriter, r *http.Request) {
    // 检查数据库连接
    if err := db.PingContext(r.Context()); err != nil {
        w.WriteHeader(http.StatusServiceUnavailable)
        json.NewEncoder(w).Encode(map[string]string{
            "status": "unhealthy",
            "error":  err.Error(),
        })
        return
    }

    w.WriteHeader(http.StatusOK)
    json.NewEncoder(w).Encode(map[string]string{"status": "healthy"})
}
```

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -qO- http://localhost:8080/health || exit 1
```

### 优雅关闭

```go
func main() {
    server := &http.Server{Addr: ":8080", Handler: router}

    go func() {
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            log.Fatal(err)
        }
    }()

    // 等待退出信号
    quit := make(chan os.Signal, 1)
    signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
    <-quit

    // 30 秒内完成正在处理的请求
    ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
    defer cancel()

    if err := server.Shutdown(ctx); err != nil {
        log.Fatal("Server forced to shutdown:", err)
    }
    log.Println("Server exiting")
}
```

## 常用命令

```bash
# 构建镜像
docker build -t myapp:latest .

# 查看镜像大小
docker images myapp

# 运行容器
docker run -d -p 8080:8080 --name myapp myapp:latest

# 查看日志
docker logs -f myapp

# 进入容器（debug 用）
docker exec -it myapp sh

# Docker Compose 操作
docker-compose up -d          # 后台启动
docker-compose down -v        # 停止并删除数据卷
docker-compose logs -f app    # 查看 app 服务日志
```

## 总结

Go 应用容器化最佳实践：
1. **多阶段构建**：构建阶段用 golang 镜像，运行阶段用 scratch/distroless，减小体积
2. **静态编译**：`CGO_ENABLED=0`，避免动态库依赖
3. **层缓存优化**：先 COPY go.mod/go.sum，再 COPY 源码
4. **非 root 用户**：提高安全性
5. **健康检查**：让编排系统知道容器是否正常运行
6. **优雅关闭**：处理 SIGTERM，避免请求丢失
