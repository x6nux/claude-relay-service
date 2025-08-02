# 简化的OAuth账户创建API使用指南

## 概述

新的简化OAuth账户创建API允许您直接提供OAuth令牌来创建账户，避免了复杂的多步骤OAuth授权流程。

## API端点

```
POST /api/v1/accounts/oauth/create
```

## 认证

需要包含 `[ACCOUNT_MANAGEMENT]` 标记的有效API Key。

## 请求格式

### Headers
```
X-API-Key: cr_your_api_key
Content-Type: application/json
```

### Body
```json
{
  "name": "账户名称（必填）",
  "description": "账户描述（可选）",
  "accessToken": "您的access_token（必填）",
  "refreshToken": "您的refresh_token（必填）",
  "expiresIn": 3600,  // 可选，默认3600秒
  "scopes": "org:create_api_key user:profile user:inference",  // 可选
  "accountType": "shared",  // 可选: "shared" 或 "dedicated"
  "proxy": {  // 可选
    "type": "socks5",
    "host": "127.0.0.1",
    "port": 1080,
    "username": "proxy_user",
    "password": "proxy_pass"
  }
}
```

## 响应格式

### 成功响应 (200)
```json
{
  "success": true,
  "data": {
    "id": "账户ID",
    "name": "账户名称",
    "description": "账户描述",
    "accountType": "shared",
    "status": "active",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "expiresAt": "2024-01-01T01:00:00.000Z"
  }
}
```

### 错误响应 (400/500)
```json
{
  "error": "错误类型",
  "message": "详细错误信息"
}
```

## 使用示例

### 1. 使用cURL

```bash
curl -X POST https://your-server.com/api/v1/accounts/oauth/create \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "My Claude Account",
    "accessToken": "sk-ant-xxxxx",
    "refreshToken": "refresh_token_here",
    "accountType": "shared"
  }'
```

### 2. 使用Python

```python
import requests

url = "https://your-server.com/api/v1/accounts/oauth/create"
headers = {
    "X-API-Key": "cr_your_api_key",
    "Content-Type": "application/json"
}
data = {
    "name": "My Claude Account",
    "accessToken": "sk-ant-xxxxx",
    "refreshToken": "refresh_token_here",
    "accountType": "shared"
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

### 3. 使用JavaScript/Node.js

```javascript
const axios = require('axios');

const createOAuthAccount = async () => {
  const response = await axios.post(
    'https://your-server.com/api/v1/accounts/oauth/create',
    {
      name: 'My Claude Account',
      accessToken: 'sk-ant-xxxxx',
      refreshToken: 'refresh_token_here',
      accountType: 'shared'
    },
    {
      headers: {
        'X-API-Key': 'cr_your_api_key',
        'Content-Type': 'application/json'
      }
    }
  );
  
  console.log(response.data);
};

createOAuthAccount();
```

## 获取OAuth令牌的方法

如果您还没有OAuth令牌，可以通过以下方式获取：

1. **使用Claude Code CLI**
   ```bash
   claude-code login
   ```
   
2. **使用现有的多步骤API流程**
   - 生成授权URL
   - 在浏览器中授权
   - 交换授权码获取令牌

3. **从现有的Claude账户导出**
   如果您已经有通过其他方式创建的账户，可以导出其OAuth令牌。

## 与旧API的对比

### 旧的多步骤流程（5步）
1. 生成OAuth授权URL
2. 用户在浏览器中授权
3. 获取授权码
4. 交换授权码获取令牌
5. 使用令牌创建账户

### 新的简化流程（1步）
1. 直接提供令牌创建账户 ✅

## 注意事项

1. **令牌有效性**: 确保提供的access_token和refresh_token是有效的
2. **权限要求**: API Key必须有账户管理权限（包含`[ACCOUNT_MANAGEMENT]`标记）
3. **代理配置**: 如果需要通过代理访问Claude API，请在创建时配置proxy参数
4. **令牌刷新**: 系统会自动管理令牌刷新，无需手动干预

## 故障排除

### 常见错误

1. **404 Not Found**
   - 原因：服务器尚未加载新的路由
   - 解决：重启服务器或等待部署更新

2. **400 Bad Request**
   - 原因：缺少必填字段或字段格式错误
   - 解决：检查name、accessToken、refreshToken是否提供

3. **403 Forbidden**
   - 原因：API Key没有账户管理权限
   - 解决：使用包含`[ACCOUNT_MANAGEMENT]`标记的API Key

4. **500 Internal Server Error**
   - 原因：服务器内部错误或令牌无效
   - 解决：检查令牌有效性，查看服务器日志

## 测试工具

项目中包含了测试脚本：

```bash
# Python测试脚本
python test_simplified_oauth_api.py YOUR_API_KEY

# Bash测试脚本
./test_oauth_api.sh YOUR_API_KEY
```

## 更新历史

- **v1.2.15** (2024-01-xx): 添加简化的OAuth账户创建端点
- 避免了复杂的多步骤OAuth流程
- 支持直接提供令牌创建账户
- 保持与现有系统的完全兼容性