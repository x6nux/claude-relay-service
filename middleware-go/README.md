# Claude Middleware Go中间层

这是一个用Go语言实现的Claude API中间层，用于解决现有Node.js服务的负载均衡和故障转移问题。

## 功能特性

- **智能账户选择**: 从Redis中动态获取活跃的Claude账户（只读）
- **内存状态管理**: 账户限流和问题标记完全在内存中管理
- **负载均衡**: 基于最后使用时间的轮询算法
- **故障转移**: 自动检测并排除限流或异常账户  
- **限流处理**: 自动标记和恢复限流账户（1小时恢复）
- **请求转发**: 透明代理所有API请求到后端服务
- **请求头替换**: 自动在任何请求头中查找并替换`authenticator`格式为账户ID
- **Redis只读**: 不修改Redis中的数据，保持数据完整性
- **API认证**: 支持可选的API Key认证机制，防止服务滥用

## 架构设计

```
客户端请求 → Go中间层 → Node.js服务 → Anthropic API

Go中间层特点:
- 从Redis只读获取账户信息
- 在内存中管理账户状态（限流、问题标记）
- 自动扫描所有请求头，查找 Claude API key (sk-ant-xxx)
- 支持多种格式：直接的 sk-ant-xxx 或 authenticator sk-ant-xxx
- 将找到的 API key 替换为选中的账户ID
- 重启后状态重置，避免僵尸状态
```

## 配置环境变量

```bash
# 服务配置
PORT=8080
GIN_MODE=production

# Redis配置
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=""
REDIS_DB=0

# 代理配置
TARGET_URL=http://localhost:3001  # Node.js服务地址
PROXY_TIMEOUT=300

# 认证配置（可选）
MIDDLEWARE_AUTH_ENABLED=false           # 是否启用API Key认证
MIDDLEWARE_API_KEYS=""                  # 允许的API Keys（逗号分隔）
MIDDLEWARE_API_KEY_PREFIX=cr_           # API Key前缀
```

## 编译和运行

```bash
# 初始化依赖
go mod tidy

# 编译
go build -o claude-middleware .

# 运行
./claude-middleware
```

## Docker部署

### 🐳 Docker Hub (推荐)
项目提供自动构建的多架构Docker镜像：

```bash
# 拉取最新的中间层镜像
docker pull lfreea/claude-relay-service:middleware-latest

# 或拉取特定版本
docker pull lfreea/claude-relay-service:middleware-1.2.6

# 快速启动
docker run -d \
  --name claude-middleware \
  -p 8080:8080 \
  -e TARGET_URL=http://localhost:3001 \
  -e REDIS_HOST=localhost \
  lfreea/claude-relay-service:middleware-latest

# 健康检查
curl http://localhost:8080/health
```

### 🏷️ 可用镜像标签
- `middleware-latest` - 主分支最新版本（推荐）
- `middleware-X.Y.Z` - 特定版本（如 `middleware-1.2.6`）
- `main-middleware` - 主分支稳定版本  
- `{branch}-middleware` - 特定分支版本
- `{branch}-middleware-{sha}` - 特定提交版本

### 🏗️ 架构支持
- `linux/amd64` (x86_64)
- `linux/arm64` (ARM64/Apple Silicon)

### 本地构建
```dockerfile
FROM golang:1.21-alpine AS builder
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go build -o claude-middleware .

FROM alpine:latest
RUN apk --no-cache add ca-certificates
WORKDIR /root/
COPY --from=builder /app/claude-middleware .
CMD ["./claude-middleware"]
```

### 🔑 认证配置示例

中间层支持两层认证：

1. **中间层认证**（可选）：保护中间层服务不被滥用
2. **Claude API认证**（必需）：用于转发到后端的Claude账户认证

```bash
# 场景1：禁用中间层认证（开发/内网环境）
MIDDLEWARE_AUTH_ENABLED=false

# 请求示例（支持多种格式）：
# 方式1: 使用x-api-key
curl -X POST http://localhost:8080/api/v1/messages \
  -H "x-api-key: sk-ant-xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'

# 方式2: 使用Authorization Bearer
curl -X POST http://localhost:8080/api/v1/messages \
  -H "Authorization: Bearer sk-ant-xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'

# 方式3: 兼容旧格式 (authenticator前缀)
curl -X POST http://localhost:8080/api/v1/messages \
  -H "x-api-key: authenticator sk-ant-xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'

# 场景2：启用中间层认证（生产环境推荐）
MIDDLEWARE_AUTH_ENABLED=true
MIDDLEWARE_API_KEYS="cr_your_middleware_key_1,cr_your_middleware_key_2"

# 请求示例（需要两个key）：
curl -X POST http://localhost:8080/api/v1/messages \
  -H "x-api-key: cr_your_middleware_key_1" \
  -H "Authorization: Bearer sk-ant-xxx" \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "Hello"}]}'
```

