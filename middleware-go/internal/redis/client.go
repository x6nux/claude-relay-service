package redis

import (
	"context"
	"fmt"
	"strconv"
	"strings"
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
	AccountID    string  `json:"accountId"`    // 对外显示使用ID
	AccountName  string  `json:"accountName"`  // 内部存储使用名称
	RequestCount int64   `json:"requestCount"`
	ErrorCount   int64   `json:"errorCount"`
	ErrorRate    float64 `json:"errorRate"`
	Score        float64 `json:"score"`        // 加权评分
	LastUpdated  int64   `json:"lastUpdated"` // 上次更新时间戳
}

// GetAccountMetricsByName 根据账号名称获取统计指标
func (c *Client) GetAccountMetricsByName(accountName string) (*AccountMetrics, error) {
	key := fmt.Sprintf("middleware:metrics:name:%s", accountName)
	data, err := c.client.HGetAll(c.ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get account metrics: %w", err)
	}
	
	metrics := &AccountMetrics{
		AccountName: accountName,
		AccountID:   "", // 需要后续根据账号名称查找当前ID
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

// GetAccountMetrics 获取账户的统计指标（通过ID，保持向后兼容）
func (c *Client) GetAccountMetrics(accountID string) (*AccountMetrics, error) {
	key := fmt.Sprintf("middleware:metrics:%s", accountID)
	data, err := c.client.HGetAll(c.ctx, key).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get account metrics: %w", err)
	}
	
	metrics := &AccountMetrics{
		AccountID:   accountID, // 使用传入的ID
		AccountName: "",        // 需要后续根据ID查找名称
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

// IncrementRequestCountByName 根据账号名称增加请求计数
func (c *Client) IncrementRequestCountByName(accountName string) error {
	key := fmt.Sprintf("middleware:metrics:name:%s", accountName)
	now := time.Now().Unix()
	
	pipe := c.client.Pipeline()
	pipe.HIncrBy(c.ctx, key, "requestCount", 1)
	pipe.HSet(c.ctx, key, "lastUpdated", now)
	pipe.Expire(c.ctx, key, 30*24*time.Hour) // 30天过期，比ID版本更长
	
	_, err := pipe.Exec(c.ctx)
	return err
}

// IncrementErrorCountByName 根据账号名称增加错误计数
func (c *Client) IncrementErrorCountByName(accountName string) error {
	key := fmt.Sprintf("middleware:metrics:name:%s", accountName)
	now := time.Now().Unix()
	
	pipe := c.client.Pipeline()
	pipe.HIncrBy(c.ctx, key, "errorCount", 1)
	pipe.HSet(c.ctx, key, "lastUpdated", now)
	pipe.Expire(c.ctx, key, 30*24*time.Hour) // 30天过期，比ID版本更长
	
	_, err := pipe.Exec(c.ctx)
	return err
}

// GetAllAccountMetricsByName 获取所有账户的统计指标（按名称存储，但返回时映射到AccountID）
func (c *Client) GetAllAccountMetricsByName() (map[string]*AccountMetrics, error) {
	pattern := "middleware:metrics:name:*"
	keys, err := c.client.Keys(c.ctx, pattern).Result()
	if err != nil {
		return nil, fmt.Errorf("failed to get metric keys: %w", err)
	}
	
	// 获取所有活跃账户信息以建立名称到ID的映射
	accounts, err := c.GetAllActiveAccounts()
	if err != nil {
		return nil, fmt.Errorf("failed to get account information for mapping: %w", err)
	}
	
	// 建立名称到ID和ID到名称的双向映射
	nameToID := make(map[string]string)
	for _, account := range accounts {
		nameToID[account.Name] = account.ID
	}
	
	result := make(map[string]*AccountMetrics) // key仍然是AccountID
	
	for _, key := range keys {
		// 提取账户名称（去掉前缀 "middleware:metrics:name:"）
		accountName := key[len("middleware:metrics:name:"):]
		
		metrics, err := c.GetAccountMetricsByName(accountName)
		if err != nil {
			fmt.Printf("[DEBUG] Failed to get metrics for account %s: %v\n", accountName, err)
			continue
		}
		
		// 查找当前账户ID
		accountID, exists := nameToID[accountName]
		if !exists {
			// 账户可能被删除了，但统计数据仍存在
			fmt.Printf("[DEBUG] Account name %s not found in active accounts, using name as fallback ID\n", accountName)
			accountID = accountName // 使用名称作为fallback
		}
		
		// 设置正确的AccountID
		metrics.AccountID = accountID
		
		// 使用AccountID作为key返回（保持对外API兼容性）
		result[accountID] = metrics
	}
	
	return result, nil
}

// MigrateMetricsFromIDToName 将现有的基于ID的统计数据迁移到基于名称的存储
func (c *Client) MigrateMetricsFromIDToName() error {
	fmt.Println("[INFO] Starting metrics migration from ID-based to name-based storage...")
	
	// 获取所有现有的基于ID的统计数据
	pattern := "middleware:metrics:*"
	keys, err := c.client.Keys(c.ctx, pattern).Result()
	if err != nil {
		return fmt.Errorf("failed to get existing metric keys: %w", err)
	}
	
	// 过滤掉已经是name:*格式的键
	var idBasedKeys []string
	for _, key := range keys {
		if !strings.Contains(key, "middleware:metrics:name:") {
			idBasedKeys = append(idBasedKeys, key)
		}
	}
	
	if len(idBasedKeys) == 0 {
		fmt.Println("[INFO] No ID-based metrics found, migration not needed")
		return nil
	}
	
	fmt.Printf("[INFO] Found %d ID-based metric entries to migrate\n", len(idBasedKeys))
	
	// 获取所有活跃账户信息
	accounts, err := c.GetAllActiveAccounts()
	if err != nil {
		return fmt.Errorf("failed to get account information: %w", err)
	}
	
	// 创建ID到名称的映射
	idToName := make(map[string]string)
	for _, account := range accounts {
		idToName[account.ID] = account.Name
	}
	
	migratedCount := 0
	skippedCount := 0
	
	for _, key := range idBasedKeys {
		// 提取账户ID
		accountID := key[len("middleware:metrics:"):]
		accountName, exists := idToName[accountID]
		
		if !exists {
			fmt.Printf("[WARN] Account ID %s not found in active accounts, skipping\n", accountID)
			skippedCount++
			continue
		}
		
		// 读取现有数据
		oldData, err := c.client.HGetAll(c.ctx, key).Result()
		if err != nil {
			fmt.Printf("[WARN] Failed to read data for %s: %v\n", key, err)
			skippedCount++
			continue
		}
		
		if len(oldData) == 0 {
			fmt.Printf("[DEBUG] No data in %s, skipping\n", key)
			skippedCount++
			continue
		}
		
		// 创建新的基于名称的键
		newKey := fmt.Sprintf("middleware:metrics:name:%s", accountName)
		
		// 检查新键是否已存在，如果存在则合并数据
		existingData, err := c.client.HGetAll(c.ctx, newKey).Result()
		if err != nil {
			fmt.Printf("[WARN] Failed to check existing data for %s: %v\n", newKey, err)
			continue
		}
		
		finalData := make(map[string]interface{})
		
		// 如果新键已存在，合并数据
		if len(existingData) > 0 {
			fmt.Printf("[INFO] Merging data for account %s (%s)\n", accountName, accountID)
			
			// 合并请求数
			oldReqCount, _ := strconv.ParseInt(oldData["requestCount"], 10, 64)
			existingReqCount, _ := strconv.ParseInt(existingData["requestCount"], 10, 64)
			finalData["requestCount"] = oldReqCount + existingReqCount
			
			// 合并错误数
			oldErrCount, _ := strconv.ParseInt(oldData["errorCount"], 10, 64)
			existingErrCount, _ := strconv.ParseInt(existingData["errorCount"], 10, 64)
			finalData["errorCount"] = oldErrCount + existingErrCount
			
			// 使用最新的更新时间
			oldUpdated, _ := strconv.ParseInt(oldData["lastUpdated"], 10, 64)
			existingUpdated, _ := strconv.ParseInt(existingData["lastUpdated"], 10, 64)
			if oldUpdated > existingUpdated {
				finalData["lastUpdated"] = oldUpdated
			} else {
				finalData["lastUpdated"] = existingUpdated
			}
		} else {
			// 直接复制数据
			for k, v := range oldData {
				finalData[k] = v
			}
		}
		
		// 写入新数据
		pipe := c.client.Pipeline()
		for k, v := range finalData {
			pipe.HSet(c.ctx, newKey, k, v)
		}
		pipe.Expire(c.ctx, newKey, 30*24*time.Hour) // 30天过期
		
		if _, err := pipe.Exec(c.ctx); err != nil {
			fmt.Printf("[ERROR] Failed to migrate data for %s: %v\n", accountName, err)
			skippedCount++
			continue
		}
		
		fmt.Printf("[DEBUG] Migrated metrics for %s (%s) -> %s\n", accountName, accountID, newKey)
		migratedCount++
	}
	
	fmt.Printf("[INFO] Migration completed: %d migrated, %d skipped\n", migratedCount, skippedCount)
	
	if migratedCount > 0 {
		fmt.Println("[INFO] You can now safely remove old ID-based metrics using CleanupOldMetrics()")
	}
	
	return nil
}

// CleanupOldMetrics 清理旧的基于ID的统计数据（在确认迁移成功后使用）
func (c *Client) CleanupOldMetrics() error {
	fmt.Println("[WARN] Starting cleanup of old ID-based metrics...")
	
	pattern := "middleware:metrics:*"
	keys, err := c.client.Keys(c.ctx, pattern).Result()
	if err != nil {
		return fmt.Errorf("failed to get metric keys: %w", err)
	}
	
	// 只删除不包含"name:"的键
	var oldKeys []string
	for _, key := range keys {
		if !strings.Contains(key, "middleware:metrics:name:") {
			oldKeys = append(oldKeys, key)
		}
	}
	
	if len(oldKeys) == 0 {
		fmt.Println("[INFO] No old ID-based metrics to cleanup")
		return nil
	}
	
	deletedCount := 0
	for _, key := range oldKeys {
		if err := c.client.Del(c.ctx, key).Err(); err != nil {
			fmt.Printf("[WARN] Failed to delete %s: %v\n", key, err)
		} else {
			deletedCount++
		}
	}
	
	fmt.Printf("[INFO] Cleanup completed: deleted %d old metric entries\n", deletedCount)
	return nil
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