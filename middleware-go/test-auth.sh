#!/bin/bash

# Go中间层API Key认证测试脚本

echo "🔐 Testing Go Middleware API Key Authentication"
echo "================================================"

# 设置测试环境变量
export MIDDLEWARE_AUTH_ENABLED=true
export MIDDLEWARE_API_KEYS="cr_test_key_123456789,cr_another_test_key_987654321"
export MIDDLEWARE_API_KEY_PREFIX="cr_"
export TARGET_URL="http://httpbin.org/anything"  # 使用httpbin作为测试后端
export REDIS_HOST="localhost"
export PORT="8081"

echo "Environment variables set:"
echo "  MIDDLEWARE_AUTH_ENABLED=$MIDDLEWARE_AUTH_ENABLED"
echo "  MIDDLEWARE_API_KEYS=$MIDDLEWARE_API_KEYS"
echo "  MIDDLEWARE_API_KEY_PREFIX=$MIDDLEWARE_API_KEY_PREFIX"
echo ""

# 启动中间层服务（后台运行）
echo "Starting middleware service..."
./claude-middleware &
MIDDLEWARE_PID=$!

# 等待服务启动
sleep 3

echo "Testing middleware authentication (PID: $MIDDLEWARE_PID)"
echo "Testing URL: http://localhost:$PORT"
echo ""

# 测试1: 无API Key - 应该返回401
echo "Test 1: Request without API key (should return 401)"
echo "curl -X GET http://localhost:$PORT/health"
curl -X GET http://localhost:$PORT/api/v1/test -w "\nStatus: %{http_code}\n" -s
echo ""

# 测试2: 错误的API Key - 应该返回401  
echo "Test 2: Request with wrong API key (should return 401)"
echo "curl -H 'x-api-key: wrong_key' http://localhost:$PORT/api/v1/test"
curl -H "x-api-key: wrong_key" -X GET http://localhost:$PORT/api/v1/test -w "\nStatus: %{http_code}\n" -s
echo ""

# 测试3: 正确的API Key - 应该转发请求
echo "Test 3: Request with valid API key (should forward to backend)"
echo "curl -H 'x-api-key: cr_test_key_123456789' http://localhost:$PORT/api/v1/test"
curl -H "x-api-key: cr_test_key_123456789" -X GET http://localhost:$PORT/api/v1/test -w "\nStatus: %{http_code}\n" -s
echo ""

# 测试4: Authorization header 格式
echo "Test 4: Request with Authorization Bearer token (should work)"
echo "curl -H 'Authorization: Bearer cr_another_test_key_987654321' http://localhost:$PORT/api/v1/test"
curl -H "Authorization: Bearer cr_another_test_key_987654321" -X GET http://localhost:$PORT/api/v1/test -w "\nStatus: %{http_code}\n" -s
echo ""

# 测试5: 健康检查（不受认证影响）
echo "Test 5: Health check (should work without auth)"
echo "curl http://localhost:$PORT/health"
curl -X GET http://localhost:$PORT/health -w "\nStatus: %{http_code}\n" -s
echo ""

# 清理
echo "Stopping middleware service..."
kill $MIDDLEWARE_PID 2>/dev/null
wait $MIDDLEWARE_PID 2>/dev/null

echo "🎉 Authentication tests completed!"