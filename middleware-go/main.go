package main

import (
	"net/http"
	"os"
	"strconv"
	"strings"

	"claude-middleware/internal/auth"
	"claude-middleware/internal/config"
	"claude-middleware/internal/proxy"
	"claude-middleware/internal/redis"

	"github.com/gin-gonic/gin"
	"github.com/gophertool/tool/log"
)

func main() {
	// 设置日志级别
	level := strings.ToLower(os.Getenv("LOG_LEVEL"))
	if level == "" {
		level = "info"
	}
	
	switch level {
	case "debug":
		log.SetLevel(log.DEBUG)
	case "info":
		log.SetLevel(log.INFO)
	case "warn", "warning":
		log.SetLevel(log.WARN)
	case "error":
		log.SetLevel(log.ERROR)
	default:
		log.SetLevel(log.INFO)
	}

	// 初始化配置
	cfg := config.Load()

	// 打印环境变量配置状态
	log.Info("========================================")
	log.Info("Claude Middleware Configuration Status")
	log.Info("========================================")
	log.Infof("Server Port: %d", cfg.Server.Port)
	log.Infof("Server Mode: %s", cfg.Server.Mode)
	log.Debugf("Redis Host: %s", cfg.Redis.Host)
	log.Debugf("Redis Port: %d", cfg.Redis.Port)
	log.Debugf("Redis DB: %d", cfg.Redis.DB)
	log.Debugf("Redis Password: %s", func() string {
		if cfg.Redis.Password == "" {
			return "(not set)"
		}
		return "****"
	}())
	log.Infof("Target URL: %s", cfg.Proxy.TargetURL)
	log.Infof("Proxy Timeout: %d seconds", cfg.Proxy.Timeout)
	log.Info("========================================")

	// 初始化Redis连接
	log.Info("Connecting to Redis...")
	redisClient, err := redis.NewClient(cfg.Redis)
	if err != nil {
		log.Errorf("❌ Failed to connect to Redis: %v", err)
		os.Exit(1)
	}
	log.Info("✅ Successfully connected to Redis")
	defer redisClient.Close()

	// 初始化代理服务
	proxyService := proxy.NewService(redisClient, cfg)

	// 初始化认证配置
	authConfig := auth.NewAuthConfig()

	// 打印认证配置状态
	log.Debug("Authentication Configuration:")
	log.Debugf("Auth Enabled: %v", authConfig.Enabled)
	log.Debugf("API Key Prefix: %s", authConfig.Prefix)
	if authConfig.Enabled {
		log.Infof("Configured API Keys: %d keys", len(authConfig.APIKeys))
		if len(authConfig.APIKeys) > 0 {
			// 只显示key的前后几个字符
			for i, key := range authConfig.APIKeys {
				if len(key) > 10 {
					log.Debugf("  Key %d: %s...%s", i+1, key[:6], key[len(key)-4:])
				} else {
					log.Debugf("  Key %d: (too short to display)", i+1)
				}
			}
		}
	}
	log.Info("========================================")

	// 设置Gin模式
	if cfg.Server.Mode == "production" {
		gin.SetMode(gin.ReleaseMode)
	}

	// 创建路由
	r := gin.New()
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
		log.Info("API Key authentication enabled")
		api.Use(auth.AuthMiddleware(authConfig))
	} else {
		log.Warn("API Key authentication disabled")
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
	log.Info("========================================")
	log.Infof("🚀 Claude Middleware starting on port %s", port)
	log.Infof("🎯 Proxying requests to: %s", cfg.Proxy.TargetURL)
	log.Infof("🔐 Authentication: %s", func() string {
		if authConfig.Enabled {
			return "Enabled"
		}
		return "Disabled"
	}())
	log.Info("========================================")

	if err := r.Run(":" + port); err != nil {
		log.Errorf("Failed to start server: %v", err)
		os.Exit(1)
	}
}
