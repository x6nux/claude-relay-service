# Claude Middleware Docker 部署指南

## 🐳 Docker镜像

### 镜像信息
- **镜像名称**: `lfreea/claude-relay-service`
- **中间层标签**: 
  - `middleware-latest` - 最新版本
  - `middleware-X.Y.Z` - 版本标签（如 `middleware-1.2.6`）
  - `main-middleware` - 主分支版本
  - `{branch}-middleware` - 特定分支版本
  - `{branch}-middleware-{sha}` - 特定提交版本
- **架构支持**: `linux/amd64`, `linux/arm64`

### 快速启动

#### 1. 使用Docker Run
```bash
# 基本启动
docker run -d \
  --name claude-middleware \
  -p 8080:8080 \
  -e TARGET_URL=http://localhost:3001 \
  -e REDIS_HOST=localhost \
  lfreea/claude-relay-service:middleware-latest

# 完整配置启动（包含认证）
docker run -d \
  --name claude-middleware \
  -p 8080:8080 \
  -e PORT=8080 \
  -e GIN_MODE=production \
  -e REDIS_HOST=redis \
  -e REDIS_PORT=6379 \
  -e REDIS_PASSWORD="" \
  -e REDIS_DB=0 \
  -e TARGET_URL=http://claude-relay:3001 \
  -e PROXY_TIMEOUT=300 \
  -e MIDDLEWARE_AUTH_ENABLED=true \
  -e MIDDLEWARE_API_KEYS="cr_your_key_1,cr_your_key_2" \
  -e MIDDLEWARE_API_KEY_PREFIX=cr_ \
  lfreea/claude-relay-service:middleware-latest
```

#### 2. 使用Docker Compose
下载GitHub Action生成的`docker-compose-middleware.yml`：

```bash
# 下载部署文件
curl -O https://github.com/lfreea/claude-relay-service/releases/latest/download/docker-compose-middleware.yml

# 启动服务
docker-compose -f docker-compose-middleware.yml up -d
```

#### 3. 集成到现有Stack
```yaml
# 添加到现有的docker-compose.yml
services:
  # ... 现有服务

  claude-middleware:
    image: lfreea/claude-relay-service:middleware-latest
    container_name: claude-middleware
    ports:
      - "8080:8080"
    environment:
      - TARGET_URL=http://claude-relay:3001
      - REDIS_HOST=redis
    depends_on:
      - claude-relay
      - redis
    networks:
      - claude-network
```

## ⚙️ 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `PORT` | `8080` | 中间层监听端口 |
| `GIN_MODE` | `debug` | Gin运行模式 (debug/release) |
| `REDIS_HOST` | `localhost` | Redis主机地址 |
| `REDIS_PORT` | `6379` | Redis端口 |
| `REDIS_PASSWORD` | `""` | Redis密码 |
| `REDIS_DB` | `0` | Redis数据库编号 |
| `TARGET_URL` | `http://localhost:3001` | Node.js后端地址 |
| `PROXY_TIMEOUT` | `300` | 代理超时时间(秒) |
| `MIDDLEWARE_AUTH_ENABLED` | `false` | 是否启用API Key认证 |
| `MIDDLEWARE_API_KEYS` | `""` | 允许的API Keys(逗号分隔) |
| `MIDDLEWARE_API_KEY_PREFIX` | `cr_` | API Key前缀 |

## 🏗️ Kubernetes部署

使用GitHub Action生成的Kubernetes配置：

```bash
# 下载Kubernetes配置
curl -O https://github.com/lfreea/claude-relay-service/releases/latest/download/kubernetes-middleware.yml

# 部署到集群
kubectl apply -f kubernetes-middleware.yml

# 查看状态
kubectl get pods -l app=claude-middleware
kubectl get svc claude-middleware-service
```

### Ingress配置示例
```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: claude-middleware-ingress
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  rules:
  - host: middleware.yourdomain.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: claude-middleware-service
            port:
              number: 8080
```

## 📊 监控和健康检查

### 健康检查端点
```bash
# 检查服务健康状态
curl http://localhost:8080/health

# 响应示例
{
  "status": "ok",
  "service": "claude-middleware"
}
```

### 日志查看
```bash
# Docker日志
docker logs claude-middleware -f

# Kubernetes日志
kubectl logs -f deployment/claude-middleware
```

### 性能监控
```bash
# 容器资源使用
docker stats claude-middleware

# Kubernetes资源使用
kubectl top pods -l app=claude-middleware
```

## 🔧 故障排除

### 常见问题

1. **连接Redis失败**
   ```bash
   # 检查Redis连接
   docker run --rm -it redis:7-alpine redis-cli -h YOUR_REDIS_HOST ping
   ```

2. **后端服务不可达**
   ```bash
   # 检查网络连通性
   docker run --rm nicolaka/netshoot curl -v http://YOUR_TARGET_URL/health
   ```

3. **权限问题**
   ```bash
   # 使用非root用户运行
   docker run --user 1000:1000 ...
   ```

### 调试模式
```bash
# 启用调试日志
docker run -e GIN_MODE=debug lfreea/claude-relay-service:middleware-latest
```

## 🚀 生产部署建议

### 1. 资源配置
```yaml
resources:
  requests:
    memory: "64Mi"
    cpu: "50m"
  limits:
    memory: "128Mi"
    cpu: "200m"
```

### 2. 高可用部署
```yaml
replicas: 3
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 1
    maxSurge: 1
```

### 3. 网络策略
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: claude-middleware-netpol
spec:
  podSelector:
    matchLabels:
      app: claude-middleware
  policyTypes:
  - Ingress
  - Egress
  ingress:
  - from:
    - namespaceSelector: {}
    ports:
    - protocol: TCP
      port: 8080
  egress:
  - to: []
    ports:
    - protocol: TCP
      port: 6379  # Redis
    - protocol: TCP
      port: 3001  # Backend
```

## 📈 扩展和优化

### 水平扩展
```bash
# Docker Swarm
docker service scale claude-middleware=3

# Kubernetes
kubectl scale deployment claude-middleware --replicas=3
```

### 负载均衡
```yaml
# 使用LoadBalancer类型
apiVersion: v1
kind: Service
metadata:
  name: claude-middleware-lb
spec:
  type: LoadBalancer
  selector:
    app: claude-middleware
  ports:
  - port: 80
    targetPort: 8080
```