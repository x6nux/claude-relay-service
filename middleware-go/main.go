package main

import (
	"context"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"claude-middleware/internal/auth"
	"claude-middleware/internal/config"
	"claude-middleware/internal/proxy"
	"claude-middleware/internal/redis"
	"claude-middleware/internal/requestlog"

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
	log.Infof("Request Logging: %v", cfg.RequestLog.Enabled)
	if cfg.RequestLog.Enabled {
		log.Infof("Log Directory: %s", cfg.RequestLog.LogDir)
		log.Infof("Max Records per File: %d", cfg.RequestLog.MaxRecordsPerFile)
		log.Infof("Retention Days: %d", cfg.RequestLog.RetentionDays)
	}
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

	// 初始化请求日志记录器
	requestLogger := requestlog.NewRequestLogger(&cfg.RequestLog)

	// 启动定期清理任务
	if cfg.RequestLog.Enabled {
		go func() {
			ticker := time.NewTicker(24 * time.Hour) // 每天清理一次
			defer ticker.Stop()
			
			for range ticker.C {
				if err := requestLogger.Cleanup(); err != nil {
					log.Errorf("Failed to cleanup old request logs: %v", err)
				}
			}
		}()
	}

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

	// 添加请求日志中间件
	if cfg.RequestLog.Enabled {
		log.Info("Request logging middleware enabled")
		api.Use(requestLogger.Middleware())
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

	// 创建HTTP服务器
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	// 在后台启动服务器
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Errorf("Failed to start server: %v", err)
			os.Exit(1)
		}
	}()

	// 等待中断信号以优雅地关闭服务器
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit

	log.Info("🛑 Shutting down server...")

	// 停止请求日志记录器
	if cfg.RequestLog.Enabled {
		log.Info("Stopping request logger...")
		requestLogger.Stop()
	}

	// 关闭服务器，等待现有连接完成
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Errorf("Server forced to shutdown: %v", err)
	} else {
		log.Info("✅ Server shutdown completed")
	}
}
