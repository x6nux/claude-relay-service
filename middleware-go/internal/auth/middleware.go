package auth

import (
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// AuthConfig 认证配置
type AuthConfig struct {
	// 是否启用认证
	Enabled bool
	// API Keys 列表
	APIKeys []string
	// API Key 前缀
	Prefix string
}

// NewAuthConfig 创建认证配置
func NewAuthConfig() *AuthConfig {
	config := &AuthConfig{
		Enabled: false, // 默认关闭，通过环境变量控制
		Prefix:  "cr_", // 与Node.js服务保持一致
	}

	// 从环境变量读取配置
	if os.Getenv("MIDDLEWARE_AUTH_ENABLED") == "true" {
		config.Enabled = true
	}

	// 从环境变量读取API Keys（逗号分隔）
	if apiKeysEnv := os.Getenv("MIDDLEWARE_API_KEYS"); apiKeysEnv != "" {
		config.APIKeys = strings.Split(apiKeysEnv, ",")
		// 清理空白字符
		for i, key := range config.APIKeys {
			config.APIKeys[i] = strings.TrimSpace(key)
		}
	}

	// 从环境变量读取前缀
	if prefix := os.Getenv("MIDDLEWARE_API_KEY_PREFIX"); prefix != "" {
		config.Prefix = prefix
	}

	return config
}

// AuthMiddleware API Key认证中间件
func AuthMiddleware(config *AuthConfig) gin.HandlerFunc {
	return func(c *gin.Context) {
		// 如果认证未启用，直接通过
		if !config.Enabled {
			c.Next()
			return
		}

		// 如果没有配置API Keys，直接通过
		if len(config.APIKeys) == 0 {
			c.Next()
			return
		}

		// 获取API Key（支持多种Header格式）
		apiKey := extractAPIKey(c)

		if apiKey == "" {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":   "Missing API key",
				"message": "Please provide an API key in the x-api-key header or Authorization header",
			})
			c.Abort()
			return
		}

		// 基本格式验证
		if !isValidAPIKeyFormat(apiKey, config.Prefix) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":   "Invalid API key format",
				"message": "API key format is invalid",
			})
			c.Abort()
			return
		}

		// 验证API Key
		if !validateAPIKey(apiKey, config.APIKeys) {
			c.JSON(http.StatusUnauthorized, gin.H{
				"error":   "Invalid API key",
				"message": "API key is invalid or expired",
			})
			c.Abort()
			return
		}

		// 认证成功，继续处理
		c.Set("authenticated", true)
		c.Set("api_key", apiKey)
		c.Next()
	}
}

// extractAPIKey 从请求中提取API Key
func extractAPIKey(c *gin.Context) string {
	// 尝试从 x-api-key 头获取
	if apiKey := c.GetHeader("x-api-key"); apiKey != "" {
		return apiKey
	}

	// 尝试从 Authorization 头获取（Bearer token）
	if auth := c.GetHeader("Authorization"); auth != "" {
		if strings.HasPrefix(auth, "Bearer ") {
			return strings.TrimPrefix(auth, "Bearer ")
		}
	}

	// 尝试从 api-key 头获取
	if apiKey := c.GetHeader("api-key"); apiKey != "" {
		return apiKey
	}

	return ""
}

// isValidAPIKeyFormat 检查API Key格式是否有效
func isValidAPIKeyFormat(apiKey, prefix string) bool {
	// 检查长度
	if len(apiKey) < 10 || len(apiKey) > 512 {
		return false
	}

	// 检查前缀
	if !strings.HasPrefix(apiKey, prefix) {
		return false
	}

	return true
}

// validateAPIKey 验证API Key是否在允许列表中
func validateAPIKey(apiKey string, allowedKeys []string) bool {
	for _, allowedKey := range allowedKeys {
		if apiKey == allowedKey {
			return true
		}
	}
	return false
}