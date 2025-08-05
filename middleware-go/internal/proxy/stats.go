package proxy

import (
	"net/http"
	"time"

	"claude-middleware/internal/redis"
	"github.com/gin-gonic/gin"
)

// StatisticsResponse represents the response structure for statistics API
type StatisticsResponse struct {
	Timestamp     int64                    `json:"timestamp"`
	TotalAccounts int                      `json:"totalAccounts"`
	ActiveAccounts int                     `json:"activeAccounts"`
	Accounts      []AccountStatistics      `json:"accounts"`
	Summary       StatisticsSummary        `json:"summary"`
}

// AccountStatistics represents statistics for a single account
type AccountStatistics struct {
	AccountID     string  `json:"accountId"`
	AccountName   string  `json:"accountName"`
	IsMAX         bool    `json:"isMAX"`
	IsActive      bool    `json:"isActive"`
	Status        string  `json:"status"`
	RequestCount  int64   `json:"requestCount"`
	ErrorCount    int64   `json:"errorCount"`
	ErrorRate     float64 `json:"errorRate"`
	Score         float64 `json:"score"`
	LastUpdated   int64   `json:"lastUpdated"`
}

// StatisticsSummary represents overall statistics summary
type StatisticsSummary struct {
	TotalRequests    int64   `json:"totalRequests"`
	TotalErrors      int64   `json:"totalErrors"`
	OverallErrorRate float64 `json:"overallErrorRate"`
	BestAccount      string  `json:"bestAccount"`
	BestAccountScore float64 `json:"bestAccountScore"`
}

// StatsHandler handles statistics API requests
type StatsHandler struct {
	redisClient *redis.Client
	service     *Service
}

// NewStatsHandler creates a new statistics handler
func NewStatsHandler(redisClient *redis.Client, service *Service) *StatsHandler {
	return &StatsHandler{
		redisClient: redisClient,
		service:     service,
	}
}

// GetStatistics handles GET /stats requests
func (h *StatsHandler) GetStatistics(c *gin.Context) {
	// 获取所有活跃账户
	accounts, err := h.redisClient.GetAllActiveAccounts()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to fetch accounts",
			"details": err.Error(),
		})
		return
	}

	// 获取所有账户的统计指标
	allMetrics, err := h.redisClient.GetAllAccountMetrics()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to fetch account metrics",
			"details": err.Error(),
		})
		return
	}

	var accountStats []AccountStatistics
	var totalRequests, totalErrors int64
	var bestAccount string
	var bestScore float64

	// 处理每个账户的统计信息
	for _, account := range accounts {
		metrics, exists := allMetrics[account.ID]
		if !exists {
			// 如果没有统计数据，创建默认指标
			metrics = &redis.AccountMetrics{
				AccountID:    account.ID,
				RequestCount: 0,
				ErrorCount:   0,
				ErrorRate:    0.0,
				LastUpdated:  0,
			}
		}

		// 计算账户评分
		score := h.service.calculateAccountScore(metrics)
		
		// 记录最高分账户
		if score > bestScore {
			bestScore = score
			bestAccount = account.ID
		}

		// 累计总统计
		totalRequests += metrics.RequestCount
		totalErrors += metrics.ErrorCount

		accountStats = append(accountStats, AccountStatistics{
			AccountID:     account.ID,
			AccountName:   account.Name,
			IsMAX:         account.IsMAX,
			IsActive:      account.IsActive,
			Status:        account.Status,
			RequestCount:  metrics.RequestCount,
			ErrorCount:    metrics.ErrorCount,
			ErrorRate:     metrics.ErrorRate,
			Score:         score,
			LastUpdated:   metrics.LastUpdated,
		})
	}

	// 计算总体错误率
	var overallErrorRate float64
	if totalRequests > 0 {
		overallErrorRate = float64(totalErrors) / float64(totalRequests)
	}

	// 构建响应
	response := StatisticsResponse{
		Timestamp:      time.Now().Unix(),
		TotalAccounts:  len(accounts),
		ActiveAccounts: len(accounts), // 因为我们只获取活跃账户
		Accounts:       accountStats,
		Summary: StatisticsSummary{
			TotalRequests:    totalRequests,
			TotalErrors:      totalErrors,
			OverallErrorRate: overallErrorRate,
			BestAccount:      bestAccount,
			BestAccountScore: bestScore,
		},
	}

	c.JSON(http.StatusOK, response)
}

// GetAccountStatistics handles GET /stats/account/:id requests
func (h *StatsHandler) GetAccountStatistics(c *gin.Context) {
	accountID := c.Param("id")
	if accountID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Account ID is required",
		})
		return
	}

	// 获取账户信息
	accounts, err := h.redisClient.GetAllActiveAccounts()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to fetch accounts",
			"details": err.Error(),
		})
		return
	}

	var targetAccount *redis.ClaudeAccount
	for _, account := range accounts {
		if account.ID == accountID {
			targetAccount = &account
			break
		}
	}

	if targetAccount == nil {
		c.JSON(http.StatusNotFound, gin.H{
			"error": "Account not found",
		})
		return
	}

	// 获取账户统计指标
	metrics, err := h.redisClient.GetAccountMetrics(accountID)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to fetch account metrics",
			"details": err.Error(),
		})
		return
	}

	// 计算账户评分
	score := h.service.calculateAccountScore(metrics)

	accountStat := AccountStatistics{
		AccountID:     targetAccount.ID,
		AccountName:   targetAccount.Name,
		IsMAX:         targetAccount.IsMAX,
		IsActive:      targetAccount.IsActive,
		Status:        targetAccount.Status,
		RequestCount:  metrics.RequestCount,
		ErrorCount:    metrics.ErrorCount,
		ErrorRate:     metrics.ErrorRate,
		Score:         score,
		LastUpdated:   metrics.LastUpdated,
	}

	c.JSON(http.StatusOK, accountStat)
}

// ResetAccountStatistics handles POST /stats/account/:id/reset requests
func (h *StatsHandler) ResetAccountStatistics(c *gin.Context) {
	accountID := c.Param("id")
	if accountID == "" {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "Account ID is required",
		})
		return
	}

	// 删除账户的统计指标
	key := "middleware:metrics:" + accountID
	err := h.redisClient.DeleteKey(key)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error": "Failed to reset account statistics",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message": "Account statistics reset successfully",
		"accountId": accountID,
	})
}