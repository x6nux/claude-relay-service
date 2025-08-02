package proxy

import (
	"bytes"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"claude-middleware/internal/config"
	"claude-middleware/internal/redis"
)

type Service struct {
	redisClient *redis.Client
	config      *config.Config
	targetURL   *url.URL
	httpClient  *http.Client
	
	// 账户状态标记（仅内存，不写入Redis）
	rateLimitedCache  map[string]time.Time  // accountID -> 限流结束时间
	problematicCache  map[string]time.Time  // accountID -> 问题恢复时间
	rateLimitMutex    sync.RWMutex
}

func NewService(redisClient *redis.Client, cfg *config.Config) *Service {
	targetURL, err := url.Parse(cfg.Proxy.TargetURL)
	if err != nil {
		log.Fatalf("Invalid target URL: %v", err)
	}
	
	service := &Service{
		redisClient:      redisClient,
		config:          cfg,
		targetURL:       targetURL,
		rateLimitedCache: make(map[string]time.Time),
		problematicCache: make(map[string]time.Time),
		httpClient: &http.Client{
			Timeout: time.Duration(cfg.Proxy.Timeout) * time.Second,
		},
	}
	
	return service
}

// ProxyHandler 处理所有代理请求
func (s *Service) ProxyHandler(c *gin.Context) {
	// 记录请求路径
	requestPath := c.Request.URL.Path
	log.Printf("Processing request: %s %s", c.Request.Method, requestPath)
	
	// 选择可用的Claude账户ID
	accountID, err := s.selectAvailableAccount()
	if err != nil {
		log.Printf("Failed to select account for %s: %v", requestPath, err)
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "No available Claude accounts"})
		return
	}
	
	log.Printf("Selected account %s for %s", accountID, requestPath)
	
	// 获取账户详细信息并存储到context
	accounts, err := s.redisClient.GetAllActiveAccounts()
	if err != nil {
		log.Printf("Failed to get account details: %v", err)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to retrieve account information"})
		return
	}
	
	var selectedAccount *redis.ClaudeAccount
	for _, acc := range accounts {
		if acc.ID == accountID {
			selectedAccount = &acc
			break
		}
	}
	
	if selectedAccount == nil {
		log.Printf("Account %s not found in active accounts", accountID)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Selected account not found"})
		return
	}
	
	// 将账户信息存储到context
	ctx := WithAccount(c.Request.Context(), *selectedAccount)
	ctx = WithAccountID(ctx, accountID)
	c.Request = c.Request.WithContext(ctx)
	
	// 读取请求体
	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Failed to read request body"})
		return
	}
	
	// 重新设置请求体，以便后续使用
	c.Request.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	
	// 创建目标URL
	targetURL := *s.targetURL
	targetURL.Path = c.Request.URL.Path
	targetURL.RawQuery = c.Request.URL.RawQuery
	
	// 创建新的请求
	proxyReq, err := http.NewRequest(c.Request.Method, targetURL.String(), bytes.NewReader(bodyBytes))
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to create proxy request"})
		return
	}
	
	// 复制原始请求头，并设置x-api-key为账户ID
	for key, values := range c.Request.Header {
		if strings.ToLower(key) == "x-api-key" {
			// 替换x-api-key为账户ID
			proxyReq.Header.Set("x-api-key", accountID)
		} else if strings.ToLower(key) != "host" {
			// 复制其他请求头（除了host）
			for _, value := range values {
				proxyReq.Header.Add(key, value)
			}
		}
	}
	
	// 如果原始请求没有x-api-key，添加一个
	if proxyReq.Header.Get("x-api-key") == "" {
		proxyReq.Header.Set("x-api-key", accountID)
	}
	
	// 设置正确的Host
	proxyReq.Host = s.targetURL.Host
	
	// 发送请求
	resp, err := s.httpClient.Do(proxyReq)
	if err != nil {
		log.Printf("Proxy request failed for account %s on %s: %v", accountID, requestPath, err)
		
		// 标记账户为有问题的账户
		s.markAccountAsProblematic(accountID, "network_error")
		
		// 如果请求失败，可能是账户问题，尝试其他账户
		if retryAccountID, retryErr := s.selectAvailableAccountExcluding(accountID); retryErr == nil {
			log.Printf("Retrying %s with different account: %s", requestPath, retryAccountID)
			
			// 重新创建请求
			retryReq, _ := http.NewRequest(c.Request.Method, targetURL.String(), bytes.NewReader(bodyBytes))
			for key, values := range c.Request.Header {
				if strings.ToLower(key) == "x-api-key" {
					retryReq.Header.Set("x-api-key", retryAccountID)
				} else if strings.ToLower(key) != "host" {
					for _, value := range values {
						retryReq.Header.Add(key, value)
					}
				}
			}
			if retryReq.Header.Get("x-api-key") == "" {
				retryReq.Header.Set("x-api-key", retryAccountID)
			}
			retryReq.Host = s.targetURL.Host
			
			// 重试请求
			if retryResp, retryErr := s.httpClient.Do(retryReq); retryErr == nil {
				// 检查重试响应是否成功
				if s.isSuccessResponse(retryResp.StatusCode) {
					s.handleResponse(c, retryResp, retryAccountID, requestPath)
					return
				} else {
					// 重试也失败，标记第二个账户也有问题
					log.Printf("Retry also failed with status %d for account %s on %s", retryResp.StatusCode, retryAccountID, requestPath)
					s.markAccountAsProblematic(retryAccountID, fmt.Sprintf("http_error_%d", retryResp.StatusCode))
					s.handleResponse(c, retryResp, retryAccountID, requestPath)
					return
				}
			}
		}
		
		c.JSON(http.StatusBadGateway, gin.H{
			"error": "Proxy request failed"})
		return
	}
	
	// 检查响应状态码是否表示成功
	if !s.isSuccessResponse(resp.StatusCode) {
		log.Printf("Account %s returned error status %d on %s", accountID, resp.StatusCode, requestPath)
		
		// 对于某些错误状态码，标记账户为有问题
		if s.shouldMarkAccountAsProblematic(resp.StatusCode) {
			s.markAccountAsProblematic(accountID, fmt.Sprintf("http_error_%d", resp.StatusCode))
			
			// 尝试使用其他账户重试
			if retryAccountID, retryErr := s.selectAvailableAccountExcluding(accountID); retryErr == nil {
				log.Printf("Retrying %s with different account due to status %d: %s", requestPath, resp.StatusCode, retryAccountID)
				
				// 重新创建请求
				retryReq, _ := http.NewRequest(c.Request.Method, targetURL.String(), bytes.NewReader(bodyBytes))
				for key, values := range c.Request.Header {
					if strings.ToLower(key) == "x-api-key" {
						retryReq.Header.Set("x-api-key", retryAccountID)
					} else if strings.ToLower(key) != "host" {
						for _, value := range values {
							retryReq.Header.Add(key, value)
						}
					}
				}
				if retryReq.Header.Get("x-api-key") == "" {
					retryReq.Header.Set("x-api-key", retryAccountID)
				}
				retryReq.Host = s.targetURL.Host
				
				// 重试请求
				retryResp, retryErr2 := s.httpClient.Do(retryReq)
				if retryErr2 == nil {
					s.handleResponse(c, retryResp, retryAccountID, requestPath)
					return
				} else {
					// 重试请求也失败了
					log.Printf("❌ Retry request also failed: %v", retryErr2)
				}
			} else {
				// 无法找到可用账户重试
				log.Printf("⚠️  No available accounts for retry: %v", retryErr)
				// 如果是429错误且无法重试，返回503服务不可用
				if resp.StatusCode == 429 {
					c.JSON(http.StatusServiceUnavailable, gin.H{
						"error": "All accounts are rate limited",
						"message": "Service temporarily unavailable, please try again later",
					})
					return
				}
			}
		}
	}
	
	s.handleResponse(c, resp, accountID, requestPath)
}

