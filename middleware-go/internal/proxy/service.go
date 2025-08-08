package proxy

import (
	"bytes"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"claude-middleware/internal/config"
	"claude-middleware/internal/redis"
	"github.com/gin-gonic/gin"
)

type Service struct {
	redisClient *redis.Client
	config      *config.Config
	targetURL   *url.URL
	httpClient  *http.Client
}

func NewService(redisClient *redis.Client, cfg *config.Config) *Service {
	targetURL, err := url.Parse(cfg.Proxy.TargetURL)
	if err != nil {
		fmt.Printf("[ERROR] Invalid target URL: %v\n", err)
		os.Exit(1)
	}
	
	service := &Service{
		redisClient: redisClient,
		config:      cfg,
		targetURL:   targetURL,
		httpClient: &http.Client{
			Timeout: time.Duration(cfg.Proxy.Timeout) * time.Second,
		},
	}
	
	return service
}

// ProxyHandler 处理所有代理请求（支持5次重试）
func (s *Service) ProxyHandler(c *gin.Context) {
	// 记录请求路径
	requestPath := c.Request.URL.Path
	fmt.Printf("[DEBUG] Processing request: %s %s\n", c.Request.Method, requestPath)
	
	// 读取请求体
	bodyBytes, err := io.ReadAll(c.Request.Body)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Failed to read request body"})
		return
	}
	
	// 重新设置请求体，以便后续使用
	c.Request.Body = io.NopCloser(bytes.NewReader(bodyBytes))
	
	// 实现5次重试逻辑
	maxRetries := 5
	usedAccountIDs := make(map[string]bool) // 记录已使用的账户ID
	
	for retryCount := 0; retryCount < maxRetries; retryCount++ {
		// 选择可用的Claude账户ID，排除已使用的账户
		accountID, err := s.selectAvailableAccountWithExclusions(usedAccountIDs, bodyBytes, requestPath)
		if err != nil {
			fmt.Printf("[WARN] Failed to select account for %s (retry %d/%d): %v\n", requestPath, retryCount+1, maxRetries, err)
			
			// 如果是最后一次重试，返回错误
			if retryCount == maxRetries-1 {
				c.JSON(http.StatusServiceUnavailable, gin.H{
					"error": "No available Claude accounts"})
				return
			}
			continue
		}
		
		// 记录已使用的账户
		usedAccountIDs[accountID] = true
		
		if retryCount > 0 {
			fmt.Printf("[INFO] 🔄 Retry %d/%d: Using account %s for %s\n", retryCount+1, maxRetries, accountID, requestPath)
		} else {
			fmt.Printf("[INFO] Selected account %s for %s\n", accountID, requestPath)
		}
		
		// 获取账户详细信息并存储到context
		accounts, err := s.redisClient.GetAllActiveAccounts()
		if err != nil {
			fmt.Printf("[WARN] Failed to get account details: %v\n", err)
			if retryCount == maxRetries-1 {
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": "Failed to retrieve account information"})
				return
			}
			continue
		}
		
		var selectedAccount *redis.ClaudeAccount
		for _, acc := range accounts {
			if acc.ID == accountID {
				selectedAccount = &acc
				break
			}
		}
		
		if selectedAccount == nil {
			fmt.Printf("[WARN] Account %s not found in active accounts\n", accountID)
			if retryCount == maxRetries-1 {
				c.JSON(http.StatusInternalServerError, gin.H{
					"error": "Selected account not found"})
				return
			}
			continue
		}
		
		// 将账户信息存储到context
		ctx := WithAccount(c.Request.Context(), *selectedAccount)
		ctx = WithAccountID(ctx, accountID)
		c.Request = c.Request.WithContext(ctx)
		
		// 尝试发送请求
		success := s.attemptRequest(c, accountID, bodyBytes, requestPath, retryCount, maxRetries)
		if success {
			// 记录成功的请求
			if err := s.redisClient.IncrementRequestCount(accountID); err != nil {
				fmt.Printf("[DEBUG] Failed to record request count for account %s: %v\n", accountID, err)
			}
			return // 请求成功，结束重试
		} else {
			// 记录失败的请求（既增加请求数也增加错误数）
			if err := s.redisClient.IncrementRequestCount(accountID); err != nil {
				fmt.Printf("[DEBUG] Failed to record request count for account %s: %v\n", accountID, err)
			}
			if err := s.redisClient.IncrementErrorCount(accountID); err != nil {
				fmt.Printf("[DEBUG] Failed to record error count for account %s: %v\n", accountID, err)
			}
		}
	}
	
	// 所有重试都失败了
	fmt.Printf("[ERROR] ❌ All %d retries exhausted for %s\n", maxRetries, requestPath)
	c.JSON(http.StatusBadGateway, gin.H{
		"error": "All retry attempts failed"})
}

