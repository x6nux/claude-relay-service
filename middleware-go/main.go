package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"claude-middleware/internal/auth"
	"claude-middleware/internal/config"
	"claude-middleware/internal/interceptor"
	"claude-middleware/internal/proxy"
	"claude-middleware/internal/redis"
	"claude-middleware/internal/requestlog"

	"github.com/gin-gonic/gin"
)

func main() {
	// 设置日志级别
	level := strings.ToLower(os.Getenv("LOG_LEVEL"))
	if level == "" {
		level = "info"
	}

	fmt.Printf("[INFO] Log level set to: %s\n", level)

	// 初始化配置
	cfg := config.Load()

	// 打印环境变量配置状态
	fmt.Println("========================================")
	fmt.Println("Claude Middleware Configuration Status")
	fmt.Println("========================================")
	fmt.Printf("Server Port: %d\n", cfg.Server.Port)
	fmt.Printf("Server Mode: %s\n", cfg.Server.Mode)
	if level == "debug" {
		fmt.Printf("Redis Host: %s\n", cfg.Redis.Host)
		fmt.Printf("Redis Port: %d\n", cfg.Redis.Port)
		fmt.Printf("Redis DB: %d\n", cfg.Redis.DB)
		fmt.Printf("Redis Password: %s\n", func() string {
			if cfg.Redis.Password == "" {
				return "(not set)"
			}
			return "****"
		}())
	}
	fmt.Printf("Target URL: %s\n", cfg.Proxy.TargetURL)
	fmt.Printf("Proxy Timeout: %d seconds\n", cfg.Proxy.Timeout)
	fmt.Printf("Request Logging: %v\n", cfg.RequestLog.Enabled)
	if cfg.RequestLog.Enabled {
		fmt.Printf("Log Directory: %s\n", cfg.RequestLog.LogDir)
		fmt.Printf("Max Records per File: %d\n", cfg.RequestLog.MaxRecordsPerFile)
		fmt.Printf("Retention Days: %d\n", cfg.RequestLog.RetentionDays)
	}
	fmt.Println("========================================")

	// 初始化Redis连接
	fmt.Println("Connecting to Redis...")
	redisClient, err := redis.NewClient(cfg.Redis)
	if err != nil {
		fmt.Printf("❌ Failed to connect to Redis: %v\n", err)
		os.Exit(1)
	}
	fmt.Println("✅ Successfully connected to Redis")
	defer redisClient.Close()

	// 初始化代理服务
	proxyService := proxy.NewService(redisClient, cfg)

	// 初始化统计服务处理器
	statsHandler := proxy.NewStatsHandler(redisClient, proxyService)

	// 初始化请求日志记录器
	requestLogger := requestlog.NewRequestLogger(&cfg.RequestLog)

	// 启动定期清理任务
	if cfg.RequestLog.Enabled {
		go func() {
			ticker := time.NewTicker(24 * time.Hour) // 每天清理一次
			defer ticker.Stop()

			for range ticker.C {
				if err := requestLogger.Cleanup(); err != nil {
					fmt.Printf("[ERROR] Failed to cleanup old request logs: %v\n", err)
				}
			}
		}()
	}

	// 初始化认证配置
	authConfig := auth.NewAuthConfig()

	// 初始化请求拦截器（必须启用）
	requestInterceptor := interceptor.CreateRequestInterceptor()

	// 打印认证配置状态
	if level == "debug" {
		fmt.Println("Authentication Configuration:")
		fmt.Printf("Auth Enabled: %v\n", authConfig.Enabled)
		fmt.Printf("API Key Prefix: %s\n", authConfig.Prefix)
	}
	if authConfig.Enabled {
		fmt.Printf("Configured API Keys: %d keys\n", len(authConfig.APIKeys))
		if len(authConfig.APIKeys) > 0 && level == "debug" {
			// 只显示key的前后几个字符
			for i, key := range authConfig.APIKeys {
				if len(key) > 10 {
					fmt.Printf("  Key %d: %s...%s\n", i+1, key[:6], key[len(key)-4:])
				} else {
					fmt.Printf("  Key %d: (too short to display)\n", i+1)
				}
			}
		}
	}
	fmt.Println("========================================")

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

	// 统计API端点（公开访问，不需要认证）
	statsGroup := r.Group("/stats")
	{
		statsGroup.GET("/pages", statsHandler.GetStatsPage)
		statsGroup.GET("", statsHandler.GetStatistics)                    // GET /stats - 获取所有账户统计
		statsGroup.GET("/account/:id", statsHandler.GetAccountStatistics) // GET /stats/account/:id - 获取特定账户统计
	}

	// 创建需要认证的路由组
	api := r.Group("/")
	if authConfig.Enabled {
		fmt.Println("API Key authentication enabled")
		api.Use(auth.AuthMiddleware(authConfig))
	} else {
		fmt.Println("[WARN] API Key authentication disabled")
	}

	// 添加请求拦截器中间件（必须启用，在认证之前）
	fmt.Println("Request interceptor middleware enabled")
	api.Use(requestInterceptor.Middleware())

	// 添加请求日志中间件
	if cfg.RequestLog.Enabled {
		fmt.Println("Request logging middleware enabled")
		api.Use(requestLogger.Middleware())
	}

	// 添加账户日志中间件（可选，用于调试）
	// api.Use(proxy.AccountLoggingMiddleware())
	// api.Use(proxy.AccountMetricsMiddleware(redisClient))

	// 需要认证的统计管理端点
	api.POST("/stats/account/:id/reset", statsHandler.ResetAccountStatistics) // POST /stats/account/:id/reset - 重置账户统计（需要认证）

	// 代理所有请求到Claude API（需要认证）
	api.Any("/v1/*path", proxyService.ProxyHandler)
	api.Any("/api/v1/*path", proxyService.ProxyHandler)
	api.Any("/claude/v1/*path", proxyService.ProxyHandler)
	api.Any("/gemini/*path", proxyService.ProxyHandler)
	api.Any("/openai/gemini/v1/*path", proxyService.ProxyHandler)
	api.Any("/openai/claude/v1/*path", proxyService.ProxyHandler)

	// 启动服务器
	port := strconv.Itoa(cfg.Server.Port)
	fmt.Println("========================================")
	fmt.Printf("🚀 Claude Middleware starting on port %s\n", port)
	fmt.Printf("🎯 Proxying requests to: %s\n", cfg.Proxy.TargetURL)
	fmt.Printf("🔐 Authentication: %s\n", func() string {
		if authConfig.Enabled {
			return "Enabled"
		}
		return "Disabled"
	}())
	fmt.Println("========================================")

	// 创建HTTP服务器
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	// 在后台启动服务器
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("[ERROR] Failed to start server: %v\n", err)
			os.Exit(1)
		}
	}()

	// 等待中断信号以优雅地关闭服务器
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	fmt.Println("🛑 Shutting down server...")

	// 停止请求日志记录器
	if cfg.RequestLog.Enabled {
		fmt.Println("Stopping request logger...")
		requestLogger.Stop()
	}

	// 关闭服务器，等待现有连接完成
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		fmt.Printf("[ERROR] Server forced to shutdown: %v\n", err)
	} else {
		fmt.Println("✅ Server shutdown completed")
	}
}