// handleResponse 处理响应
func (s *Service) handleResponse(c *gin.Context, resp *http.Response, accountID string, requestPath string) {
	defer resp.Body.Close()
	
	// 检查是否是限流响应
	switch resp.StatusCode {
	case 429:
		log.Printf("Account %s is rate limited on %s", accountID, requestPath)
		s.markAccountRateLimited(accountID)
	case 200, 201:
		// 记录成功，但不更新Redis
		log.Printf("Successfully processed %s with account %s", requestPath, accountID)
	default:
		log.Printf("Response %d for %s with account %s", resp.StatusCode, requestPath, accountID)
	}
	
	// 复制响应头
	for key, values := range resp.Header {
		for _, value := range values {
			c.Header(key, value)
		}
	}
	
	// 设置状态码
	c.Status(resp.StatusCode)
	
	// 复制响应体
	if _, err := io.Copy(c.Writer, resp.Body); err != nil {
		log.Printf("Failed to copy response body for %s: %v", requestPath, err)
	}
}

// isSuccessResponse 判断响应状态码是否表示成功
func (s *Service) isSuccessResponse(statusCode int) bool {
	return statusCode >= 200 && statusCode < 300
}

// shouldMarkAccountAsProblematic 判断是否应该因为此状态码标记账户为有问题
func (s *Service) shouldMarkAccountAsProblematic(statusCode int) bool {
	switch statusCode {
	case 401: // Unauthorized - 可能是token问题
		return true
	case 403: // Forbidden - 可能是账户权限问题
		return true
	case 429: // Rate Limited - 限流
		return true
	case 500, 502, 503, 504: // 服务器错误 - 可能是账户相关问题
		return true
	default:
		return false
	}
}

