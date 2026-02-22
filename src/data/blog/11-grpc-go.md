---
title: "gRPC 在 Go 微服务中的实战"
author: Tu
pubDatetime: 2024-10-11T10:00:00Z
featured: true
draft: false
tags:
  - Go
  - gRPC
  - 微服务
description: "从 Protocol Buffers 定义到 Go gRPC 服务实现，掌握微服务间高性能通信"
---

gRPC 是 Google 开源的高性能 RPC 框架，基于 HTTP/2 和 Protocol Buffers，是微服务间通信的首选方案。本文从 proto 文件编写到 Go 服务实现，带你完整体验 gRPC 开发。

## 安装依赖

```bash
# 安装 protoc 编译器
brew install protobuf

# 安装 Go 插件
go install google.golang.org/protobuf/cmd/protoc-gen-go@latest
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
```

## 定义 Proto 文件

```protobuf
// proto/user/user.proto
syntax = "proto3";

package user;
option go_package = "github.com/yourname/myapp/proto/user";

// 用户信息
message User {
    int64 id = 1;
    string name = 2;
    string email = 3;
    int32 age = 4;
}

// 请求/响应消息
message GetUserRequest {
    int64 id = 1;
}

message CreateUserRequest {
    string name = 1;
    string email = 2;
    int32 age = 3;
}

message ListUsersRequest {
    int32 page = 1;
    int32 page_size = 2;
}

message ListUsersResponse {
    repeated User users = 1;
    int32 total = 2;
}

// 服务定义
service UserService {
    rpc GetUser(GetUserRequest) returns (User);
    rpc CreateUser(CreateUserRequest) returns (User);
    rpc ListUsers(ListUsersRequest) returns (ListUsersResponse);
    // 服务端流式：实时推送用户变更
    rpc WatchUsers(ListUsersRequest) returns (stream User);
}
```

生成 Go 代码：

```bash
protoc --go_out=. --go_opt=paths=source_relative \
       --go-grpc_out=. --go-grpc_opt=paths=source_relative \
       proto/user/user.proto
```

## 实现 gRPC 服务端

```go
// server/user_server.go
package server

import (
    "context"
    "fmt"
    "sync"

    pb "github.com/yourname/myapp/proto/user"
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

type UserServer struct {
    pb.UnimplementedUserServiceServer
    mu    sync.RWMutex
    users map[int64]*pb.User
    nextID int64
}

func NewUserServer() *UserServer {
    return &UserServer{
        users:  make(map[int64]*pb.User),
        nextID: 1,
    }
}

func (s *UserServer) GetUser(ctx context.Context, req *pb.GetUserRequest) (*pb.User, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    user, ok := s.users[req.Id]
    if !ok {
        return nil, status.Errorf(codes.NotFound, "user %d not found", req.Id)
    }
    return user, nil
}

func (s *UserServer) CreateUser(ctx context.Context, req *pb.CreateUserRequest) (*pb.User, error) {
    if req.Name == "" {
        return nil, status.Error(codes.InvalidArgument, "name is required")
    }
    if req.Email == "" {
        return nil, status.Error(codes.InvalidArgument, "email is required")
    }

    s.mu.Lock()
    defer s.mu.Unlock()

    user := &pb.User{
        Id:    s.nextID,
        Name:  req.Name,
        Email: req.Email,
        Age:   req.Age,
    }
    s.users[s.nextID] = user
    s.nextID++

    return user, nil
}

func (s *UserServer) ListUsers(ctx context.Context, req *pb.ListUsersRequest) (*pb.ListUsersResponse, error) {
    s.mu.RLock()
    defer s.mu.RUnlock()

    users := make([]*pb.User, 0, len(s.users))
    for _, u := range s.users {
        users = append(users, u)
    }

    return &pb.ListUsersResponse{
        Users: users,
        Total: int32(len(users)),
    }, nil
}

// 服务端流式 RPC
func (s *UserServer) WatchUsers(req *pb.ListUsersRequest, stream pb.UserService_WatchUsersServer) error {
    s.mu.RLock()
    users := make([]*pb.User, 0, len(s.users))
    for _, u := range s.users {
        users = append(users, u)
    }
    s.mu.RUnlock()

    for _, user := range users {
        if err := stream.Send(user); err != nil {
            return err
        }
    }
    return nil
}
```

## 启动 gRPC 服务器

