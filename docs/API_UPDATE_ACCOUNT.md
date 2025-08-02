# Claude 账户更新 API 示例

## API 端点
```
PUT /api/v1/accounts/{accountId}
```

## 认证
需要带有 `[ACCOUNT_MANAGEMENT]` 标记的 API Key。

## 请求示例

### 1. 更新账户基本信息
```bash
curl -X PUT https://your-server.com/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Updated Account Name",
    "description": "Updated description",
    "isActive": true,
    "accountType": "shared"
  }'
```

### 2. 更新代理配置
```bash
curl -X PUT https://your-server.com/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "proxy": {
      "type": "socks5",
      "host": "127.0.0.1",
      "port": 1080,
      "username": "proxy_user",
      "password": "proxy_pass"
    }
  }'
```

### 3. 更新 OAuth 信息（完整格式）
```bash
curl -X PUT https://your-server.com/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "claudeAiOauth": {
      "access_token": "sk-ant-xxxxx",
      "refresh_token": "refresh_token_here",
      "expires_in": 3600,
      "scope": "org:create_api_key user:profile user:inference",
      "token_type": "Bearer"
    }
  }'
```

### 4. 更新 OAuth 信息（驼峰格式）
```bash
curl -X PUT https://your-server.com/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "claudeAiOauth": {
      "accessToken": "sk-ant-xxxxx",
      "refreshToken": "refresh_token_here",
      "expiresAt": 1704067200000,
      "scopes": ["org:create_api_key", "user:profile", "user:inference"]
    }
  }'
```

### 5. 禁用账户
```bash
curl -X PUT https://your-server.com/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "isActive": false
  }'
```

### 6. 组合更新（多个字段）
```bash
curl -X PUT https://your-server.com/api/v1/accounts/ACCOUNT_ID \
  -H "X-API-Key: cr_your_api_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Production Account",
    "description": "Main production account with proxy",
    "accountType": "dedicated",
    "isActive": true,
    "proxy": {
      "type": "http",
      "host": "proxy.example.com",
      "port": 8080
    }
  }'
```

## Python 示例

```python
import requests
import json

# 配置
API_BASE_URL = "https://your-server.com/api/v1"
API_KEY = "cr_your_management_key"
ACCOUNT_ID = "your-account-id"

def update_account(account_id, updates):
    """更新 Claude 账户信息"""
    
    url = f"{API_BASE_URL}/accounts/{account_id}"
    headers = {
        "X-API-Key": API_KEY,
        "Content-Type": "application/json"
    }
    
    response = requests.put(url, json=updates, headers=headers)
    
    if response.status_code == 200:
        print(f"✅ Account updated successfully")
        return response.json()
    else:
        print(f"❌ Failed to update account: {response.status_code}")
        print(response.json())
        return None

# 示例用法

# 1. 更新基本信息
update_account(ACCOUNT_ID, {
    "name": "Updated Account Name",
    "description": "Updated via Python script"
})

# 2. 更新代理配置
update_account(ACCOUNT_ID, {
    "proxy": {
        "type": "socks5",
        "host": "127.0.0.1",
        "port": 1080,
        "username": "user",
        "password": "pass"
    }
})

# 3. 更新 OAuth tokens
update_account(ACCOUNT_ID, {
    "claudeAiOauth": {
        "access_token": "sk-ant-new-token",
        "refresh_token": "new-refresh-token",
        "expires_in": 3600
    }
})

# 4. 禁用账户
update_account(ACCOUNT_ID, {
    "isActive": False
})
```

## JavaScript/Node.js 示例

```javascript
const axios = require('axios');

const API_BASE_URL = 'https://your-server.com/api/v1';
const API_KEY = 'cr_your_management_key';

async function updateAccount(accountId, updates) {
  try {
    const response = await axios.put(
      `${API_BASE_URL}/accounts/${accountId}`,
      updates,
      {
        headers: {
          'X-API-Key': API_KEY,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log('✅ Account updated successfully');
    return response.data;
  } catch (error) {
    console.error('❌ Failed to update account:', error.response?.data);
    throw error;
  }
}

// 使用示例
async function main() {
  const accountId = 'your-account-id';
  
  // 更新账户名称
  await updateAccount(accountId, {
    name: 'New Account Name'
  });
  
  // 更新 OAuth 信息
  await updateAccount(accountId, {
    claudeAiOauth: {
      access_token: 'sk-ant-xxxxx',
      refresh_token: 'refresh_xxxxx',
      expires_in: 3600
    }
  });
  
  // 更新代理设置
  await updateAccount(accountId, {
    proxy: {
      type: 'socks5',
      host: '127.0.0.1',
      port: 1080
    }
  });
}

main();
```

## 可更新的字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 账户名称 |
| `description` | string | 账户描述 |
| `email` | string | 邮箱地址 |
| `isActive` | boolean | 是否启用 |
| `accountType` | string | 账户类型（"shared" 或 "dedicated"） |
| `proxy` | object | 代理配置 |
| `proxy.type` | string | 代理类型（"http", "https", "socks5"） |
| `proxy.host` | string | 代理主机 |
| `proxy.port` | number | 代理端口 |
| `proxy.username` | string | 代理用户名（可选） |
| `proxy.password` | string | 代理密码（可选） |
| `claudeAiOauth` | object | OAuth 信息 |
| `claudeAiOauth.access_token` | string | 访问令牌 |
| `claudeAiOauth.refresh_token` | string | 刷新令牌 |
| `claudeAiOauth.expires_in` | number | 过期时间（秒） |
| `claudeAiOauth.expires_at` | number | 过期时间戳 |
| `claudeAiOauth.scope` | string | 权限范围 |

## 注意事项

1. **不可更新的字段**：
   - `id` - 账户ID
   - `createdAt` - 创建时间
   - `updatedAt` - 更新时间
   
2. **OAuth 字段格式**：
   - 支持下划线格式（`access_token`）和驼峰格式（`accessToken`）
   - 如果提供 `expires_in`，系统会自动计算 `expires_at`
   - `scopes` 可以是字符串或数组

3. **代理配置**：
   - 更新代理时，`host` 和 `port` 是必需的
   - `username` 和 `password` 是可选的

4. **部分更新**：
   - 只需要提供要更新的字段
   - 未提供的字段将保持不变

## 错误响应

### 400 Bad Request
```json
{
  "error": "Invalid account type"
}
```

### 403 Forbidden
```json
{
  "error": "Forbidden",
  "message": "This API key does not have permission to manage accounts"
}
```

### 404 Not Found
```json
{
  "error": "Account not found"
}
```

### 500 Internal Server Error
```json
{
  "error": "Failed to update account",
  "message": "详细错误信息"
}
```