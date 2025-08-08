package proxy

import (
	"bytes"
	"html/template"
	"net/http"
	"sort"
	"time"

	"claude-middleware/internal/redis"

	"github.com/gin-gonic/gin"
)

// StatisticsResponse represents the response structure for statistics API
type StatisticsResponse struct {
	Timestamp      int64               `json:"timestamp"`
	TotalAccounts  int                 `json:"totalAccounts"`
	ActiveAccounts int                 `json:"activeAccounts"`
	Accounts       []AccountStatistics `json:"accounts"`
	Summary        StatisticsSummary   `json:"summary"`
}

// AccountStatistics represents statistics for a single account
type AccountStatistics struct {
	AccountID    string  `json:"accountId"` // 已脱敏的账户ID
	IsMAX        bool    `json:"isMAX"`
	IsActive     bool    `json:"isActive"`
	Status       string  `json:"status"`
	RequestCount int64   `json:"requestCount"`
	ErrorCount   int64   `json:"errorCount"`
	ErrorRate    float64 `json:"errorRate"`
	Score        float64 `json:"score"`
	LastUpdated  int64   `json:"lastUpdated"`
}

// StatisticsSummary represents overall statistics summary
type StatisticsSummary struct {
	TotalRequests    int64   `json:"totalRequests"`
	TotalErrors      int64   `json:"totalErrors"`
	OverallErrorRate float64 `json:"overallErrorRate"`
	BestAccount      string  `json:"bestAccount"` // 已脱敏的账户ID
	BestAccountScore float64 `json:"bestAccountScore"`
}

// StatsHandler handles statistics API requests
type StatsHandler struct {
	redisClient *redis.Client
	service     *Service
	templates   *template.Template
}

// NewStatsHandler creates a new statistics handler
func NewStatsHandler(redisClient *redis.Client, service *Service) *StatsHandler {
	// 加载嵌入的模板
	templates, err := LoadEmbeddedTemplates()
	if err != nil {
		// 如果加载失败，使用空模板
		println("⚠️ Failed to load embedded templates:", err.Error())
		templates = template.New("")
	}
	
	return &StatsHandler{
		redisClient: redisClient,
		service:     service,
		templates:   templates,
	}
}

// sanitizeAccountID 对账户ID进行脱敏处理，只保留前3位和后3位
func sanitizeAccountID(accountID string) string {
	if len(accountID) <= 3 {
		// 如果ID太短，直接返回
		return accountID
	}

	if len(accountID) <= 6 {
		// 短ID，保留前3位
		return accountID[:3]
	}

	// 标准脱敏：只显示前3位和后3位
	prefix := accountID[:3]
	suffix := accountID[len(accountID)-3:]
	return prefix + suffix
}

