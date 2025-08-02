# Claude 账户管理 API 文档

本文档描述了通过 API 管理 Claude 账户的接口。

## 认证要求

所有账户管理接口都需要：
1. 有效的 API Key（`cr_` 前缀）
2. 通过以下方式之一获得账户管理权限：
   - API Key 名称包含 "admin" 或 "manage"
   - API Key 描述中包含 `[ACCOUNT_MANAGEMENT]` 标记
   - API Key 使用特殊前缀 `cr_admin_`（预留功能）

## API 接口列表

### 简化的OAuth账户创建（推荐）

直接提供OAuth令牌创建账户，无需复杂的多步骤流程。

```
POST /api/v1/accounts/oauth/create
X-API-Key: cr_your_api_key
Content-Type: application/json
```

请求体：
```json
{
  "name": "账户名称",
  "description": "账户描述（可选）",
  "accessToken": "你的access_token",
  "refreshToken": "你的refresh_token",
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

成功响应：
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

使用示例（Python）：
```python
import requests

url = "https://your-server.com/api/v1/accounts/oauth/create"
headers = {
    "X-API-Key": "cr_your_api_key",
    "Content-Type": "application/json"
}
data = {
    "name": "Test Account",
    "accessToken": "sk-ant-...",
    "refreshToken": "refresh_token_here",
    "accountType": "shared"
}

response = requests.post(url, json=data, headers=headers)
print(response.json())
```

### 获取所有账户
```
GET /api/v1/accounts
Authorization: Bearer cr_your_api_key
```

返回所有 Claude 账户（已脱敏，不包含敏感 token）。

响应示例：
```json
{
  "success": true,
  "data": [
    {
      "id": "account-id",
      "name": "账户名称",
      "email": "email@example.com",
      "status": "active",
      "isActive": true,
      "accountType": "shared",
      "proxy": {
        "host": "proxy.example.com",
        "port": 1080,
        "type": "socks5"
      }
    }
  ]
}
```

### 创建账户
```
POST /api/v1/accounts
Authorization: Bearer cr_your_api_key
Content-Type: application/json

{
  "name": "账户名称",
  "description": "账户描述",
  "email": "email@example.com",
  "accountType": "shared", // 或 "dedicated"
  "claudeAiOauth": {
    "access_token": "...",
    "refresh_token": "...",
    "expires_in": 3600,
    "scope": "...",
    "token_type": "Bearer"
  },
  "proxy": {
    "host": "proxy.example.com",
    "port": 1080,
    "type": "socks5",
    "username": "用户名",
    "password": "密码"
  }
}
```

### 更新账户
```
PUT /api/v1/accounts/{accountId}
Authorization: Bearer cr_your_api_key
Content-Type: application/json

{
  "name": "新名称",
  "description": "新描述",
  "isActive": true,
  "proxy": {
    "host": "new-proxy.example.com",
    "port": 8080,
    "type": "http"
  }
}
```

### 删除账户
```
DELETE /api/v1/accounts/{accountId}
Authorization: Bearer cr_your_api_key
```

### OAuth 授权流程

#### 1. 生成 OAuth 授权链接
```
POST /api/v1/accounts/oauth/generate-url
Authorization: Bearer cr_your_api_key
Content-Type: application/json

{
  "proxy": {
    "host": "proxy.example.com",
    "port": 1080,
    "type": "socks5"
  }
}
```

返回：
```json
{
  "success": true,
  "data": {
    "authUrl": "https://claude.ai/oauth/authorize?...",
    "sessionId": "uuid",
    "expiresAt": "2024-01-01T10:00:00Z"
  }
}
```

#### 2. 交换授权码
```
POST /api/v1/accounts/oauth/exchange-code
Authorization: Bearer cr_your_api_key
Content-Type: application/json

{
  "sessionId": "第一步返回的sessionId",
  "authorizationCode": "OAuth回调中的授权码"
}
```

返回可用于创建账户的 OAuth tokens。

### 刷新账户 Token
```
POST /api/v1/accounts/{accountId}/refresh
Authorization: Bearer cr_your_api_key
```

## 前端使用示例

### JavaScript/TypeScript 示例

```javascript
// 配置
const API_BASE_URL = 'https://your-server.com/api/v1';
const API_KEY = 'cr_your_management_key'; // 需要包含 [ACCOUNT_MANAGEMENT] 标记