// markAccountAsProblematic 标记账户为有问题的账户（仅内存）
func (s *Service) markAccountAsProblematic(accountID string, reason string) {
	now := time.Now()
	
	// 所有异常统一限流5分钟
	disableDuration := 5 * time.Minute
	
	// 如果是429错误，同时标记为限流
	if strings.Contains(reason, "429") {
		s.markAccountRateLimited(accountID)
	}
	
	s.rateLimitMutex.Lock()
	s.problematicCache[accountID] = now.Add(disableDuration)
	s.rateLimitMutex.Unlock()
	
	log.Printf("🚫 Marked account %s as problematic (reason: %s, duration: %v)", accountID, reason, disableDuration)
}

// isAccountProblematic 检查账户是否被标记为有问题（仅内存）
func (s *Service) isAccountProblematic(accountID string) bool {
	s.rateLimitMutex.RLock()
	disabledUntil, exists := s.problematicCache[accountID]
	s.rateLimitMutex.RUnlock()
	
	if !exists {
		return false
	}
	
	if time.Now().After(disabledUntil) {
		// 禁用期已过，移除标记
		s.rateLimitMutex.Lock()
		delete(s.problematicCache, accountID)
		s.rateLimitMutex.Unlock()
		return false
	}
	
	return true
}
func (s *Service) selectAvailableAccount() (string, error) {
	return s.selectAvailableAccountExcluding("")
}