// GetStatistics handles GET /stats requests
func (h *StatsHandler) GetStatistics(c *gin.Context) {
	// 获取所有活跃账户
	accounts, err := h.redisClient.GetAllActiveAccounts()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch accounts",
			"details": err.Error(),
		})
		return
	}

	// 获取所有账户的统计指标
	allMetrics, err := h.redisClient.GetAllAccountMetrics()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{
			"error":   "Failed to fetch account metrics",
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
			// 如果没有统计数据，创建默认指标并初始化到Redis
			metrics = &redis.AccountMetrics{
				AccountID:    account.ID,
				RequestCount: 0,
				ErrorCount:   0,
				ErrorRate:    0.0,
				LastUpdated:  time.Now().Unix(),
			}
			// 主动创建初始统计记录，确保新账号被纳入统计
			h.redisClient.InitializeAccountMetrics(account.ID)
		}

		// 计算账户评分
		score := h.service.calculateAccountScore(metrics, false)

		// 记录最高分账户
		if score > bestScore {
			bestScore = score
			bestAccount = account.ID
		}

		// 累计总统计
		totalRequests += metrics.RequestCount
		totalErrors += metrics.ErrorCount

		accountStats = append(accountStats, AccountStatistics{
			AccountID:    sanitizeAccountID(account.ID),
			IsMAX:        account.IsMAX,
			IsActive:     account.IsActive,
			Status:       account.Status,
			RequestCount: metrics.RequestCount,
			ErrorCount:   metrics.ErrorCount,
			ErrorRate:    metrics.ErrorRate,
			Score:        score,
			LastUpdated:  metrics.LastUpdated,
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
			BestAccount:      sanitizeAccountID(bestAccount),
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
			"error":   "Failed to fetch accounts",
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
			"error":   "Failed to fetch account metrics",
			"details": err.Error(),
		})
		return
	}

	// 计算账户评分
	score := h.service.calculateAccountScore(metrics, false)

	accountStat := AccountStatistics{
		AccountID:    sanitizeAccountID(targetAccount.ID),
		IsMAX:        targetAccount.IsMAX,
		IsActive:     targetAccount.IsActive,
		Status:       targetAccount.Status,
		RequestCount: metrics.RequestCount,
		ErrorCount:   metrics.ErrorCount,
		ErrorRate:    metrics.ErrorRate,
		Score:        score,
		LastUpdated:  metrics.LastUpdated,
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
			"error":   "Failed to reset account statistics",
			"details": err.Error(),
		})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"message":   "Account statistics reset successfully",
		"accountId": sanitizeAccountID(accountID),
	})
}

// StatsPageData represents data for the stats HTML page
type StatsPageData struct {
	UpdateTime       string
	TotalAccounts    int
	ActiveAccounts   int
	Summary          StatisticsSummary
	AccountStats     AccountStatsInfo
	Accounts         []AccountStatisticsDisplay
	ErrorRatePercent float64
}

// AccountStatsInfo represents account type statistics
type AccountStatsInfo struct {
	Total      int
	Active     int
	MaxTotal   int
	MaxActive  int
	ProTotal   int
	ProActive  int
}

// AccountStatisticsDisplay represents account data for HTML display
type AccountStatisticsDisplay struct {
	AccountStatistics
	ScoreClass           string
	ErrorRateClass       string
	ErrorRatePercent     float64
	LastUpdatedFormatted string
}

