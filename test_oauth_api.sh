#!/bin/bash

# 简化的OAuth账户创建API测试脚本
# 使用方法: ./test_oauth_api.sh YOUR_API_KEY

API_KEY="${1:-YOUR_API_KEY_HERE}"
API_URL="https://ccr.lfree.org/api/v1/accounts/oauth/create"

echo "🧪 Testing Simplified OAuth Account Creation API"
echo "================================================"
echo "📍 URL: $API_URL"
echo "🔑 API Key: ${API_KEY:0:10}..."
echo ""

# 创建OAuth账户
echo "📤 Sending request..."
curl -X POST "$API_URL" \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test OAuth Account",
    "description": "Created via simplified API",
    "accessToken": "sk-ant-xxxxx",
    "refreshToken": "refresh_token_here",
    "expiresIn": 3600,
    "scopes": "org:create_api_key user:profile user:inference",
    "accountType": "shared",
    "proxy": {
      "type": "socks5",
      "host": "127.0.0.1",
      "port": 1080,
      "username": "proxy_user",
      "password": "proxy_pass"
    }
  }' \
  -v

echo ""
echo "================================================"
echo "✅ Test completed"