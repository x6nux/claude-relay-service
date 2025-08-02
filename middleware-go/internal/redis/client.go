package redis

import (
	"context"
	"fmt"
	"log"
	"strconv"

	"github.com/redis/go-redis/v9"
	"claude-middleware/internal/config"
)

type Client struct {
	client *redis.Client
	ctx    context.Context
}

type ClaudeAccount struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	IsActive     bool   `json:"isActive"`
	Status       string `json:"status"`
	LastUsedAt   string `json:"lastUsedAt"`
	ExpiresAt    int64  `json:"expiresAt"`
	RateLimited  bool   `json:"rateLimited"`
	RateLimitedAt string `json:"rateLimitedAt"`
}

func NewClient(cfg config.RedisConfig) (*Client, error) {
	rdb := redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%d", cfg.Host, cfg.Port),
		Password: cfg.Password,
		DB:       cfg.DB,
	})
	
	ctx := context.Background()
	
	// 测试连接
	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, fmt.Errorf("failed to ping Redis: %w", err)
	}
	
	return &Client{
		client: rdb,
		ctx:    ctx,
	}, nil
}

func (c *Client) Close() error {
	return c.client.Close()
}

// GetAllActiveAccounts 获取所有活跃的Claude账户（只读操作）
func (c *Client) GetAllActiveAccounts() ([]ClaudeAccount, error) {
	// 修复：使用正确的key前缀 claude:account:*
	pattern := "claude:account:*"
	keys, err := c.client.Keys(c.ctx, pattern).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get account keys: %w", err)
	}
	
	log.Printf("🔍 Searching for accounts with pattern: %s", pattern)
	log.Printf("📋 Found %d keys in Redis", len(keys))
	
	var accounts []ClaudeAccount
	var skippedCount int
	
	for _, key := range keys {
		accountData, err := c.client.HGetAll(c.ctx, key).Result()
		if err != nil {
			log.Printf("⚠️  Error reading account %s: %v", key, err)
			skippedCount++
			continue // 跳过错误的账户
		}
		
		// 解析账户数据
		account, err := c.parseAccountData(accountData)
		if err != nil {
			log.Printf("⚠️  Error parsing account %s: %v", key, err)
			skippedCount++
			continue // 跳过解析失败的账户
		}
		
		// 只返回活跃且状态正常的账户
		if account.IsActive && account.Status != "error" && account.Status != "banned" && account.Status != "oauth_revoked" {
			accounts = append(accounts, account)
		} else {
			log.Printf("⏭️  Skipping account %s: IsActive=%v, Status=%s", account.ID, account.IsActive, account.Status)
			skippedCount++
		}
	}
	
	if skippedCount > 0 {
		log.Printf("ℹ️  Skipped %d accounts (inactive or invalid status)", skippedCount)
	}
	
	return accounts, nil
}

// parseAccountData 解析Redis中的账户数据
func (c *Client) parseAccountData(data map[string]string) (ClaudeAccount, error) {
	account := ClaudeAccount{}
	
	if id, ok := data["id"]; ok {
		account.ID = id
	} else {
		return account, fmt.Errorf("missing account ID")
	}
	
	if name, ok := data["name"]; ok {
		account.Name = name
	}
	
	if isActive, ok := data["isActive"]; ok {
		account.IsActive = isActive == "true"
	}
	
	if status, ok := data["status"]; ok {
		account.Status = status
	}
	
	if lastUsedAt, ok := data["lastUsedAt"]; ok {
		account.LastUsedAt = lastUsedAt
	}
	
	if expiresAt, ok := data["expiresAt"]; ok {
		if exp, err := strconv.ParseInt(expiresAt, 10, 64); err == nil {
			account.ExpiresAt = exp
		}
	}
	
	// 注意：限流状态现在只在内存中管理，不从Redis读取
	// 这里保留字段是为了向后兼容
	if rateLimitStatus, ok := data["rateLimitStatus"]; ok && rateLimitStatus == "limited" {
		if rateLimitedAt, exists := data["rateLimitedAt"]; exists {
			account.RateLimitedAt = rateLimitedAt
			// 但不设置RateLimited状态，因为我们使用内存管理
		}
	}
	
	return account, nil
}