// 获取所有账户
async function getAllAccounts() {
  const response = await fetch(`${API_BASE_URL}/accounts`, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`
    }
  });
  return await response.json();
}

// 创建账户（使用 OAuth）
async function createAccountWithOAuth() {
  // 步骤1：生成 OAuth URL
  const oauthResponse = await fetch(`${API_BASE_URL}/accounts/oauth/generate-url`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      proxy: {
        host: 'proxy.example.com',
        port: 1080,
        type: 'socks5'
      }
    })
  });
  
  const { data } = await oauthResponse.json();
  const { authUrl, sessionId } = data;
  
  // 步骤2：让用户在浏览器中授权
  window.open(authUrl, '_blank');
  
  // 步骤3：用户授权后，获取授权码
  const authCode = prompt('请输入授权码：');
  
  // 步骤4：交换 token
  const tokenResponse = await fetch(`${API_BASE_URL}/accounts/oauth/exchange-code`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      sessionId: sessionId,
      authorizationCode: authCode
    })
  });
  
  const tokenData = await tokenResponse.json();
  
  // 步骤5：创建账户
  const createResponse = await fetch(`${API_BASE_URL}/accounts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      name: '我的 Claude 账户',
      email: 'user@example.com',
      accountType: 'shared',
      claudeAiOauth: tokenData.data.claudeAiOauth
    })
  });
  
  return await createResponse.json();
}

// 更新账户
async function updateAccount(accountId, updates) {
  const response = await fetch(`${API_BASE_URL}/accounts/${accountId}`, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(updates)
  });
  return await response.json();
}

// 删除账户
async function deleteAccount(accountId) {
  const response = await fetch(`${API_BASE_URL}/accounts/${accountId}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${API_KEY}`
    }
  });
  return await response.json();
}
```

### React 组件示例

```jsx
import React, { useState, useEffect } from 'react';

function AccountManager() {
  const [accounts, setAccounts] = useState([]);
  const [loading, setLoading] = useState(false);
  
  // 加载账户列表
  useEffect(() => {
    loadAccounts();
  }, []);
  
  const loadAccounts = async () => {
    setLoading(true);
    try {
      const data = await getAllAccounts();
      setAccounts(data.data);
    } catch (error) {
      console.error('加载账户失败:', error);
    }
    setLoading(false);
  };
  
  const handleCreateAccount = async () => {
    try {
      const result = await createAccountWithOAuth();
      if (result.success) {
        alert('账户创建成功！');
        loadAccounts(); // 重新加载列表
      }
    } catch (error) {
      alert('创建失败: ' + error.message);
    }
  };
  
  return (
    <div>
      <h2>账户管理</h2>
      <button onClick={handleCreateAccount}>创建新账户</button>
      
      {loading ? (
        <p>加载中...</p>
      ) : (
        <ul>
          {accounts.map(account => (
            <li key={account.id}>
              {account.name} - {account.status}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
```

## 完整示例：使用 OAuth 创建账户

```bash
# 步骤1：在管理面板创建带有管理权限的 API Key
# 在描述中添加 [ACCOUNT_MANAGEMENT]

# 步骤2：生成 OAuth URL
curl -X POST https://your-server.com/api/v1/accounts/oauth/generate-url \
  -H "Authorization: Bearer cr_your_management_key" \
  -H "Content-Type: application/json"

# 步骤3：用户在浏览器中授权并获取授权码

# 步骤4：交换授权码
curl -X POST https://your-server.com/api/v1/accounts/oauth/exchange-code \
  -H "Authorization: Bearer cr_your_management_key" \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "步骤2返回的sessionId",
    "authorizationCode": "浏览器中的授权码"
  }'

# 步骤5：使用 token 创建账户
curl -X POST https://your-server.com/api/v1/accounts \
  -H "Authorization: Bearer cr_your_management_key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "我的 Claude 账户",
    "email": "user@example.com",
    "claudeAiOauth": {
      "access_token": "...",
      "refresh_token": "..."
    }
  }'
```

## 错误处理

所有接口返回标准 HTTP 状态码：
- 200: 成功
- 400: 请求错误（参数无效）
- 403: 禁止访问（无权限）
- 404: 未找到
- 500: 服务器内部错误

错误响应格式：
```json
{
  "error": "错误类型",
  "message": "详细错误信息"
}
```

## 注意事项

1. **权限管理**：确保只给信任的用户创建带有 `[ACCOUNT_MANAGEMENT]` 标记的 API Key
2. **安全性**：API Key 应该妥善保管，不要在前端代码中硬编码
3. **代理配置**：如果需要通过代理访问 Claude，在创建账户时配置代理信息
4. **Token 刷新**：定期调用刷新接口保持账户 token 有效