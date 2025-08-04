package requestlog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"claude-middleware/internal/config"

	"github.com/gin-gonic/gin"
	"github.com/gophertool/tool/log"
)

// RequestLogData 请求日志数据结构
type RequestLogData struct {
	ID          string            `json:"id"`
	Timestamp   string            `json:"timestamp"`
	Method      string            `json:"method"`
	URL         string            `json:"url"`
	Path        string            `json:"path"`
	Query       map[string]any    `json:"query"`
	Headers     map[string]any    `json:"headers"`
	Body        any               `json:"body"`
	IP          string            `json:"ip"`
	UserAgent   string            `json:"userAgent"`
	ContentType string            `json:"contentType"`
}

// RequestLogger 请求日志记录器
type RequestLogger struct {
	config    *config.RequestLogConfig
	logChan   chan RequestLogData
	stopChan  chan bool
	doneChan  chan bool
}

// NewRequestLogger 创建新的请求日志记录器
func NewRequestLogger(cfg *config.RequestLogConfig) *RequestLogger {
	rl := &RequestLogger{
		config:   cfg,
		logChan:  make(chan RequestLogData, 1000), // 缓冲1000个日志条目
		stopChan: make(chan bool, 1),
		doneChan: make(chan bool, 1),
	}
	
	// 启动日志写入协程
	if cfg.Enabled {
		go rl.logWriter()
	}
	
	return rl
}

// Stop 停止日志记录器
func (rl *RequestLogger) Stop() {
	if !rl.config.Enabled {
		return
	}
	
	close(rl.stopChan)
	<-rl.doneChan // 等待写入协程完成
}

// Middleware 返回Gin中间件函数
func (rl *RequestLogger) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 检查是否启用日志
		if !rl.config.Enabled {
			c.Next()
			return
		}

		// 检查是否是来自 /claude 路径的请求
		if !strings.HasPrefix(c.Request.URL.Path, "/claude") {
			c.Next()
			return
		}

		// 读取请求体
		var requestBody any
		if c.Request.Body != nil {
			bodyBytes, err := io.ReadAll(c.Request.Body)
			if err == nil {
				// 恢复请求体，让后续处理器可以读取
				c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
				
				// 尝试解析JSON
				if len(bodyBytes) > 0 {
					var jsonBody any
					if err := json.Unmarshal(bodyBytes, &jsonBody); err == nil {
						requestBody = jsonBody
					} else {
						requestBody = string(bodyBytes)
					}
				}
			}
		}

		// 构建请求数据
		requestData := RequestLogData{
			ID:          generateRequestID(),
			Timestamp:   time.Now().UTC().Format(time.RFC3339),
			Method:      c.Request.Method,
			URL:         c.Request.URL.String(),
			Path:        c.Request.URL.Path,
			Query:       convertQuery(c.Request.URL.Query()),
			Headers:     convertHeaders(c.Request.Header),
			Body:        requestBody,
			IP:          c.ClientIP(),
			UserAgent:   c.Request.UserAgent(),
			ContentType: c.Request.Header.Get("Content-Type"),
		}

		// 异步写入日志
		select {
		case rl.logChan <- requestData:
			// 成功发送到通道
		default:
			// 通道满了，丢弃此日志条目（避免阻塞请求）
			log.Warn("Request log channel is full, dropping log entry")
		}

		c.Next()
	}
}

// generateRequestID 生成唯一的请求ID
func generateRequestID() string {
	now := time.Now()
	timestamp := now.Format("20060102150405")
	nano := now.Nanosecond() / 1000000 // 毫秒
	return fmt.Sprintf("req_%s_%03d", timestamp, nano%1000)
}

// convertQuery 转换查询参数
func convertQuery(query map[string][]string) map[string]any {
	result := make(map[string]any)
	for k, v := range query {
		if len(v) == 1 {
			result[k] = v[0]
		} else {
			result[k] = v
		}
	}
	return result
}

// convertHeaders 转换请求头
func convertHeaders(headers map[string][]string) map[string]any {
	result := make(map[string]any)
	for k, v := range headers {
		if len(v) == 1 {
			result[k] = v[0]
		} else {
			result[k] = v
		}
	}
	return result
}