// attemptRequest 尝试发送单个请求
func (s *Service) attemptRequest(c *gin.Context, accountID string, bodyBytes []byte, requestPath string, retryCount, maxRetries int) bool {
	// 创建目标URL
	targetURL := *s.targetURL
	targetURL.Path = c.Request.URL.Path
	targetURL.RawQuery = c.Request.URL.RawQuery
	
	// 创建新的请求
	proxyReq, err := http.NewRequest(c.Request.Method, targetURL.String(), bytes.NewReader(bodyBytes))
	if err != nil {
		fmt.Printf("[WARN] Failed to create proxy request: %v\n", err)
		return false
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
		fmt.Printf("[WARN] Proxy request failed for account %s on %s (retry %d/%d): %v\n", accountID, requestPath, retryCount+1, maxRetries, err)
		
		// 标记账户为有问题的账户
		s.markAccountAsProblematic(accountID, "network_error")
		return false
	}
	
	// 检查响应状态码
	if !s.isSuccessResponse(resp.StatusCode) {
		fmt.Printf("[WARN] Account %s returned error status %d on %s (retry %d/%d)\n", accountID, resp.StatusCode, requestPath, retryCount+1, maxRetries)
		
		// 对于某些错误状态码，标记账户为有问题
		if s.shouldMarkAccountAsProblematic(resp.StatusCode) {
			s.markAccountAsProblematic(accountID, fmt.Sprintf("http_error_%d", resp.StatusCode))
		}
		
		// 如果是429错误且是最后一次重试，返回503
		if resp.StatusCode == 429 && retryCount == maxRetries-1 {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error": "All accounts are rate limited",
				"message": "Service temporarily unavailable, please try again later",
			})
			return true // 返回true表示已经处理了响应，不需要继续重试
		}
		
		return false
	}
	
	// 请求成功
	s.handleResponse(c, resp, accountID, requestPath)
	return true
}

