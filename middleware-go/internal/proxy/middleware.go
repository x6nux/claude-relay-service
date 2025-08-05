package proxy

import (
	"claude-middleware/internal/redis"
	"fmt"
	"github.com/gin-gonic/gin"
)

// AccountLoggingMiddleware logs account information from context
func AccountLoggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 获取账户信息从context
		if accountID, ok := GetAccountID(c.Request.Context()); ok {
			fmt.Printf("[DEBUG] 📝 Request using account ID: %s\n", accountID)
		}
		
		if account, ok := GetAccount(c.Request.Context()); ok {
			fmt.Printf("[DEBUG] 📊 Account details - Name: %s, Status: %s, IsActive: %v\n", 
				account.Name, account.Status, account.IsActive)
		}
		
		c.Next()
	}
}

// AccountMetricsMiddleware tracks account usage metrics
func AccountMetricsMiddleware(redisClient *redis.Client) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 在请求处理后记录使用情况
		c.Next()
		
		// 获取账户ID并更新最后使用时间
		if accountID, ok := GetAccountID(c.Request.Context()); ok {
			// 这里可以更新Redis中的账户使用统计
			fmt.Printf("[DEBUG] 📈 Recording usage for account: %s\n", accountID)
			// 可以添加更新Redis账户最后使用时间的逻辑
		}
	}
}