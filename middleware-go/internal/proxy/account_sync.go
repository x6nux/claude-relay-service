package proxy

import (
	"fmt"
	"time"
	
	"claude-middleware/internal/redis"
)

// AccountSyncManager 账号同步管理器
type AccountSyncManager struct {
	redisClient   *redis.Client
	syncInterval  time.Duration
	stopChan      chan bool
	isRunning     bool
}

// NewAccountSyncManager 创建账号同步管理器
func NewAccountSyncManager(redisClient *redis.Client, syncInterval time.Duration) *AccountSyncManager {
	return &AccountSyncManager{
		redisClient:  redisClient,
		syncInterval: syncInterval,
		stopChan:     make(chan bool),
		isRunning:    false,
	}
}

// Start 启动定时同步任务
func (m *AccountSyncManager) Start() {
	if m.isRunning {
		fmt.Println("[WARN] Account sync manager is already running")
		return
	}
	
	m.isRunning = true
	fmt.Printf("[INFO] 🔄 Starting account sync manager (interval: %v)\n", m.syncInterval)
	
	// 立即执行一次同步
	m.syncAccounts()
	
	// 启动定时任务
	go func() {
		ticker := time.NewTicker(m.syncInterval)
		defer ticker.Stop()
		
		for {
			select {
			case <-ticker.C:
				m.syncAccounts()
			case <-m.stopChan:
				fmt.Println("[INFO] ⏹️ Account sync manager stopped")
				m.isRunning = false
				return
			}
		}
	}()
}

// Stop 停止定时同步任务
func (m *AccountSyncManager) Stop() {
	if !m.isRunning {
		return
	}
	
	m.stopChan <- true
}

// syncAccounts 同步账号并初始化统计
func (m *AccountSyncManager) syncAccounts() {
	fmt.Println("[INFO] 🔄 Syncing accounts and initializing metrics...")
	
	// 获取所有活跃账户
	accounts, err := m.redisClient.GetAllActiveAccounts()
	if err != nil {
		fmt.Printf("[ERROR] Failed to fetch accounts: %v\n", err)
		return
	}
	
	fmt.Printf("[INFO] 📊 Found %d active accounts\n", len(accounts))
	
	// 获取现有的统计数据
	existingMetrics, err := m.redisClient.GetAllAccountMetrics()
	if err != nil {
		fmt.Printf("[ERROR] Failed to fetch existing metrics: %v\n", err)
		// 即使获取失败也继续，因为我们要确保新账号被初始化
		existingMetrics = make(map[string]*redis.AccountMetrics)
	}
	
	// 统计新账号数量
	newAccountCount := 0
	
	// 为每个账户初始化统计（如果不存在）
	for _, account := range accounts {
		// 检查是否已有统计数据
		if _, exists := existingMetrics[account.ID]; !exists {
			// 初始化新账号的统计
			err := m.redisClient.InitializeAccountMetrics(account.ID)
			if err != nil {
				fmt.Printf("[WARN] Failed to initialize metrics for account %s: %v\n", account.ID, err)
			} else {
				newAccountCount++
				fmt.Printf("[INFO] ✅ Initialized metrics for new account: %s (Name: %s, MAX: %v)\n", 
					account.ID, account.Name, account.IsMAX)
			}
		}
	}
	
	if newAccountCount > 0 {
		fmt.Printf("[INFO] 🎉 Initialized metrics for %d new accounts\n", newAccountCount)
	} else {
		fmt.Println("[INFO] ✓ All accounts already have metrics initialized")
	}
	
	// 输出账号分类统计
	maxCount := 0
	proCount := 0
	for _, account := range accounts {
		if account.IsMAX {
			maxCount++
		} else {
			proCount++
		}
	}
	
	fmt.Printf("[INFO] 📈 Account summary: Total=%d (MAX=%d, Pro=%d)\n", 
		len(accounts), maxCount, proCount)
}

// GetAccountsSummary 获取账号摘要信息
func (m *AccountSyncManager) GetAccountsSummary() (map[string]interface{}, error) {
	accounts, err := m.redisClient.GetAllActiveAccounts()
	if err != nil {
		return nil, err
	}
	
	maxCount := 0
	proCount := 0
	activeCount := 0
	
	for _, account := range accounts {
		if account.IsActive {
			activeCount++
		}
		if account.IsMAX {
			maxCount++
		} else {
			proCount++
		}
	}
	
	return map[string]interface{}{
		"total":  len(accounts),
		"active": activeCount,
		"max":    maxCount,
		"pro":    proCount,
	}, nil
}