// selectAvailableAccountWithExclusions 选择可用账户，排除指定的多个账户
func (s *Service) selectAvailableAccountWithExclusions(excludeAccountIDs map[string]bool, requestBody []byte, requestPath string) (string, error) {
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
	
	fmt.Printf("[DEBUG] 🔍 Model detected: '%s', requires MAX account: %v\n", model, requiresMAX)
	
	excludeCount := len(excludeAccountIDs)
	fmt.Printf("[DEBUG] 🔍 Searching for account (excluding %d accounts), total accounts: %d\n", excludeCount, len(accounts))
	
	// 过滤掉被排除的账户、限流账户和有问题的账户
	var availableAccounts []redis.ClaudeAccount
	var rateLimitedAccounts []redis.ClaudeAccount
	var problematicAccounts []redis.ClaudeAccount
	
	// 如果需要 MAX 账号，进一步分类
	var maxAvailableAccounts []redis.ClaudeAccount
	var maxRateLimitedAccounts []redis.ClaudeAccount
	var maxProblematicAccounts []redis.ClaudeAccount
	
	for _, account := range accounts {
		if excludeAccountIDs[account.ID] {
			fmt.Printf("[DEBUG]    ⏭️  Skipping excluded account: %s\n", account.ID)
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
			fmt.Printf("[DEBUG]    ❌ Account %s is problematic (MAX: %v)\n", account.ID, account.IsMAX)
		} else if isRateLimited {
			rateLimitedAccounts = append(rateLimitedAccounts, account)
			if account.IsMAX {
				maxRateLimitedAccounts = append(maxRateLimitedAccounts, account)
			}
			fmt.Printf("[DEBUG]    ⏱️  Account %s is rate limited (MAX: %v)\n", account.ID, account.IsMAX)
		} else {
			availableAccounts = append(availableAccounts, account)
			if account.IsMAX {
				maxAvailableAccounts = append(maxAvailableAccounts, account)
			}
			fmt.Printf("[DEBUG]    ✅ Account %s is available (MAX: %v)\n", account.ID, account.IsMAX)
		}
	}
	
	fmt.Printf("[DEBUG] 📊 Account status: %d available (%d MAX), %d rate-limited (%d MAX), %d problematic (%d MAX)\n", 
		len(availableAccounts), len(maxAvailableAccounts),
		len(rateLimitedAccounts), len(maxRateLimitedAccounts),
		len(problematicAccounts), len(maxProblematicAccounts))
	
	// 选择账号的优先级策略
	var selectedAccounts []redis.ClaudeAccount
	
	if requiresMAX {
		// 对于 claude-opus-4-20250514 模型，优先使用 MAX 账号
		if len(maxAvailableAccounts) > 0 {
			selectedAccounts = maxAvailableAccounts
			fmt.Println("[INFO] 🎯 Using MAX available accounts for Opus model")
		} else if len(maxRateLimitedAccounts) > 0 {
			selectedAccounts = maxRateLimitedAccounts
			fmt.Println("[WARN] ⚠️ Using MAX rate-limited accounts for Opus model (no available MAX accounts)")
		} else if len(maxProblematicAccounts) > 0 {
			selectedAccounts = maxProblematicAccounts
			fmt.Println("[WARN] ⚠️ Using MAX problematic accounts for Opus model (no other MAX accounts)")
		} else {
			// 如果没有 MAX 账号，记录警告但继续使用普通账号
			fmt.Println("[WARN] ⚠️ No MAX accounts found for Opus model, falling back to regular accounts")
			if len(availableAccounts) > 0 {
				selectedAccounts = availableAccounts
			} else if len(rateLimitedAccounts) > 0 {
				selectedAccounts = rateLimitedAccounts
			} else {
				selectedAccounts = problematicAccounts
			}
		}
	} else {
		// 对于其他模型，使用所有类型的账号
		// 通过评分系统自动优先使用PRO账号（MAX账号会被降低30分）
		if len(availableAccounts) > 0 {
			selectedAccounts = availableAccounts
			fmt.Println("[DEBUG] 🎯 Using all available accounts for regular model (PRO accounts preferred)")
		} else if len(rateLimitedAccounts) > 0 {
			selectedAccounts = rateLimitedAccounts
			fmt.Println("[WARN] ⚠️ Using rate-limited accounts (no available accounts)")
		} else {
			selectedAccounts = problematicAccounts
			fmt.Println("[WARN] ⚠️ Using problematic accounts (no other accounts)")
		}
	}
	
	// 检查是否有可选账号
	if len(selectedAccounts) == 0 {
		return "", fmt.Errorf("no accounts available")
	}
	
	// 使用智能选择算法替代随机选择
	selectedAccountID, err := s.selectBestAccount(selectedAccounts, requiresMAX)
	if err != nil {
		fmt.Printf("[WARN] Intelligent selection failed, falling back to random: %v\n", err)
		// 如果智能选择失败，回退到随机选择
		randomIndex := rand.Intn(len(selectedAccounts))
		selectedAccountID = selectedAccounts[randomIndex].ID
	}
	
	// 查找选中的账户信息
	var selected *redis.ClaudeAccount
	for _, account := range selectedAccounts {
		if account.ID == selectedAccountID {
			selected = &account
			break
		}
	}
	
	if selected == nil {
		// 不应该发生，但为了安全起见
		selected = &selectedAccounts[0]
	}
	
	accountType := "regular"
	if selected.IsMAX {
		accountType = "MAX"
	}
	
	fmt.Printf("[INFO] ✅ Selected %s account: %s (%s)\n", accountType, selected.ID, selected.Name)
	return selected.ID, nil
}

// AccountScore represents an account with its calculated score
type AccountScore struct {
	Account redis.ClaudeAccount
	Score   float64
	Metrics *redis.AccountMetrics
}

