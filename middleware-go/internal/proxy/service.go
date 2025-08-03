package proxy

import (
	"bytes"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"claude-middleware/internal/config"
	"claude-middleware/internal/redis"
	"github.com/gin-gonic/gin"
	"github.com/gophertool/tool/log"
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
		log.Errorf("Invalid target URL: %v", err)
		os.Exit(1)
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
	log.Debugf("Processing request: %s %s", c.Request.Method, requestPath)
	
	// 读取请求体
	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Failed to read request body"})
		return
	}
	
	// 重新设置请求体，以便后续使用
	c.Request.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	
	// 选择可用的Claude账户ID（传递请求体和路径用于模型检测）
	accountID, err := s.selectAvailableAccount(bodyBytes, requestPath)
	if err != nil {
		log.Warnf("Failed to select account for %s: %v", requestPath, err)
		c.JSON(http.StatusServiceUnavailable, gin.H{
			"error": "No available Claude accounts"})
		return
	}
	
	log.Infof("Selected account %s for %s", accountID, requestPath)
	
	// 获取账户详细信息并存储到context
	accounts, err := s.redisClient.GetAllActiveAccounts()
	if err != nil {
		log.Warnf("Failed to get account details: %v", err)
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
		log.Warnf("Account %s not found in active accounts", accountID)
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Selected account not found"})
		return
	}
	
	// 将账户信息存储到context
	ctx := WithAccount(c.Request.Context(), *selectedAccount)
	ctx = WithAccountID(ctx, accountID)
	c.Request = c.Request.WithContext(ctx)
	
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
		log.Warnf("Proxy request failed for account %s on %s: %v", accountID, requestPath, err)
		
		// 标记账户为有问题的账户
		s.markAccountAsProblematic(accountID, "network_error")
		
		// 如果请求失败，可能是账户问题，尝试其他账户
		if retryAccountID, retryErr := s.selectAvailableAccountExcluding(accountID, bodyBytes, requestPath); retryErr == nil {
			log.Infof("Retrying %s with different account: %s", requestPath, retryAccountID)
			
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
					log.Warnf("Retry also failed with status %d for account %s on %s", retryResp.StatusCode, retryAccountID, requestPath)
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
		log.Warnf("Account %s returned error status %d on %s", accountID, resp.StatusCode, requestPath)
		
		// 对于某些错误状态码，标记账户为有问题
		if s.shouldMarkAccountAsProblematic(resp.StatusCode) {
			s.markAccountAsProblematic(accountID, fmt.Sprintf("http_error_%d", resp.StatusCode))
			
			// 尝试使用其他账户重试
			if retryAccountID, retryErr := s.selectAvailableAccountExcluding(accountID, bodyBytes, requestPath); retryErr == nil {
				log.Infof("Retrying %s with different account due to status %d: %s", requestPath, resp.StatusCode, retryAccountID)
				
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
					log.Warnf("❌ Retry request also failed: %v", retryErr2)
				}
			} else {
				// 无法找到可用账户重试
				log.Warnf("⚠️  No available accounts for retry: %v", retryErr)
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
		log.Warnf("Account %s is rate limited on %s", accountID, requestPath)
		s.markAccountRateLimited(accountID)
	case 200, 201:
		// 记录成功，但不更新Redis
		log.Infof("Successfully processed %s with account %s", requestPath, accountID)
	default:
		log.Debugf("Response %d for %s with account %s", resp.StatusCode, requestPath, accountID)
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
		log.Warnf("Failed to copy response body for %s: %v", requestPath, err)
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
	
	log.Warnf("🚫 Marked account %s as problematic (reason: %s, duration: %v)", accountID, reason, disableDuration)
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
// selectAvailableAccount 选择可用的账户
func (s *Service) selectAvailableAccount(requestBody []byte, requestPath string) (string, error) {
	return s.selectAvailableAccountExcluding("", requestBody, requestPath)
}

// selectAvailableAccountExcluding 选择可用的账户，排除指定账户
func (s *Service) selectAvailableAccountExcluding(excludeAccountID string, requestBody []byte, requestPath string) (string, error) {
	// 每次请求时从Redis获取账户
	accounts, err := s.redisClient.GetAllActiveAccounts()
	if err != nil {
		return "", fmt.Errorf("failed to fetch accounts from Redis: %w", err)
	}
	
	if len(accounts) == 0 {
		return "", fmt.Errorf("no active accounts available")
	}
	
	// 检测模型类型
	detector := &ModelDetector{}
	model := detector.ExtractModelFromRequest(requestBody, requestPath)
	requiresMAX := detector.RequiresMAXAccount(model)
	
	log.Debugf("🔍 Model detected: '%s', requires MAX account: %v", model, requiresMAX)
	
	log.Debugf("🔍 Searching for alternative account (excluding %s), total accounts: %d", excludeAccountID, len(accounts))
	
	// 过滤掉被排除的账户、限流账户和有问题的账户
	var availableAccounts []redis.ClaudeAccount
	var rateLimitedAccounts []redis.ClaudeAccount
	var problematicAccounts []redis.ClaudeAccount
	
	// 如果需要 MAX 账号，进一步分类
	var maxAvailableAccounts []redis.ClaudeAccount
	var maxRateLimitedAccounts []redis.ClaudeAccount
	var maxProblematicAccounts []redis.ClaudeAccount
	
	for _, account := range accounts {
		if account.ID == excludeAccountID {
			log.Debugf("   ⏭️  Skipping excluded account: %s", account.ID)
			continue
		}
		
		isRateLimited := s.isAccountRateLimited(account.ID)
		isProblematic := s.isAccountProblematic(account.ID)
		
		// 检查账号状态并分类
		if isProblematic {
			problematicAccounts = append(problematicAccounts, account)
			if account.IsMAX {
				maxProblematicAccounts = append(maxProblematicAccounts, account)
			}
			log.Debugf("   ❌ Account %s is problematic (MAX: %v)", account.ID, account.IsMAX)
		} else if isRateLimited {
			rateLimitedAccounts = append(rateLimitedAccounts, account)
			if account.IsMAX {
				maxRateLimitedAccounts = append(maxRateLimitedAccounts, account)
			}
			log.Debugf("   ⏱️  Account %s is rate limited (MAX: %v)", account.ID, account.IsMAX)
		} else {
			availableAccounts = append(availableAccounts, account)
			if account.IsMAX {
				maxAvailableAccounts = append(maxAvailableAccounts, account)
			}
			log.Debugf("   ✅ Account %s is available (MAX: %v)", account.ID, account.IsMAX)
		}
	}
	
	log.Debugf("📊 Account status: %d available (%d MAX), %d rate-limited (%d MAX), %d problematic (%d MAX)", 
		len(availableAccounts), len(maxAvailableAccounts),
		len(rateLimitedAccounts), len(maxRateLimitedAccounts),
		len(problematicAccounts), len(maxProblematicAccounts))
	
	// 选择账号的优先级策略
	var selectedAccounts []redis.ClaudeAccount
	
	if requiresMAX {
		// 对于 claude-opus-4-20250514 模型，优先使用 MAX 账号
		if len(maxAvailableAccounts) > 0 {
			selectedAccounts = maxAvailableAccounts
			log.Info("🎯 Using MAX available accounts for Opus model")
		} else if len(maxRateLimitedAccounts) > 0 {
			selectedAccounts = maxRateLimitedAccounts
			log.Warn("⚠️ Using MAX rate-limited accounts for Opus model (no available MAX accounts)")
		} else if len(maxProblematicAccounts) > 0 {
			selectedAccounts = maxProblematicAccounts
			log.Warn("⚠️ Using MAX problematic accounts for Opus model (no other MAX accounts)")
		} else {
			// 如果没有 MAX 账号，记录警告但继续使用普通账号
			log.Warn("⚠️ No MAX accounts found for Opus model, falling back to regular accounts")
			if len(availableAccounts) > 0 {
				selectedAccounts = availableAccounts
			} else if len(rateLimitedAccounts) > 0 {
				selectedAccounts = rateLimitedAccounts
			} else {
				selectedAccounts = problematicAccounts
			}
		}
	} else {
		// 对于其他模型，使用所有类型的账号（优先非 MAX 账号以节省资源）
		if len(availableAccounts) > 0 {
			selectedAccounts = availableAccounts
			log.Debug("🎯 Using all available accounts for regular model")
		} else if len(rateLimitedAccounts) > 0 {
			selectedAccounts = rateLimitedAccounts
			log.Warn("⚠️ Using rate-limited accounts (no available accounts)")
		} else {
			selectedAccounts = problematicAccounts
			log.Warn("⚠️ Using problematic accounts (no other accounts)")
		}
	}
	
	// 检查是否有可选账号
	if len(selectedAccounts) == 0 {
		return "", fmt.Errorf("no accounts available")
	}
	
	// 按最后使用时间排序，选择最久未使用的
	sort.Slice(selectedAccounts, func(i, j int) bool {
		timeI, _ := time.Parse(time.RFC3339, selectedAccounts[i].LastUsedAt)
		timeJ, _ := time.Parse(time.RFC3339, selectedAccounts[j].LastUsedAt)
		return timeI.Before(timeJ)
	})
	
	selected := selectedAccounts[0]
	accountType := "regular"
	if selected.IsMAX {
		accountType = "MAX"
	}
	
	log.Infof("✅ Selected %s account: %s (%s)", accountType, selected.ID, selected.Name)
	return selected.ID, nil
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
	
	log.Warnf("🚫 Account marked as rate limited for 5 minutes: %s", accountID)
}

