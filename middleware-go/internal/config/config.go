package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Server      ServerConfig
	Redis       RedisConfig
	Proxy       ProxyConfig
	RequestLog  RequestLogConfig
}

type ServerConfig struct {
	Port int
	Mode string
}

type RedisConfig struct {
	Host     string
	Port     int
	Password string
	DB       int
}

type ProxyConfig struct {
	TargetURL string
	Timeout   int // seconds
}

type RequestLogConfig struct {
	Enabled           bool
	LogDir            string
	MaxRecordsPerFile int
	RetentionDays     int
}

func Load() *Config {
	return &Config{
		Server: ServerConfig{
			Port: getEnvInt("PORT", 8080),
			Mode: getEnv("GIN_MODE", "debug"),
		},
		Redis: RedisConfig{
			Host:     getEnv("REDIS_HOST", "localhost"),
			Port:     getEnvInt("REDIS_PORT", 6379),
			Password: getEnv("REDIS_PASSWORD", ""),
			DB:       getEnvInt("REDIS_DB", 0),
		},
		Proxy: ProxyConfig{
			TargetURL: getEnv("TARGET_URL", "http://localhost:3001"),
			Timeout:   getEnvInt("PROXY_TIMEOUT", 300),
		},
		RequestLog: RequestLogConfig{
			Enabled:           getEnvBool("REQUEST_LOGGING_ENABLED", false),
			LogDir:            getEnv("REQUEST_LOG_DIR", "data/request-logs"),
			MaxRecordsPerFile: getEnvInt("REQUEST_LOG_MAX_RECORDS", 1000),
			RetentionDays:     getEnvInt("REQUEST_LOG_RETENTION_DAYS", 30),
		},
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value := os.Getenv(key); value != "" {
		switch strings.ToLower(value) {
		case "true", "1", "yes", "on":
			return true
		case "false", "0", "no", "off":
			return false
		}
	}
	return defaultValue
}