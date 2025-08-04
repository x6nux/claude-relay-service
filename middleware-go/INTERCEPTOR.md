# 请求拦截器 (Request Interceptor)

## 功能概述

请求拦截器已集成到中间件服务中，**默认启用**且**无需额外配置**。它会拦截所有不符合规则的请求，并将详细的请求日志输出到 `claude-requests.json` 文件中。

## 关键特性

- ✅ **默认启用**: 拦截器已经内置到服务中，启动即生效
- ✅ **无需配置**: 不需要任何环境变量或配置文件
- ✅ **可扩展**: 支持添加多个过滤规则
- ✅ **统一日志**: 所有请求记录在 `claude-requests.json` 中

## 过滤规则

当前内置的过滤规则 (在 `internal/interceptor/user_filter.go` 中):

### 1. 路径拦截
- 拦截包含 `/blocked` 的请求路径

### 2. IP 黑名单
- 拦截来自 `192.168.1.100` 和 `10.0.0.50` 的请求

### 3. 内容过滤
- 拦截请求体中包含敏感词的请求：`malicious`, `spam`, `attack`

### 4. User-Agent 过滤
- 拦截包含 `bot` 或 `crawler` 的 User-Agent

## 自定义过滤规则

要修改过滤规则，编辑 `internal/interceptor/user_filter.go` 文件中的 `UserFilter` 函数：

```go
func UserFilter(ctx *InterceptorContext) bool {
    // 添加你的过滤逻辑
    // 返回 true 允许请求通过
    // 返回 false 拦截请求
    
    // 示例：拦截特定API路径
    if strings.Contains(ctx.Request.Path, "/sensitive-api") {
        log.Warnf("Blocked sensitive API access: %s", ctx.Request.Path)
        return false
    }
    
    return true
}
```

## 日志格式

被拦截的请求会返回HTTP 403状态码，响应格式：
```json
{
    "error": "Request blocked",
    "message": "This request has been blocked by the interceptor",
    "timestamp": "2024-01-01T12:00:00Z"
}
```

所有请求（包括被拦截的）都会记录到 `claude-requests.json` 文件中，格式如下：
```json
[
    {
        "id": "20240101120000-123456",
        "timestamp": "2024-01-01T12:00:00.000Z",
        "method": "POST",
        "url": "/v1/messages",
        "path": "/v1/messages",
        "headers": {
            "Content-Type": "application/json",
            "User-Agent": "MyApp/1.0"
        },
        "body": {...},
        "client_ip": "192.168.1.1",
        "user_agent": "MyApp/1.0"
    }
]
```

## 运行服务

拦截器已经集成到主服务中，直接启动即可：

```bash
# 开发模式
go run main.go

# 或构建后运行
go build -o middleware main.go
./middleware
```

服务启动时会显示：
```
Request interceptor middleware enabled
Request interceptor initialized with 1 filter(s)
```

## 测试拦截器

```bash
# 正常请求 - 应该通过
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello"}'

# 被拦截的请求 - 应该返回403
curl -X POST http://localhost:8080/blocked/api \
  -H "Content-Type: application/json"

# 敏感内容被拦截 - 应该返回403  
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -d '{"message": "This is malicious content"}'
```

## 添加更多过滤器

如果需要添加更多过滤逻辑，可以在 `main.go` 中动态添加：

```go
// 在 main.go 中的 requestInterceptor 初始化后添加
requestInterceptor.AddFilter(func(ctx *interceptor.InterceptorContext) bool {
    // 自定义过滤逻辑
    return true
})
```

或者修改 `CreateRequestInterceptor()` 函数来添加更多内置过滤器。