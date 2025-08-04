package main

import (
	"strings"
	"time"

	"claude-middleware/internal/interceptor"

	"github.com/gin-gonic/gin"
	"github.com/gophertool/tool/log"
)

// 示例过滤函数：拦截包含特定关键字的请求
func blockKeywordFilter(keywords []string) interceptor.FilterFunc {
	return func(ctx *interceptor.InterceptorContext) bool {
		// 检查URL路径
		for _, keyword := range keywords {
			if strings.Contains(strings.ToLower(ctx.Request.Path), strings.ToLower(keyword)) {
				log.Warnf("Request blocked due to keyword '%s' in path: %s", keyword, ctx.Request.Path)
				return false
			}
		}

		// 检查请求体中的关键字（如果是字符串类型）
		if bodyStr, ok := ctx.Request.Body.(string); ok {
			for _, keyword := range keywords {
				if strings.Contains(strings.ToLower(bodyStr), strings.ToLower(keyword)) {
					log.Warnf("Request blocked due to keyword '%s' in body", keyword)
					return false
				}
			}
		}

		return true
	}
}

// 示例过滤函数：基于IP地址的白名单
func ipWhitelistFilter(allowedIPs []string) interceptor.FilterFunc {
	return func(ctx *interceptor.InterceptorContext) bool {
		clientIP := ctx.Request.ClientIP
		
		// 检查是否在白名单中
		for _, allowedIP := range allowedIPs {
			if clientIP == allowedIP {
				return true
			}
		}
		
		log.Warnf("Request blocked due to IP not in whitelist: %s", clientIP)
		return false
	}
}

// 示例过滤函数：频率限制（简单示例）
func rateLimitFilter(maxRequestsPerMinute int) interceptor.FilterFunc {
	requestCounts := make(map[string][]time.Time)
	
	return func(ctx *interceptor.InterceptorContext) bool {
		clientIP := ctx.Request.ClientIP
		now := time.Now()
		
		// 获取该IP的请求记录
		if requestCounts[clientIP] == nil {
			requestCounts[clientIP] = make([]time.Time, 0)
		}
		
		// 清理一分钟前的记录
		var validRequests []time.Time
		for _, reqTime := range requestCounts[clientIP] {
			if now.Sub(reqTime) < time.Minute {
				validRequests = append(validRequests, reqTime)
			}
		}
		
		// 检查是否超过限制
		if len(validRequests) >= maxRequestsPerMinute {
			log.Warnf("Request blocked due to rate limit for IP %s: %d requests in last minute", 
				clientIP, len(validRequests))
			return false
		}
		
		// 记录当前请求
		validRequests = append(validRequests, now)
		requestCounts[clientIP] = validRequests
		
		return true
	}
}

// 示例过滤函数：请求大小限制
func requestSizeFilter(maxSizeBytes int64) interceptor.FilterFunc {
	return func(ctx *interceptor.InterceptorContext) bool {
		if bodyStr, ok := ctx.Request.Body.(string); ok {
			if int64(len(bodyStr)) > maxSizeBytes {
				log.Warnf("Request blocked due to size limit: %d bytes (max: %d)", 
					len(bodyStr), maxSizeBytes)
				return false
			}
		}
		return true
	}
}

func main() {
	// 创建拦截器，并添加多个过滤函数
	requestInterceptor := interceptor.NewRequestInterceptor(
		interceptor.WithEnabled(true),
		interceptor.WithFilter(blockKeywordFilter([]string{"spam", "abuse", "malicious"})),
		interceptor.WithFilter(rateLimitFilter(100)), // 每分钟最多100个请求
		interceptor.WithFilter(requestSizeFilter(1024*1024)), // 最大1MB
	)

	// 也可以动态添加过滤器
	requestInterceptor.AddFilter(ipWhitelistFilter([]string{
		"127.0.0.1",
		"192.168.1.100",
	}))

	// 创建Gin路由
	r := gin.New()
	
	// 添加拦截器中间件
	r.Use(requestInterceptor.Middleware())
	
	// 其他路由
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok"})
	})

	r.POST("/test", func(c *gin.Context) {
		c.JSON(200, gin.H{"message": "Request passed all filters"})
	})

	log.Infof("Interceptor initialized with %d filters", requestInterceptor.GetFilterCount())
	log.Info("Starting server on :8080")
	r.Run(":8080")
}