// selectBestAccount 使用加权评分算法选择最佳账户
func (s *Service) selectBestAccount(accounts []redis.ClaudeAccount, isOpusModel bool) (string, error) {
	if len(accounts) == 0 {
		return "", fmt.Errorf("no accounts provided")
	}
	
	if len(accounts) == 1 {
		return accounts[0].ID, nil
	}
	
	// 获取所有账户的统计指标
	allMetrics, err := s.redisClient.GetAllAccountMetrics()
	if err != nil {
		fmt.Printf("[DEBUG] Failed to get account metrics, using random selection: %v\n", err)
		return "", err
	}
	
	var accountScores []AccountScore
	
	// 为每个账户计算评分
	for _, account := range accounts {
		metrics, exists := allMetrics[account.ID]
		if !exists {
			// 新账户，创建默认指标
			metrics = &redis.AccountMetrics{
				AccountID:    account.ID,
				RequestCount: 0,
				ErrorCount:   0,
				ErrorRate:    0.0,
			}
		}
		
		score := s.calculateAccountScore(metrics, account.IsMAX && !isOpusModel)
		accountScores = append(accountScores, AccountScore{
			Account: account,
			Score:   score,
			Metrics: metrics,
		})
	}
	
	// 按评分排序（降序，分数越高越好）
	sort.Slice(accountScores, func(i, j int) bool {
		return accountScores[i].Score > accountScores[j].Score
	})
	
	// 记录选择过程的详细信息
	fmt.Printf("[DEBUG] 🧮 Account scoring results:\n")
	for i, as := range accountScores {
		accountType := "PRO"
		if as.Account.IsMAX {
			accountType = "MAX"
		}
		fmt.Printf("[DEBUG]   %d. %s (%s, Score: %.3f, Requests: %d, Errors: %d, ErrorRate: %.3f%%)\n", 
			i+1, as.Account.ID, accountType, as.Score, as.Metrics.RequestCount, as.Metrics.ErrorCount, as.Metrics.ErrorRate*100)
	}
	
	// 使用加权随机选择，分数越高被选中的概率越大
	bestAccount := s.weightedRandomSelection(accountScores)
	
	fmt.Printf("[INFO] 🎯 Intelligent selection chose: %s (Score: %.3f)\n", bestAccount.Account.ID, bestAccount.Score)
	return bestAccount.Account.ID, nil
}

// calculateAccountScore 计算账户的综合评分
func (s *Service) calculateAccountScore(metrics *redis.AccountMetrics, applyMAXPenalty bool) float64 {
	// 基础分数
	baseScore := 100.0
	
	// 权重配置
	const (
		requestCountWeight = 0.3  // 请求次数权重（越少越好）
		errorRateWeight    = 0.7  // 错误率权重（越低越好）
	)
	
	// 请求次数评分：使用对数函数，请求次数越多分数越低
	requestScore := baseScore
	if metrics.RequestCount > 0 {
		// 使用对数函数平滑处理，避免请求次数差异过大
		requestScore = baseScore - (math.Log(float64(metrics.RequestCount)+1) * 10)
		if requestScore < 0 {
			requestScore = 0
		}
	}
	
	// 错误率评分：错误率越高分数越低
	errorScore := baseScore * (1.0 - metrics.ErrorRate)
	if errorScore < 0 {
		errorScore = 0
	}
	
	// 加权计算最终分数
	finalScore := (requestScore * requestCountWeight) + (errorScore * errorRateWeight)
	
	// 为新账户（无历史记录）给予适度的优势，避免它们永远不被选择
	if metrics.RequestCount == 0 {
		finalScore += 10.0 // 新账户奖励分数
	}
	
	// 对于非opus模型使用MAX账号的惩罚
	// 降低30分以确保优先使用PRO账号
	if applyMAXPenalty {
		finalScore -= 30.0
		if finalScore < 0 {
			finalScore = 0
		}
	}
	
	return finalScore
}

