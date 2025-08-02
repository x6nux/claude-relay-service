package config

import (
	"os"
	"strconv"
)

type Config struct {
	Server ServerConfig
	Redis  RedisConfig
	Proxy  ProxyConfig
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