#!/bin/bash

# Go中间层测试脚本

set -e

MIDDLEWARE_URL="http://localhost:8080"
API_KEY="authenticator test_key_123"

echo "🧪 Testing Claude Middleware Go Layer with Enhanced Failure Handling"
echo "=================================================================="

# 测试健康检查
echo ""
echo "1. 🏥 Testing health check..."
curl -s -X GET "$MIDDLEWARE_URL/health" | jq '.'

# 测试不同的API路径
echo ""
echo "2. 🔍 Testing various API paths with error handling..."

# 定义测试路径
paths=(
    "/api/v1/models"
    "/claude/v1/models" 
    "/v1/models"
    "/openai/claude/v1/models"
    "/gemini/models"
    "/openai/gemini/v1/models"
)

for path in "${paths[@]}"; do
    echo ""
    echo "Testing: GET $path"
    response=$(curl -s -w "HTTP_CODE:%{http_code}" \
        -H "x-api-key: $API_KEY" \
        -H "Content-Type: application/json" \
        "$MIDDLEWARE_URL$path")
    
    http_code=$(echo "$response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
    content=$(echo "$response" | sed 's/HTTP_CODE:[0-9]*$//')
    
    echo "Response Code: $http_code"
    
    case $http_code in
        200)
            echo "✅ Success: Request processed successfully"
            ;;
        401|403)
            echo "🔒 Auth Error: Should trigger account marking and retry"
            ;;
        429)
            echo "🚫 Rate Limited: Should trigger rate limit handling and retry"
            ;;
        500|502|503|504)
            echo "💥 Server Error: Should trigger problematic account marking and retry"
            ;;
        *)
            echo "❓ Unexpected Status: $http_code"
            ;;
    esac
done

echo ""
echo "3. 📝 Testing POST request with error handling..."
response=$(curl -s -w "HTTP_CODE:%{http_code}" \
    -H "x-api-key: $API_KEY" \
    -H "Content-Type: application/json" \
    -X POST \
    -d '{"model":"claude-3-sonnet","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}' \
    "$MIDDLEWARE_URL/api/v1/messages")

http_code=$(echo "$response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
echo "POST Response Code: $http_code"

echo ""
echo "4. 🚨 Testing invalid API key format..."
invalid_response=$(curl -s -w "HTTP_CODE:%{http_code}" \
    -H "x-api-key: invalid_format_key" \
    -H "Content-Type: application/json" \
    "$MIDDLEWARE_URL/api/v1/models")

invalid_http_code=$(echo "$invalid_response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
echo "Invalid API Key Response Code: $invalid_http_code"

if [ "$invalid_http_code" -eq 400 ]; then
    echo "✅ Correctly rejected invalid API key format"
else
    echo "❌ Unexpected response for invalid API key"
fi

echo ""
echo "5. 🔍 Testing missing API key..."
missing_response=$(curl -s -w "HTTP_CODE:%{http_code}" \
    -H "Content-Type: application/json" \
    "$MIDDLEWARE_URL/api/v1/models")

missing_http_code=$(echo "$missing_response" | grep -o "HTTP_CODE:[0-9]*" | cut -d: -f2)
echo "Missing API Key Response Code: $missing_http_code"

if [ "$missing_http_code" -eq 401 ]; then
    echo "✅ Correctly rejected missing API key"
else
    echo "❌ Unexpected response for missing API key"
fi

echo ""
echo ""
echo "🎉 Enhanced failure handling test completed!"
echo ""
echo "📊 Expected behaviors:"
echo "- Health check: 200 OK"
echo "- Valid requests: Proxy to backend with account selection"
echo "- Auth errors (401/403): Mark account problematic for 30min + retry (memory only)"
echo "- Rate limits (429): Mark account rate limited for 1hour + retry (memory only)"
echo "- Server errors (5xx): Mark account problematic for 10min + retry (memory only)"
echo "- Network errors: Mark account problematic for 5min + retry (memory only)"
echo "- Invalid API key format: 400 Bad Request"
echo "- Missing API key: 401 Unauthorized"
echo ""
echo "📝 Account Recovery Times (Memory Only):"
echo "- Rate limited accounts: 1 hour"
echo "- Auth problem accounts: 30 minutes"
echo "- Server error accounts: 10 minutes"
echo "- Network error accounts: 5 minutes"
echo ""
echo "🔄 Memory State Management:"
echo "- All account states stored in memory only"
echo "- No Redis data modification"
echo "- Service restart clears all states"
echo "- Automatic state expiration and cleanup"