**注意事项**：
- 中间层会扫描所有请求头，查找 Claude API key (sk-ant-xxx)
- 支持标准格式 `Authorization: Bearer sk-ant-xxx` 和 `x-api-key: sk-ant-xxx`
- 兼容旧格式 `authenticator sk-ant-xxx`
- 中间层认证key使用`cr_`前缀（仅在启用认证时需要）
- 找到的 API key 会被替换为选中的账户ID后转发

## 负载均衡策略

1. **账户过滤**: 只选择`isActive=true`且状态正常的账户
2. **多层故障检测**: 
   - 限流检测（429状态码）- 1小时恢复
   - 认证问题检测（401/403状态码）- 30分钟恢复
   - 服务器错误检测（5xx状态码）- 10分钟恢复
   - 网络错误检测 - 5分钟恢复
3. **智能账户选择**: 
   - 优先级1：完全可用的账户（最久未使用优先）
   - 优先级2：仅限流的账户（最早限流优先）
   - 优先级3：有其他问题的账户（作为最后备选）
4. **自动故障转移**: 
   - 网络错误时立即切换账户
   - 非2xx响应码时智能判断是否切换
   - 重试失败时标记多个账户
5. **定期刷新**: 每30秒从Redis刷新账户列表

## API接口

### 健康检查
```
GET /health
```

### 支持的代理路径
Go中间层支持以下所有API路径的透明代理：

```
# Claude API 主路径
POST/GET/PUT/DELETE /v1/*
POST/GET/PUT/DELETE /api/v1/*

# Claude API 别名路径  
POST/GET/PUT/DELETE /claude/v1/*

# Gemini API 路径
POST/GET/PUT/DELETE /gemini/*

# OpenAI兼容路径
POST/GET/PUT/DELETE /openai/claude/v1/*
POST/GET/PUT/DELETE /openai/gemini/v1/*

Headers:
x-api-key: authenticator YOUR_API_KEY
```

### 常用端点示例
```bash
# Claude消息API
POST /api/v1/messages
POST /claude/v1/messages

# OpenAI兼容的Claude API
POST /openai/claude/v1/chat/completions
GET /openai/claude/v1/models

# Gemini API
POST /gemini/messages
GET /gemini/models

# OpenAI兼容的Gemini API  
POST /openai/gemini/v1/chat/completions
GET /openai/gemini/v1/models
```

## 监控和日志

- **账户状态监控**: 实时账户选择和状态变化日志
- **内存状态管理**: 限流和问题账户状态仅在内存中跟踪
- **故障检测日志**: 详细的错误类型和处理策略日志
- **请求代理日志**: 包含路径、账户和响应状态的详细日志
- **故障转移日志**: 自动重试和账户切换操作日志
- **状态自动恢复**: 重启服务自动清除所有内存状态

### 日志示例
```
2025-01-xx xx:xx:xx Processing request: POST /api/v1/messages
2025-01-xx xx:xx:xx Selected available account: account_123 (Main Account)
2025-01-xx xx:xx:xx Successfully processed /api/v1/messages with account account_123
2025-01-xx xx:xx:xx 🚫 Marked account account_456 as problematic (reason: http_error_401, duration: 30m0s)
2025-01-xx xx:xx:xx Retrying /api/v1/messages with different account due to status 401: account_789
2025-01-xx xx:xx:xx Refreshed 5 active accounts
```

### 内存状态管理优势
- **无副作用**: 不修改Redis原始数据
- **自动清理**: 重启后状态自动重置
- **高性能**: 内存操作比Redis读写更快
- **容错性**: 避免因网络问题影响状态管理

## 与现有系统集成

1. 部署Go中间层到独立端口（如8080）
2. 将客户端请求重定向到Go中间层
3. Go中间层自动转发到现有Node.js服务（3001端口）
4. 保持现有的Redis数据结构和账户管理不变

这样可以在不修改现有Node.js代码的情况下，通过Go中间层解决负载均衡问题。