// selectAvailableAccountExcluding 选择可用的账户，排除指定账户
func (s *Service) selectAvailableAccountExcluding(excludeAccountID string) (string, error) {
	// 每次请求时从Redis获取账户
	accounts, err := s.redisClient.GetAllActiveAccounts()
	if err != nil {
		return "", fmt.Errorf("failed to fetch accounts from Redis: %w", err)
	}
	
	if len(accounts) == 0 {
		return "", fmt.Errorf("no active accounts available")
	}
	
	log.Printf("🔍 Searching for alternative account (excluding %s), total accounts: %d", excludeAccountID, len(accounts))
	
	// 过滤掉被排除的账户、限流账户和有问题的账户
	var availableAccounts []redis.ClaudeAccount
	var rateLimitedAccounts []redis.ClaudeAccount
	var problematicAccounts []redis.ClaudeAccount
	
	for _, account := range accounts {
		if account.ID == excludeAccountID {
			log.Printf("   ⏭️  Skipping excluded account: %s", account.ID)
			continue
		}
		
		isRateLimited := s.isAccountRateLimited(account.ID)
		isProblematic := s.isAccountProblematic(account.ID)
		
		if isProblematic {
			problematicAccounts = append(problematicAccounts, account)
			log.Printf("   ❌ Account %s is problematic", account.ID)
		} else if isRateLimited {
			rateLimitedAccounts = append(rateLimitedAccounts, account)
			log.Printf("   ⏱️  Account %s is rate limited", account.ID)
		} else {
			availableAccounts = append(availableAccounts, account)
			log.Printf("   ✅ Account %s is available", account.ID)
		}
	}
	
	log.Printf("📊 Account status: %d available, %d rate-limited, %d problematic", 
		len(availableAccounts), len(rateLimitedAccounts), len(problematicAccounts))
	
	// 优先使用完全可用的账户
	if len(availableAccounts) > 0 {
		// 按最后使用时间排序，选择最久未使用的
		sort.Slice(availableAccounts, func(i, j int) bool {
			timeI, _ := time.Parse(time.RFC3339, availableAccounts[i].LastUsedAt)
			timeJ, _ := time.Parse(time.RFC3339, availableAccounts[j].LastUsedAt)
			return timeI.Before(timeJ)
		})
		
		log.Printf("✅ Selected available account: %s (%s)", availableAccounts[0].ID, availableAccounts[0].Name)
		return availableAccounts[0].ID, nil
	}
	
	// 其次使用限流账户（比有问题的账户好）
	if len(rateLimitedAccounts) > 0 {
		sort.Slice(rateLimitedAccounts, func(i, j int) bool {
			timeI, _ := time.Parse(time.RFC3339, rateLimitedAccounts[i].RateLimitedAt)
			timeJ, _ := time.Parse(time.RFC3339, rateLimitedAccounts[j].RateLimitedAt)
			return timeI.Before(timeJ)
		})
		
		log.Printf("All accounts unavailable, using rate limited account: %s (%s)", 
			rateLimitedAccounts[0].ID, rateLimitedAccounts[0].Name)
		return rateLimitedAccounts[0].ID, nil
	}
	
	// 最后使用有问题的账户（总比没有好）
	if len(problematicAccounts) > 0 {
		log.Printf("All accounts have issues, using problematic account: %s (%s)", 
			problematicAccounts[0].ID, problematicAccounts[0].Name)
		return problematicAccounts[0].ID, nil
	}
	
	return "", fmt.Errorf("no accounts available")
}

// isAccountRateLimited 检查账户是否被限流（仅内存）
func (s *Service) isAccountRateLimited(accountID string) bool {
	s.rateLimitMutex.RLock()
	rateLimitedAt, exists := s.rateLimitedCache[accountID]
	s.rateLimitMutex.RUnlock()
	
	if !exists {
		return false
	}
	
	// 限流5分钟
	if time.Since(rateLimitedAt) > 5*time.Minute {
		// 自动移除过期的限流状态
		s.rateLimitMutex.Lock()
		delete(s.rateLimitedCache, accountID)
		s.rateLimitMutex.Unlock()
		
		return false
	}
	
	return true
}

// markAccountRateLimited 标记账户为限流状态（仅内存）
func (s *Service) markAccountRateLimited(accountID string) {
	now := time.Now()
	
	s.rateLimitMutex.Lock()
	s.rateLimitedCache[accountID] = now
	s.rateLimitMutex.Unlock()
	
	log.Printf("🚫 Account marked as rate limited for 5 minutes: %s", accountID)
}