```go
// main.go
package main

import (
    "log"
    "net"

    "github.com/yourname/myapp/server"
    pb "github.com/yourname/myapp/proto/user"
    "google.golang.org/grpc"
    "google.golang.org/grpc/reflection"
)

func main() {
    lis, err := net.Listen("tcp", ":50051")
    if err != nil {
        log.Fatalf("failed to listen: %v", err)
    }

    // 创建 gRPC 服务器，添加拦截器
    s := grpc.NewServer(
        grpc.UnaryInterceptor(loggingInterceptor),
        grpc.StreamInterceptor(streamLoggingInterceptor),
    )

    pb.RegisterUserServiceServer(s, server.NewUserServer())

    // 开启 reflection（grpcurl 调试用）
    reflection.Register(s)

    log.Println("gRPC server listening on :50051")
    if err := s.Serve(lis); err != nil {
        log.Fatalf("failed to serve: %v", err)
    }
}

// 一元拦截器（类似 HTTP 中间件）
func loggingInterceptor(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
    start := time.Now()
    resp, err := handler(ctx, req)
    log.Printf("method=%s duration=%v err=%v", info.FullMethod, time.Since(start), err)
    return resp, err
}
```

## gRPC 客户端

```go
// client/client.go
package main

import (
    "context"
    "log"
    "time"

    pb "github.com/yourname/myapp/proto/user"
    "google.golang.org/grpc"
    "google.golang.org/grpc/credentials/insecure"
)

func main() {
    // 建立连接（生产环境应使用 TLS）
    conn, err := grpc.Dial(":50051",
        grpc.WithTransportCredentials(insecure.NewCredentials()),
        grpc.WithBlock(),
    )
    if err != nil {
        log.Fatalf("failed to connect: %v", err)
    }
    defer conn.Close()

    client := pb.NewUserServiceClient(conn)
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    // 创建用户
    user, err := client.CreateUser(ctx, &pb.CreateUserRequest{
        Name:  "Alice",
        Email: "alice@example.com",
        Age:   28,
    })
    if err != nil {
        log.Fatalf("CreateUser failed: %v", err)
    }
    log.Printf("Created user: %+v", user)

    // 获取用户
    got, err := client.GetUser(ctx, &pb.GetUserRequest{Id: user.Id})
    if err != nil {
        log.Fatalf("GetUser failed: %v", err)
    }
    log.Printf("Got user: %+v", got)

    // 使用流式 RPC
    stream, err := client.WatchUsers(ctx, &pb.ListUsersRequest{})
    if err != nil {
        log.Fatalf("WatchUsers failed: %v", err)
    }
    for {
        u, err := stream.Recv()
        if err != nil {
            break
        }
        log.Printf("Received user: %+v", u)
    }
}
```

## 错误处理

gRPC 使用 `status` 包返回结构化错误：

```go
import (
    "google.golang.org/grpc/codes"
    "google.golang.org/grpc/status"
)

// 服务端返回错误
return nil, status.Errorf(codes.NotFound, "user %d not found", id)
return nil, status.Errorf(codes.InvalidArgument, "invalid email: %s", email)
return nil, status.Errorf(codes.Internal, "database error: %v", err)

// 客户端处理错误
if err != nil {
    st, ok := status.FromError(err)
    if ok {
        switch st.Code() {
        case codes.NotFound:
            log.Println("用户不存在")
        case codes.InvalidArgument:
            log.Println("参数错误:", st.Message())
        default:
            log.Println("未知错误:", st.Message())
        }
    }
}
```

## 调试工具

```bash
# 使用 grpcurl 测试（类似 curl）
grpcurl -plaintext localhost:50051 list
grpcurl -plaintext -d '{"id": 1}' localhost:50051 user.UserService/GetUser
```

## 总结

gRPC vs REST 对比：

| 维度 | gRPC | REST |
|------|------|------|
| 协议 | HTTP/2 | HTTP/1.1 |
| 序列化 | Protobuf（二进制） | JSON（文本） |
| 性能 | 更快（~5x） | 较慢 |
| 类型安全 | 强（proto 定义） | 弱 |
| 浏览器支持 | 需要 grpc-web | 原生支持 |
| 流式通信 | 支持 | 有限（SSE/WebSocket） |

**适用场景**：微服务间内部通信用 gRPC，对外 API 用 REST（或同时提供两种）。
