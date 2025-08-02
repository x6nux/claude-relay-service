#!/bin/bash

# Redis账户获取测试脚本

echo "🔍 Testing Redis Account Fetching in Go Middleware"
echo "================================================"

# 设置环境变量
export REDIS_HOST="localhost"
export REDIS_PORT="6379"
export TARGET_URL="http://localhost:3001"
export GIN_MODE="debug"

echo "Environment variables:"
echo "  REDIS_HOST=$REDIS_HOST"
echo "  REDIS_PORT=$REDIS_PORT"
echo ""

# 先检查Redis中是否有账户数据
echo "Checking Redis for Claude accounts..."
redis-cli KEYS "claude:account:*" | head -10

echo ""
echo "Checking account details..."
# 获取第一个账户的详细信息
FIRST_ACCOUNT=$(redis-cli KEYS "claude:account:*" | head -1 | tr -d '"')
if [ -n "$FIRST_ACCOUNT" ]; then
    echo "First account key: $FIRST_ACCOUNT"
    redis-cli HGETALL "$FIRST_ACCOUNT" | head -20
else
    echo "No accounts found in Redis!"
fi

echo ""
echo "Starting middleware to test account loading..."

# 创建一个简单的测试日志文件
LOG_FILE="test-redis.log"

# 启动中间层并记录日志
timeout 5s ./claude-middleware > "$LOG_FILE" 2>&1 &

# 等待服务启动
sleep 2

# 检查日志中的账户加载信息
echo ""
echo "Checking logs for account loading..."
if [ -f "$LOG_FILE" ]; then
    grep -E "account|Account|redis|Redis" "$LOG_FILE" | head -20
    rm -f "$LOG_FILE"
else
    echo "No log file found"
fi

echo ""
echo "🎉 Redis account test completed!"