package main

import (
	"log"
	"net/http"
	"strconv"

	"claude-middleware/internal/config"
	"claude-middleware/internal/proxy"
	"claude-middleware/internal/redis"

	"github.com/gin-gonic/gin"
)

func main() {
	// 初始化配置
	cfg := config.Load()

	// 初始化Redis连接
	redisClient, err := redis.NewClient(cfg.Redis)
	if err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	defer redisClient.Close()

	// 初始化代理服务
	proxyService := proxy.NewService(redisClient, cfg)

	// 设置Gin模式
	if cfg.Server.Mode == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	// 创建路由
	r := gin.New()
	r.Use(gin.Logger())
	r.Use(gin.Recovery())

	// 健康检查
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"service": "claude-middleware",
		})
	})

	// 代理所有请求到Claude API
	r.Any("/v1/*path", proxyService.ProxyHandler)
	r.Any("/api/v1/*path", proxyService.ProxyHandler)
	r.Any("/claude/v1/*path", proxyService.ProxyHandler)
	r.Any("/gemini/*path", proxyService.ProxyHandler)
	r.Any("/openai/gemini/v1/*path", proxyService.ProxyHandler)
	r.Any("/openai/claude/v1/*path", proxyService.ProxyHandler)

	// 启动服务器
	port := strconv.Itoa(cfg.Server.Port)
	log.Printf("Claude Middleware starting on port %s", port)
	log.Printf("Proxying to: %s", cfg.Proxy.TargetURL)

	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
