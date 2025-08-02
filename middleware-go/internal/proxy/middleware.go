package proxy

import (
	"log"
	"github.com/gin-gonic/gin"
	"claude-middleware/internal/redis"
)

// AccountLoggingMiddleware logs account information from context
func AccountLoggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 获取账户信息从context
		if accountID, ok := GetAccountID(c.Request.Context()); ok {
			log.Printf("📝 Request using account ID: %s", accountID)
		}
		
		if account, ok := GetAccount(c.Request.Context()); ok {
			log.Printf("📊 Account details - Name: %s, Status: %s, IsActive: %v", 
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
			log.Printf("📈 Recording usage for account: %s", accountID)
			// 可以添加更新Redis账户最后使用时间的逻辑
		}
	}
}