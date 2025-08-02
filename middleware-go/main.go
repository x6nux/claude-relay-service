package main

import (
	"log"
	"net/http"
	"strconv"

	"claude-middleware/internal/auth"
	"claude-middleware/internal/config"
	"claude-middleware/internal/proxy"
	"claude-middleware/internal/redis"

	"github.com/gin-gonic/gin"
)

func main() {
	// 初始化配置
	cfg := config.Load()
	
	// 打印环境变量配置状态
	log.Println("========================================")
	log.Println("Claude Middleware Configuration Status")
	log.Println("========================================")
	log.Printf("Server Port: %d", cfg.Server.Port)
	log.Printf("Server Mode: %s", cfg.Server.Mode)
	log.Printf("Redis Host: %s", cfg.Redis.Host)
	log.Printf("Redis Port: %s", cfg.Redis.Port)
	log.Printf("Redis DB: %d", cfg.Redis.DB)
	log.Printf("Redis Password: %s", func() string {
		if cfg.Redis.Password == "" {
			return "(not set)"
		}
		return "****"
	}())
	log.Printf("Target URL: %s", cfg.Proxy.TargetURL)
	log.Printf("Proxy Timeout: %d seconds", cfg.Proxy.Timeout)
	log.Println("========================================")

	// 初始化Redis连接
	log.Println("Connecting to Redis...")
	redisClient, err := redis.NewClient(cfg.Redis)
	if err != nil {
		log.Fatalf("❌ Failed to connect to Redis: %v", err)
	}
	log.Println("✅ Successfully connected to Redis")
	defer redisClient.Close()

	// 初始化代理服务
	proxyService := proxy.NewService(redisClient, cfg)

	// 初始化认证配置
	authConfig := auth.NewAuthConfig()
	
	// 打印认证配置状态
	log.Println("Authentication Configuration:")
	log.Printf("Auth Enabled: %v", authConfig.Enabled)
	log.Printf("API Key Prefix: %s", authConfig.Prefix)
	if authConfig.Enabled {
		log.Printf("Configured API Keys: %d keys", len(authConfig.APIKeys))
		if len(authConfig.APIKeys) > 0 {
			// 只显示key的前后几个字符
			for i, key := range authConfig.APIKeys {
				if len(key) > 10 {
					log.Printf("  Key %d: %s...%s", i+1, key[:6], key[len(key)-4:])
				} else {
					log.Printf("  Key %d: (too short to display)", i+1)
				}
			}
		}
	}
	log.Println("========================================")

	// 设置Gin模式
	if cfg.Server.Mode == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	// 创建路由
	r := gin.New()
	r.Use(gin.Logger())
	r.Use(gin.Recovery())

	// 健康检查（不需要认证）
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":  "ok",
			"service": "claude-middleware",
		})
	})

	// 创建需要认证的路由组
	api := r.Group("/")
	if authConfig.Enabled {
		log.Printf("API Key authentication enabled")
		api.Use(auth.AuthMiddleware(authConfig))
	} else {
		log.Printf("API Key authentication disabled")
	}
	
	// 添加账户日志中间件（可选，用于调试）
	// api.Use(proxy.AccountLoggingMiddleware())
	// api.Use(proxy.AccountMetricsMiddleware(redisClient))

	// 代理所有请求到Claude API（需要认证）
	api.Any("/v1/*path", proxyService.ProxyHandler)
	api.Any("/api/v1/*path", proxyService.ProxyHandler)
	api.Any("/claude/v1/*path", proxyService.ProxyHandler)
	api.Any("/gemini/*path", proxyService.ProxyHandler)
	api.Any("/openai/gemini/v1/*path", proxyService.ProxyHandler)
	api.Any("/openai/claude/v1/*path", proxyService.ProxyHandler)

	// 启动服务器
	port := strconv.Itoa(cfg.Server.Port)
	log.Println("========================================")
	log.Printf("🚀 Claude Middleware starting on port %s", port)
	log.Printf("🎯 Proxying requests to: %s", cfg.Proxy.TargetURL)
	log.Printf("🔐 Authentication: %s", func() string {
		if authConfig.Enabled {
			return "Enabled"
		}
		return "Disabled"
	}())
	log.Println("========================================")

	if err := r.Run(":" + port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