// weightedRandomSelection 基于分数进行加权随机选择
func (s *Service) weightedRandomSelection(accountScores []AccountScore) AccountScore {
	if len(accountScores) == 1 {
		return accountScores[0]
	}
	
	// 计算总权重（使用指数函数增强高分账户的被选概率）
	totalWeight := 0.0
	weights := make([]float64, len(accountScores))
	
	for i, as := range accountScores {
		// 使用指数函数增强差异，但避免过大的差距
		weight := math.Exp(as.Score / 50.0) // 调整除数来控制选择的集中度
		weights[i] = weight
		totalWeight += weight
	}
	
	// 生成随机数进行选择
	r := rand.Float64() * totalWeight
	currentWeight := 0.0
	
	for i, weight := range weights {
		currentWeight += weight
		if r <= currentWeight {
			return accountScores[i]
		}
	}
	
	// 回退到最高分账户（不应该到这里）
	return accountScores[0]
}

// handleResponse 处理响应
func (s *Service) handleResponse(c *gin.Context, resp *http.Response, accountID string, requestPath string) {
	defer resp.Body.Close()
	
	// 检查是否是限流响应
	switch resp.StatusCode {
	case 429:
		fmt.Printf("[WARN] Account %s is rate limited on %s\n", accountID, requestPath)
		s.markAccountRateLimited(accountID)
	case 200, 201:
		// 记录成功，但不更新Redis
		fmt.Printf("[INFO] Successfully processed %s with account %s\n", requestPath, accountID)
	default:
		fmt.Printf("[DEBUG] Response %d for %s with account %s\n", resp.StatusCode, requestPath, accountID)
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
		fmt.Printf("[WARN] Failed to copy response body for %s: %v\n", requestPath, err)
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

// markAccountAsProblematic 标记账户为有问题的账户（使用Redis）
func (s *Service) markAccountAsProblematic(accountID string, reason string) {
	// 所有异常统一限流5分钟
	disableDuration := 5 * time.Minute
	
	// 如果是429错误，同时标记为限流
	if strings.Contains(reason, "429") {
		s.markAccountRateLimited(accountID)
	}
	
	if err := s.redisClient.SetAccountProblematic(accountID, disableDuration); err != nil {
		fmt.Printf("[ERROR] Failed to mark account %s as problematic in Redis: %v\n", accountID, err)
		return
	}
	
	fmt.Printf("[WARN] 🚫 Marked account %s as problematic (reason: %s, duration: %v)\n", accountID, reason, disableDuration)
}

// isAccountProblematic 检查账户是否被标记为有问题（使用Redis）
func (s *Service) isAccountProblematic(accountID string) bool {
	isProblematic, err := s.redisClient.IsAccountProblematic(accountID)
	if err != nil {
		fmt.Printf("[ERROR] Failed to check account problematic status for %s: %v\n", accountID, err)
		return false
	}
	return isProblematic
}
// selectAvailableAccount 选择可用的账户（兼容性函数）
func (s *Service) selectAvailableAccount(requestBody []byte, requestPath string) (string, error) {
	return s.selectAvailableAccountWithExclusions(make(map[string]bool), requestBody, requestPath)
}

// selectAvailableAccountExcluding 选择可用的账户，排除指定账户（兼容性函数）
func (s *Service) selectAvailableAccountExcluding(excludeAccountID string, requestBody []byte, requestPath string) (string, error) {
	excludeMap := make(map[string]bool)
	if excludeAccountID != "" {
		excludeMap[excludeAccountID] = true
	}
	return s.selectAvailableAccountWithExclusions(excludeMap, requestBody, requestPath)
}

// isAccountRateLimited 检查账户是否被限流（使用Redis）
func (s *Service) isAccountRateLimited(accountID string) bool {
	isRateLimited, err := s.redisClient.IsAccountRateLimited(accountID)
	if err != nil {
		fmt.Printf("[ERROR] Failed to check account rate limit status for %s: %v\n", accountID, err)
		return false
	}
	return isRateLimited
}

// markAccountRateLimited 标记账户为限流状态（使用Redis）
func (s *Service) markAccountRateLimited(accountID string) {
	// 限流5分钟
	duration := 5 * time.Minute
	
	if err := s.redisClient.SetAccountRateLimit(accountID, duration); err != nil {
		fmt.Printf("[ERROR] Failed to mark account %s as rate limited in Redis: %v\n", accountID, err)
		return
	}
	
	fmt.Printf("[WARN] 🚫 Account marked as rate limited for 5 minutes: %s\n", accountID)
}

