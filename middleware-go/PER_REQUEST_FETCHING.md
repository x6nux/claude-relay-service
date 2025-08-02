# Middleware-Go Per-Request Account Fetching

## 改动说明

已将 middleware-go 服务从定时获取账号改为每次请求时实时获取，并通过 context 传递账号信息。

### 主要改动

1. **移除了定时刷新机制**
   - 删除了 `activeAccounts`、`lastRefresh`、`accountsMutex` 字段
   - 删除了 `refreshAccounts()` 和 `accountRefreshWorker()` 函数
   - 不再有后台定时刷新账号的 goroutine

2. **改为每次请求实时获取**
   - `selectAvailableAccount()` 和 `selectAvailableAccountExcluding()` 现在每次调用都会从 Redis 获取最新账号列表
   - 确保每个请求都使用最新的账号状态

3. **通过 Context 传递账号信息**
   - 新增 `context.go` 文件，定义了 context key 和辅助函数
   - 在 `ProxyHandler` 中将选中的账号信息存储到请求的 context 中
   - 后续的中间件和处理函数可以从 context 中获取账号信息

4. **新增可选的中间件**
   - `AccountLoggingMiddleware`: 记录账号使用日志
   - `AccountMetricsMiddleware`: 统计账号使用指标

### 使用方法

#### 获取当前请求使用的账号信息

```go
// 在任何处理函数或中间件中
func someHandler(c *gin.Context) {
    // 获取账号ID
    if accountID, ok := proxy.GetAccountID(c.Request.Context()); ok {
        log.Printf("Using account: %s", accountID)
    }
    
    // 获取完整账号信息
    if account, ok := proxy.GetAccount(c.Request.Context()); ok {
        log.Printf("Account details - Name: %s, Status: %s", 
            account.Name, account.Status)
    }
}
```

#### 启用账号日志中间件

在 `main.go` 中取消注释以下行：

```go
api.Use(proxy.AccountLoggingMiddleware())
api.Use(proxy.AccountMetricsMiddleware(redisClient))
```

### 优势

1. **实时性**: 每个请求都获取最新的账号状态，无需等待定时刷新
2. **灵活性**: 通过 context 传递信息，任何中间件都可以访问账号信息
3. **可扩展性**: 易于添加新的中间件来处理账号相关逻辑
4. **资源优化**: 不再需要维护内存中的账号缓存和定时刷新 goroutine

### 性能考虑

- 每个请求都会查询 Redis，确保 Redis 连接池配置合理
- 如果请求量很大，可以考虑添加短时间的内存缓存（如 1-5 秒）
- Redis 查询使用 `KEYS` 命令，在账号数量很多时可能有性能影响，可以考虑优化为使用 SET 或 LIST 存储账号 ID

### 兼容性

这些改动完全向后兼容，不会影响现有的 API 调用和功能。