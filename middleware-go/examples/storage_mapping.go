// 数据存储和显示映射示例
// 这个文件展示了内部按名称存储、对外按ID显示的机制

package main

import (
	"fmt"
)

func main() {
	fmt.Println("=== 账号统计数据存储映射机制 ===")
	fmt.Println()
	
	fmt.Println("📊 内部存储（Redis中的实际key）：")
	fmt.Println("   middleware:metrics:name:Claude-Main")
	fmt.Println("   middleware:metrics:name:Claude-Backup") 
	fmt.Println("   middleware:metrics:name:MAX-Account1")
	fmt.Println()
	
	fmt.Println("🔄 账号重建场景：")
	fmt.Println("   1. 原账号ID: acc_12345 名称: Claude-Main")
	fmt.Println("   2. 删除账号后，统计数据保留在: middleware:metrics:name:Claude-Main")
	fmt.Println("   3. 重新创建账号ID: acc_67890 名称: Claude-Main（名称相同）")
	fmt.Println("   4. 新账号自动继承历史统计数据")
	fmt.Println()
	
	fmt.Println("📈 对外API响应（stats显示）：")
	fmt.Println("   {")
	fmt.Println("     \"acc_67890\": {")
	fmt.Println("       \"accountId\": \"acc_67890\",      // 显示当前ID")
	fmt.Println("       \"accountName\": \"Claude-Main\",   // 内部存储key")
	fmt.Println("       \"requestCount\": 1500,            // 历史数据+新数据")
	fmt.Println("       \"errorCount\": 23")
	fmt.Println("     }")
	fmt.Println("   }")
	fmt.Println()
	
	fmt.Println("✅ 优势：")
	fmt.Println("   - Stats显示仍使用账号ID，保持兼容性")
	fmt.Println("   - 内部按账号名称存储，账号重建不丢失历史数据")
	fmt.Println("   - 自动映射机制，无需手动干预")
	fmt.Println("   - 解决了内存泄漏问题（缓存迁移到Redis）")
}