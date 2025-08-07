package redis

import (
	"context"
	"fmt"
	"strconv"
	"time"

	"claude-middleware/internal/config"
	"github.com/redis/go-redis/v9"
)

type Client struct {
	client *redis.Client
	ctx    context.Context
}

type ClaudeAccount struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	IsActive     bool   `json:"isActive"`
	IsMAX        bool   `json:"isMAX"`        // MAX账号标识
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
	
	fmt.Printf("[DEBUG] 🔍 Searching for accounts with pattern: %s\n", pattern)
	fmt.Printf("[DEBUG] 📋 Found %d keys in Redis\n", len(keys))
	
	var accounts []ClaudeAccount
	var skippedCount int
	
	for _, key := range keys {
		accountData, err := c.client.HGetAll(c.ctx, key).Result()
		if err != nil {
			fmt.Printf("[DEBUG] ⚠️  Error reading account %s: %v\n", key, err)
			skippedCount++
			continue // 跳过错误的账户
		}
		
		// 解析账户数据
		account, err := c.parseAccountData(accountData)
		if err != nil {
			fmt.Printf("[DEBUG] ⚠️  Error parsing account %s: %v\n", key, err)
			skippedCount++
			continue // 跳过解析失败的账户
		}
		
		// 只返回活跃且状态正常的账户
		if account.IsActive && account.Status != "error" && account.Status != "banned" && account.Status != "oauth_revoked" {
			accounts = append(accounts, account)
		} else {
			fmt.Printf("[DEBUG] ⏭️  Skipping account %s: IsActive=%v, Status=%s\n", account.ID, account.IsActive, account.Status)
			skippedCount++
		}
	}
	
	if skippedCount > 0 {
		fmt.Printf("[DEBUG] ℹ️  Skipped %d accounts (inactive or invalid status)\n", skippedCount)
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
	
	// 解析 IsMAX 字段，支持从 Redis 读取和基于名称自动判断
	if isMAX, ok := data["isMAX"]; ok {
		account.IsMAX = isMAX == "true"
	} else {
		// 如果 Redis 中没有 isMAX 字段，基于账号名称自动判断
		// 账号名称以 "MAX" 开头的视为 MAX 账号
		if account.Name != "" && len(account.Name) >= 3 {
			account.IsMAX = account.Name[:3] == "MAX"
		}
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

// AccountMetrics represents metrics for an account
type AccountMetrics struct {
	AccountID    string  `json:"accountId"`
	RequestCount int64   `json:"requestCount"`
	ErrorCount   int64   `json:"errorCount"`
	ErrorRate    float64 `json:"errorRate"`
	Score        float64 `json:"score"`        // 加权评分
	LastUpdated  int64   `json:"lastUpdated"` // 上次更新时间戳
}

// GetAccountMetrics 获取账户的统计指标
func (c *Client) GetAccountMetrics(accountID string) (*AccountMetrics, error) {
	key := fmt.Sprintf("middleware:metrics:%s", accountID)
	data, err := c.client.HGetAll(c.ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get account metrics: %w", err)
	}
	
	metrics := &AccountMetrics{
		AccountID: accountID,
	}
	
	if len(data) == 0 {
		// 新账户，返回默认值
		return metrics, nil
	}
	
	if reqCount, ok := data["requestCount"]; ok {
		if count, err := strconv.ParseInt(reqCount, 10, 64); err == nil {
			metrics.RequestCount = count
		}
	}
	
	if errCount, ok := data["errorCount"]; ok {
		if count, err := strconv.ParseInt(errCount, 10, 64); err == nil {
			metrics.ErrorCount = count
		}
	}
	
	if lastUpdated, ok := data["lastUpdated"]; ok {
		if ts, err := strconv.ParseInt(lastUpdated, 10, 64); err == nil {
			metrics.LastUpdated = ts
		}
	}
	
	// 计算错误率
	if metrics.RequestCount > 0 {
		metrics.ErrorRate = float64(metrics.ErrorCount) / float64(metrics.RequestCount)
	}
	
	return metrics, nil
}

// IncrementRequestCount 增加账户的请求计数
func (c *Client) IncrementRequestCount(accountID string) error {
	key := fmt.Sprintf("middleware:metrics:%s", accountID)
	now := time.Now().Unix()
	
	pipe := c.client.Pipeline()
	pipe.HIncrBy(c.ctx, key, "requestCount", 1)
	pipe.HSet(c.ctx, key, "lastUpdated", now)
	pipe.Expire(c.ctx, key, 7*24*time.Hour) // 7天过期
	
	_, err := pipe.Exec(c.ctx)
	return err
}

// IncrementErrorCount 增加账户的错误计数
func (c *Client) IncrementErrorCount(accountID string) error {
	key := fmt.Sprintf("middleware:metrics:%s", accountID)
	now := time.Now().Unix()
	
	pipe := c.client.Pipeline()
	pipe.HIncrBy(c.ctx, key, "errorCount", 1)
	pipe.HSet(c.ctx, key, "lastUpdated", now)
	pipe.Expire(c.ctx, key, 7*24*time.Hour) // 7天过期
	
	_, err := pipe.Exec(c.ctx)
	return err
}

// InitializeAccountMetrics 初始化账户的统计指标（用于新账号）
func (c *Client) InitializeAccountMetrics(accountID string) error {
	key := fmt.Sprintf("middleware:metrics:%s", accountID)
	now := time.Now().Unix()
	
	// 检查是否已存在
	exists, err := c.client.Exists(c.ctx, key).Result()
	if err != nil {
		return fmt.Errorf("failed to check metrics existence: %w", err)
	}
	
	// 如果已存在，不覆盖
	if exists > 0 {
		return nil
	}
	
	// 创建初始统计记录
	pipe := c.client.Pipeline()
	pipe.HSet(c.ctx, key, "requestCount", 0)
	pipe.HSet(c.ctx, key, "errorCount", 0)
	pipe.HSet(c.ctx, key, "lastUpdated", now)
	pipe.Expire(c.ctx, key, 7*24*time.Hour) // 7天过期
	
	_, err = pipe.Exec(c.ctx)
	if err != nil {
		return fmt.Errorf("failed to initialize account metrics: %w", err)
	}
	
	fmt.Printf("[INFO] ✅ Initialized metrics for new account: %s\n", accountID)
	return nil
}

// GetAllAccountMetrics 获取所有账户的统计指标
func (c *Client) GetAllAccountMetrics() (map[string]*AccountMetrics, error) {
	pattern := "middleware:metrics:*"
	keys, err := c.client.Keys(c.ctx, pattern).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get metric keys: %w", err)
	}
	
	result := make(map[string]*AccountMetrics)
	
	for _, key := range keys {
		// 提取账户ID（去掉前缀 "middleware:metrics:"）
		accountID := key[len("middleware:metrics:"):]
		
		metrics, err := c.GetAccountMetrics(accountID)
		if err != nil {
			fmt.Printf("[DEBUG] Failed to get metrics for account %s: %v\n", accountID, err)
			continue
		}
		
		result[accountID] = metrics
	}
	
	return result, nil
}

// DeleteKey deletes a key from Redis
func (c *Client) DeleteKey(key string) error {
	return c.client.Del(c.ctx, key).Err()
}

// SetAccountRateLimit 设置账户限流状态，带过期时间
func (c *Client) SetAccountRateLimit(accountID string, duration time.Duration) error {
	key := fmt.Sprintf("middleware:ratelimit:%s", accountID)
	return c.client.SetEx(c.ctx, key, "limited", duration).Err()
}

// IsAccountRateLimited 检查账户是否被限流
func (c *Client) IsAccountRateLimited(accountID string) (bool, error) {
	key := fmt.Sprintf("middleware:ratelimit:%s", accountID)
	exists, err := c.client.Exists(c.ctx, key).Result()
	return exists > 0, err
}

// ClearAccountRateLimit 清除账户限流状态
func (c *Client) ClearAccountRateLimit(accountID string) error {
	key := fmt.Sprintf("middleware:ratelimit:%s", accountID)
	return c.client.Del(c.ctx, key).Err()
}

// SetAccountProblematic 设置账户问题状态，带过期时间
func (c *Client) SetAccountProblematic(accountID string, duration time.Duration) error {
	key := fmt.Sprintf("middleware:problematic:%s", accountID)
	return c.client.SetEx(c.ctx, key, "problematic", duration).Err()
}

// IsAccountProblematic 检查账户是否有问题
func (c *Client) IsAccountProblematic(accountID string) (bool, error) {
	key := fmt.Sprintf("middleware:problematic:%s", accountID)
	exists, err := c.client.Exists(c.ctx, key).Result()
	return exists > 0, err
}

// ClearAccountProblematic 清除账户问题状态
func (c *Client) ClearAccountProblematic(accountID string) error {
	key := fmt.Sprintf("middleware:problematic:%s", accountID)
	return c.client.Del(c.ctx, key).Err()
}