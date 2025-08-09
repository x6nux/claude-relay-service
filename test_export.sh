#!/bin/bash

API_KEY="cr_e5a69da7e1baf9d3a65f2805344ea2e82320a975235778243d028af33175bf4d"
BASE_URL="https://ccr.lfree.org"
OUTPUT_FILE="export_result.json"

echo "正在请求 /api/v1/accounts/export 接口..."

# 使用 curl 请求接口并保存结果
curl -s -X GET "${BASE_URL}/api/v1/accounts/export?includeTokens=true" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -o "${OUTPUT_FILE}"

# 检查请求是否成功
if [ $? -eq 0 ]; then
    echo "请求成功！结果已保存到 ${OUTPUT_FILE}"
    echo "文件内容预览："
    cat "${OUTPUT_FILE}"
else
    echo "请求失败！"
    exit 1
fi