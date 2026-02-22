---
title: "理解 Goroutine 与 Channel 的并发模型"
author: Tu
pubDatetime: 2024-06-28T10:00:00Z
featured: true
draft: false
tags:
  - Go
  - 并发
description: "深入理解 Go 的 CSP 并发模型，掌握 Goroutine 和 Channel 的正确使用姿势"
---

Go 的并发模型基于 CSP（Communicating Sequential Processes）理论，核心思想是：**不要通过共享内存来通信，而要通过通信来共享内存**。这使得 Go 的并发代码既简洁又安全。

## Goroutine 基础

Goroutine 是 Go 运行时管理的轻量级线程，创建成本极低（初始栈约 2-8KB），可以轻松启动数十万个：

```go
package main

import (
    "fmt"
    "sync"
    "time"
)

func worker(id int, wg *sync.WaitGroup) {
    defer wg.Done()
    fmt.Printf("Worker %d starting\n", id)
    time.Sleep(time.Second) // 模拟工作
    fmt.Printf("Worker %d done\n", id)
}

func main() {
    var wg sync.WaitGroup

    for i := 1; i <= 5; i++ {
        wg.Add(1)
        go worker(i, &wg)
    }

    wg.Wait()
    fmt.Println("All workers done")
}
```

## Channel 通信

Channel 是 goroutine 之间通信的管道：

```go
package main

import "fmt"

func sum(s []int, c chan int) {
    total := 0
    for _, v := range s {
        total += v
    }
    c <- total // 发送结果到 channel
}

func main() {
    s := []int{7, 2, 8, -9, 4, 0}
    c := make(chan int)

    go sum(s[:len(s)/2], c) // 前半部分
    go sum(s[len(s)/2:], c) // 后半部分

    x, y := <-c, <-c // 接收两个结果

    fmt.Println(x, y, x+y) // 17 -5 12（顺序可能不同）
}
```

## 带缓冲的 Channel

```go
package main

import "fmt"

func main() {
    // 缓冲大小为 3，发送方在缓冲满之前不会阻塞
    ch := make(chan string, 3)

    ch <- "first"
    ch <- "second"
    ch <- "third"

    fmt.Println(<-ch) // first
    fmt.Println(<-ch) // second
    fmt.Println(<-ch) // third
}
```

## 生产者-消费者模式

这是 Channel 最经典的用法：

```go
package main

import (
    "fmt"
    "sync"
)

func producer(jobs chan<- int, n int) {
    for i := 0; i < n; i++ {
        jobs <- i
        fmt.Printf("Produced: %d\n", i)
    }
    close(jobs) // 生产完毕，关闭 channel
}

func consumer(id int, jobs <-chan int, results chan<- int, wg *sync.WaitGroup) {
    defer wg.Done()
    for job := range jobs { // range 会在 channel 关闭后自动退出
        result := job * job // 模拟处理：计算平方
        results <- result
        fmt.Printf("Consumer %d processed job %d -> %d\n", id, job, result)
    }
}

func main() {
    jobs := make(chan int, 10)
    results := make(chan int, 10)
    var wg sync.WaitGroup

    // 启动 3 个消费者
    for i := 1; i <= 3; i++ {
        wg.Add(1)
        go consumer(i, jobs, results, &wg)
    }

    // 启动生产者
    go producer(jobs, 9)

    // 等待所有消费者完成后关闭 results
    go func() {
        wg.Wait()
        close(results)
    }()

    // 收集所有结果
    for result := range results {
        fmt.Println("Result:", result)
    }
}
```

## select 语句

`select` 让 goroutine 可以同时等待多个 channel 操作：

```go
package main

import (
    "fmt"
    "time"
)

func main() {
    ch1 := make(chan string)
    ch2 := make(chan string)

    go func() {
        time.Sleep(1 * time.Second)
        ch1 <- "from channel 1"
    }()

    go func() {
        time.Sleep(2 * time.Second)
        ch2 <- "from channel 2"
    }()

    for i := 0; i < 2; i++ {
        select {
        case msg1 := <-ch1:
            fmt.Println("Received:", msg1)
        case msg2 := <-ch2:
            fmt.Println("Received:", msg2)
        }
    }
}
```

## 超时控制

使用 `select` + `time.After` 实现超时：

```go
func fetchWithTimeout(url string, timeout time.Duration) (string, error) {
    resultCh := make(chan string, 1)
    errCh := make(chan error, 1)

    go func() {
        // 模拟 HTTP 请求
        time.Sleep(2 * time.Second)
        resultCh <- "response data"
    }()

    select {
    case result := <-resultCh:
        return result, nil
    case err := <-errCh:
        return "", err
    case <-time.After(timeout):
        return "", fmt.Errorf("request timed out after %v", timeout)
    }
}
```

## 常见陷阱

**1. 忘记关闭 Channel 导致泄漏**
```go
// 错误：如果没有人关闭 jobs，consumer 会永远阻塞
for job := range jobs { // range 需要 channel 被关闭才能退出
    process(job)
}
```

**2. 向已关闭的 Channel 发送数据会 panic**
```go
ch := make(chan int)
close(ch)
ch <- 1 // panic: send on closed channel
```

**3. goroutine 泄漏**
```go
// 如果 ch 没人接收，这个 goroutine 会永远阻塞
go func() {
    ch <- heavyComputation() // 如果主函数已退出或 ch 满了，这里永远阻塞
}()
```

## 总结

Go 的并发模型优雅且强大：
- **Goroutine** 轻量高效，可以启动成千上万个
- **Channel** 提供类型安全的通信机制，避免共享内存的竞态问题
- **select** 让 goroutine 可以响应多个事件
- 始终注意 goroutine 的生命周期管理，避免泄漏

在实际项目中，要根据场景选择：简单的数据传递用 channel，需要多 goroutine 共享状态时用 `sync.Mutex`，需要传递请求上下文时用 `context` 包。