// GetStatsPage handles GET /stats.html requests
func (h *StatsHandler) GetStatsPage(c *gin.Context) {
	// 获取所有活跃账户
	accounts, err := h.redisClient.GetAllActiveAccounts()
	if err != nil {
		c.HTML(http.StatusInternalServerError, "stats.html", gin.H{
			"error": "Failed to fetch accounts",
		})
		return
	}
	
	// 获取所有账户的统计指标
	allMetrics, err := h.redisClient.GetAllAccountMetrics()
	if err != nil {
		c.HTML(http.StatusInternalServerError, "stats.html", gin.H{
			"error": "Failed to fetch account metrics",
		})
		return
	}

	// 初始化统计数据
	var totalRequests, totalErrors int64
	var bestAccount string
	var bestScore float64
	accountStatsList := make([]AccountStatisticsDisplay, 0, len(accounts))
	
	// 账户类型统计
	accountStats := AccountStatsInfo{}
	accountStats.Total = len(accounts)

	// 遍历账户，计算统计数据
	for _, account := range accounts {
		// 从allMetrics中查找当前账户的指标
		metrics := allMetrics[account.ID]
		if metrics == nil {
			// 如果没有统计数据，创建默认指标并初始化到Redis
			metrics = &redis.AccountMetrics{
				AccountID:    account.ID,
				RequestCount: 0,
				ErrorCount:   0,
				ErrorRate:    0.0,
				LastUpdated:  time.Now().Unix(),
			}
			// 主动创建初始统计记录，确保新账号被纳入统计
			h.redisClient.InitializeAccountMetrics(account.ID)
		}
		
		// 计算账户评分
		score := h.service.calculateAccountScore(metrics, false)
		
		// 更新总计数
		totalRequests += metrics.RequestCount
		totalErrors += metrics.ErrorCount
		
		// 更新最佳账户
		if score > bestScore {
			bestScore = score
			bestAccount = sanitizeAccountID(account.ID)
		}
		
		// 账户类型统计
		if account.IsActive {
			accountStats.Active++
		}
		if account.IsMAX {
			accountStats.MaxTotal++
			if account.IsActive {
				accountStats.MaxActive++
			}
		} else {
			accountStats.ProTotal++
			if account.IsActive {
				accountStats.ProActive++
			}
		}
		
		// 准备显示数据
		display := AccountStatisticsDisplay{
			AccountStatistics: AccountStatistics{
				AccountID:     sanitizeAccountID(account.ID),
				IsMAX:         account.IsMAX,
				IsActive:      account.IsActive,
				Status:        account.Status,
				RequestCount:  metrics.RequestCount,
				ErrorCount:    metrics.ErrorCount,
				ErrorRate:     metrics.ErrorRate,
				Score:         score,
				LastUpdated:   metrics.LastUpdated,
			},
			ErrorRatePercent: metrics.ErrorRate * 100,
		}
		
		// 设置样式类
		if score >= 80 {
			display.ScoreClass = "high"
		} else if score >= 60 {
			display.ScoreClass = "medium"
		} else {
			display.ScoreClass = "low"
		}
		
		if metrics.ErrorRate <= 0.01 {
			display.ErrorRateClass = "low"
		} else if metrics.ErrorRate <= 0.05 {
			display.ErrorRateClass = "medium"
		} else {
			display.ErrorRateClass = "high"
		}
		
		// 格式化时间 - 使用 UTC+8 时区
		if metrics.LastUpdated > 0 {
			// LastUpdated 是秒级时间戳，直接使用
			utc8 := time.FixedZone("UTC+8", 8*60*60)
			display.LastUpdatedFormatted = time.Unix(metrics.LastUpdated, 0).In(utc8).Format("01-02 15:04:05")
		} else {
			display.LastUpdatedFormatted = "未更新"
		}
		
		accountStatsList = append(accountStatsList, display)
	}
	
	// 对账户列表进行排序：MAX账户优先，然后按评分降序
	sort.Slice(accountStatsList, func(i, j int) bool {
		// MAX账户优先
		if accountStatsList[i].IsMAX != accountStatsList[j].IsMAX {
			return accountStatsList[i].IsMAX
		}
		// 然后按评分降序
		return accountStatsList[i].Score > accountStatsList[j].Score
	})
	
	// 计算总体错误率
	var overallErrorRate float64
	if totalRequests > 0 {
		overallErrorRate = float64(totalErrors) / float64(totalRequests)
	}
	
	// 准备页面数据
	utc8 := time.FixedZone("UTC+8", 8*60*60)
	pageData := StatsPageData{
		UpdateTime:       time.Now().In(utc8).Format("2006-01-02 15:04:05"),
		TotalAccounts:    len(accounts),
		ActiveAccounts:   accountStats.Active,
		AccountStats:     accountStats,
		Summary: StatisticsSummary{
			TotalRequests:    totalRequests,
			TotalErrors:      totalErrors,
			OverallErrorRate: overallErrorRate,
			BestAccount:      bestAccount,
			BestAccountScore: bestScore,
		},
		ErrorRatePercent: overallErrorRate * 100,
		Accounts:         accountStatsList,
	}
	
	// 渲染HTML模板
	var buf bytes.Buffer
	err = h.templates.ExecuteTemplate(&buf, "stats.html", pageData)
	if err != nil {
		c.HTML(http.StatusInternalServerError, "stats.html", gin.H{
			"error": "Failed to render template: " + err.Error(),
		})
		return
	}
	
	// 返回渲染的HTML
	c.Data(http.StatusOK, "text/html; charset=utf-8", buf.Bytes())
}