// logWriter 日志写入协程，批量处理日志写入
func (rl *RequestLogger) logWriter() {
	defer func() {
		rl.doneChan <- true
	}()

	// 批量写入缓冲区
	buffer := make(map[string][]RequestLogData) // key: 文件路径, value: 日志数据列表
	ticker := time.NewTicker(5 * time.Second)   // 每5秒强制刷新一次
	defer ticker.Stop()

	flushBuffer := func() {
		for filepath, logs := range buffer {
			if len(logs) > 0 {
				if err := rl.batchWriteToFile(filepath, logs); err != nil {
					log.Errorf("Failed to write batch logs to %s: %v", filepath, err)
				}
			}
		}
		// 清空缓冲区
		for k := range buffer {
			delete(buffer, k)
		}
	}

	for {
		select {
		case logData := <-rl.logChan:
			// 确保日志目录存在
			if err := os.MkdirAll(rl.config.LogDir, 0755); err != nil {
				log.Errorf("Failed to create log directory: %v", err)
				continue
			}

			// 按日期组织文件
			date := time.Now().Format("2006-01-02")
			filename := fmt.Sprintf("claude-requests-%s.json", date)
			filepath := filepath.Join(rl.config.LogDir, filename)

			// 添加到缓冲区
			buffer[filepath] = append(buffer[filepath], logData)

			// 如果缓冲区达到一定大小，立即写入
			if len(buffer[filepath]) >= 50 { // 每50条记录写入一次
				if err := rl.batchWriteToFile(filepath, buffer[filepath]); err != nil {
					log.Errorf("Failed to write batch logs to %s: %v", filepath, err)
				}
				delete(buffer, filepath)
			}

		case <-ticker.C:
			// 定时刷新缓冲区
			flushBuffer()

		case <-rl.stopChan:
			// 收到停止信号，刷新所有缓冲区并退出
			flushBuffer()
			// 处理剩余的日志
			for {
				select {
				case logData := <-rl.logChan:
					date := time.Now().Format("2006-01-02")
					filename := fmt.Sprintf("claude-requests-%s.json", date)
					filepath := filepath.Join(rl.config.LogDir, filename)
					buffer[filepath] = append(buffer[filepath], logData)
				default:
					// 没有更多日志，最后刷新一次
					flushBuffer()
					return
				}
			}
		}
	}
}

// batchWriteToFile 批量写入日志到文件
func (rl *RequestLogger) batchWriteToFile(filepath string, newLogs []RequestLogData) error {
	// 读取现有日志
	var existingLogs []RequestLogData
	if content, err := os.ReadFile(filepath); err == nil {
		if err := json.Unmarshal(content, &existingLogs); err != nil {
			log.Warnf("Failed to parse existing log file %s: %v", filepath, err)
			existingLogs = []RequestLogData{}
		}
	}

	// 合并新日志
	allLogs := append(existingLogs, newLogs...)

	// 限制记录数量
	if len(allLogs) > rl.config.MaxRecordsPerFile {
		allLogs = allLogs[len(allLogs)-rl.config.MaxRecordsPerFile:]
	}

	// 写入文件
	content, err := json.MarshalIndent(allLogs, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal logs: %w", err)
	}

	if err := os.WriteFile(filepath, content, 0644); err != nil {
		return fmt.Errorf("failed to write log file: %w", err)
	}

	filename := filepath[strings.LastIndex(filepath, "/")+1:]
	log.Debugf("Batch wrote %d logs to: %s (total: %d records)", len(newLogs), filename, len(allLogs))
	return nil
}

// Cleanup 清理过期的日志文件
func (rl *RequestLogger) Cleanup() error {
	if !rl.config.Enabled {
		return nil
	}

	cutoffDate := time.Now().AddDate(0, 0, -rl.config.RetentionDays)
	
	entries, err := os.ReadDir(rl.config.LogDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil // 目录不存在，无需清理
		}
		return fmt.Errorf("failed to read log directory: %w", err)
	}

	deletedCount := 0
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		
		name := entry.Name()
		if !strings.HasPrefix(name, "claude-requests-") || !strings.HasSuffix(name, ".json") {
			continue
		}

		info, err := entry.Info()
		if err != nil {
			continue
		}

		if info.ModTime().Before(cutoffDate) {
			filepath := filepath.Join(rl.config.LogDir, name)
			if err := os.Remove(filepath); err != nil {
				log.Warnf("Failed to delete old log file %s: %v", name, err)
			} else {
				deletedCount++
				log.Debugf("Deleted old request log: %s", name)
			}
		}
	}

	if deletedCount > 0 {
		log.Infof("Cleaned up %d old request log files", deletedCount)
	}

	return nil
}