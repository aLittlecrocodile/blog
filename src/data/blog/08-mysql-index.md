---
title: "MySQL 索引优化实战笔记"
author: Tu
pubDatetime: 2024-09-05T10:00:00Z
featured: false
draft: false
tags:
  - MySQL
  - 数据库
description: "从索引原理到实战优化，深入理解 B+ 树索引、覆盖索引、索引失效场景及 EXPLAIN 分析"
---

MySQL 索引优化是后端开发中最重要的性能优化手段之一。本文从 B+ 树原理出发，结合实际案例讲解如何设计和优化索引。

## B+ 树索引原理

MySQL InnoDB 使用 B+ 树作为索引数据结构，有如下特点：
- 所有数据都存储在叶子节点
- 叶子节点通过双向链表相连，支持范围查询
- 非叶子节点只存储 key，树高低，IO 次数少

```
                [30]
               /    \
          [10,20]   [40,50]
         /  |  \    /  |  \
       [5] [15] [25][35][45][55]  ← 叶子节点（存储完整行数据或主键）
```

**聚簇索引**（主键索引）：叶子节点存储完整行数据。
**辅助索引**（二级索引）：叶子节点存储主键值，查询需要回表。

## EXPLAIN 分析

```sql
EXPLAIN SELECT * FROM users WHERE age > 25 AND city = 'Beijing';
```

关注这几列：

| 列 | 含义 |
|----|------|
| `type` | 访问类型，从好到差：`const` > `eq_ref` > `ref` > `range` > `index` > `ALL` |
| `key` | 实际使用的索引 |
| `rows` | 预估扫描行数 |
| `Extra` | 额外信息，如 `Using index`（覆盖索引）、`Using filesort` |

## 索引设计原则

### 1. 最左前缀原则

```sql
-- 创建复合索引
CREATE INDEX idx_city_age_name ON users(city, age, name);

-- 可以用到索引：city, city+age, city+age+name
SELECT * FROM users WHERE city = 'Beijing';
SELECT * FROM users WHERE city = 'Beijing' AND age = 25;
SELECT * FROM users WHERE city = 'Beijing' AND age = 25 AND name = 'Alice';

-- 跳过 city，无法使用索引
SELECT * FROM users WHERE age = 25;
```

### 2. 覆盖索引

当查询的所有字段都在索引中时，无需回表：

```sql
CREATE INDEX idx_city_age ON users(city, age);

-- 覆盖索引：只需要 city 和 age，索引中都有，不用回表
-- Extra: Using index
SELECT city, age FROM users WHERE city = 'Beijing';

-- 需要回表：需要 name，不在索引中
-- Extra: NULL
SELECT city, age, name FROM users WHERE city = 'Beijing';
```

### 3. 索引下推（ICP）

MySQL 5.6+ 支持在存储引擎层过滤，减少回表次数：

```sql
CREATE INDEX idx_city_age ON users(city, age);

-- 没有 ICP：存储引擎返回所有 city='Beijing' 的记录，再在 Server 层过滤 age
-- 有 ICP：存储引擎在扫描时直接过滤 age 条件，减少回表
SELECT * FROM users WHERE city = 'Beijing' AND age > 20;
```

## 索引失效场景

```sql
CREATE INDEX idx_name ON users(name);

-- 1. 对索引列使用函数
SELECT * FROM users WHERE LOWER(name) = 'alice';  -- 失效
SELECT * FROM users WHERE name = 'alice';          -- 有效

-- 2. 隐式类型转换（phone 是 varchar，传 int 会失效）
SELECT * FROM users WHERE phone = 13800138000;    -- 失效
SELECT * FROM users WHERE phone = '13800138000';  -- 有效

-- 3. 使用 OR（其中一个列没有索引）
SELECT * FROM users WHERE name = 'alice' OR age = 25;  -- age 没有索引，失效

-- 4. LIKE 以 % 开头
SELECT * FROM users WHERE name LIKE '%alice';  -- 失效
SELECT * FROM users WHERE name LIKE 'alice%';  -- 有效

-- 5. 不等于（!=, <>）通常无法使用索引
SELECT * FROM users WHERE status != 1;  -- 通常走全表扫描
```

## 实战案例

### 分页优化

```sql
-- 慢：OFFSET 大时需要扫描并丢弃大量数据
SELECT * FROM orders ORDER BY id LIMIT 100000, 20;

-- 快：利用主键索引的覆盖索引特性
SELECT * FROM orders
WHERE id > (SELECT id FROM orders ORDER BY id LIMIT 100000, 1)
ORDER BY id LIMIT 20;

-- 更推荐的方式：游标分页
SELECT * FROM orders WHERE id > :last_id ORDER BY id LIMIT 20;
```

### 联合索引的顺序

```sql
-- 查询：WHERE city = ? AND age BETWEEN ? AND ? ORDER BY name
-- 索引顺序应该是：(city, age, name)
-- city 用于等值过滤，age 用于范围过滤，name 用于排序
-- 注意：范围查询后面的索引列无法继续用于过滤，但可以用于排序

CREATE INDEX idx_city_age_name ON users(city, age, name);
```

### 慢查询定位

```sql
-- 开启慢查询日志
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 1; -- 超过 1 秒记录

-- 查看慢查询
SHOW VARIABLES LIKE 'slow_query_log_file';
```

使用 `pt-query-digest` 分析慢查询日志：

```bash
pt-query-digest /var/log/mysql/slow.log | head -100
```

## 索引维护

```sql
-- 查看表的索引
SHOW INDEX FROM users;

-- 分析索引基数（cardinality）：基数越高，区分度越好
-- name 基数高 → 好索引；status(0/1) 基数低 → 效果差

-- 定期更新统计信息
ANALYZE TABLE users;

-- 重建索引（InnoDB 会 rebuild 整张表，生产环境用 pt-online-schema-change）
ALTER TABLE users ENGINE=InnoDB;
```

## 总结

索引优化核心原则：
1. **小表不加索引，大表精心设计**
2. **利用覆盖索引消除回表**
3. **复合索引遵循最左前缀，等值在前、范围在后**
4. **避免索引失效：不对索引列用函数、避免隐式转换**
5. **分页大 OFFSET 用游标法替代**
6. **EXPLAIN 是分析慢查询的第一步**
