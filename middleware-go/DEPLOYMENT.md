# 部署指南

## 🚀 快速部署

### 1. 环境准备
```bash
# 克隆项目（如果需要）
cd claude-relay-service/middleware-go

# 配置环境变量
cp .env.example .env
# 编辑 .env 文件，设置正确的Redis和目标URL

# 确保Redis运行正常
# 确保Node.js后端服务在3001端口运行
```

### 2. 方式一：直接运行
```bash
# 安装Go依赖
go mod tidy

# 编译
go build -o claude-middleware .

# 运行
./claude-middleware
```

### 3. 方式二：使用Make
```bash
make deps     # 安装依赖
make build    # 编译
make run      # 运行
```

### 4. 方式三：Docker部署
```bash
# 构建镜像
docker build -t claude-middleware .

# 运行容器
docker run -d \
  --name claude-middleware \
  -p 8080:8080 \
  --env-file .env \
  claude-middleware
```

### 5. 方式四：Docker Compose
```bash
# 使用现有的docker-compose.yml
docker-compose up -d claude-middleware
```

## 🔧 配置说明

### 必需环境变量
```bash
REDIS_HOST=localhost      # Redis主机地址
REDIS_PORT=6379          # Redis端口
TARGET_URL=http://localhost:3001  # Node.js后端地址
```

### 可选环境变量
```bash
PORT=8080               # 中间层监听端口
GIN_MODE=production     # Gin运行模式
REDIS_PASSWORD=""       # Redis密码
REDIS_DB=0             # Redis数据库
PROXY_TIMEOUT=300      # 代理超时时间(秒)
```

## 🔍 验证部署

### 1. 健康检查
```bash
curl http://localhost:8080/health
```

### 2. 运行测试脚本
```bash
./test-middleware.sh
```

### 3. 检查日志
```bash
# 如果是直接运行，查看控制台输出
# 如果是Docker，查看容器日志
docker logs claude-middleware
```

## 🌐 客户端集成

部署完成后，将客户端请求从原来的地址：
```
http://localhost:3001/api/v1/messages
```

改为中间层地址：
```
http://localhost:8080/api/v1/messages
```

请求头保持不变：
```
x-api-key: authenticator YOUR_API_KEY
```

## 📊 监控

### 查看运行状态
```bash
# 查看进程
ps aux | grep claude-middleware

# 查看端口监听
netstat -tlnp | grep :8080

# 查看系统资源
top -p $(pgrep claude-middleware)
```

### 日志监控
中间层会输出以下关键日志：
- 账户选择和负载均衡
- 请求代理状态
- 限流检测和恢复
- 故障转移操作

## 🚨 故障排除

### 常见问题
1. **Redis连接失败**
   - 检查Redis服务状态
   - 验证连接配置和密码

2. **无可用账户**
   - 检查Redis中是否有活跃的Claude账户
   - 验证账户状态和限流情况

3. **代理请求失败**
   - 检查Node.js后端服务状态
   - 验证TARGET_URL配置

4. **权限错误**
   - 检查API Key格式（需要authenticator前缀）
   - 验证后端认证流程

### 调试模式
```bash
# 使用debug模式运行
GIN_MODE=debug ./claude-middleware
```