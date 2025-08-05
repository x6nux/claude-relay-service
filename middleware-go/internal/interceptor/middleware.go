package interceptor

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

// RequestData 请求数据结构
type RequestData struct {
	ID        string              `json:"id"`
	Timestamp time.Time           `json:"timestamp"`
	Method    string              `json:"method"`
	URL       string              `json:"url"`
	Path      string              `json:"path"`
	Headers   map[string][]string `json:"headers"`
	Body      []byte              `json:"body"`
	ClientIP  string              `json:"client_ip"`
	UserAgent string              `json:"user_agent"`
}

// ResponseData 响应数据结构
type ResponseData struct {
	StatusCode int                 `json:"status_code"`
	Headers    map[string][]string `json:"headers"`
	Body       interface{}         `json:"body"`
	Size       int64               `json:"size"`
}

// InterceptorContext 拦截器上下文
type InterceptorContext struct {
	Request   *RequestData  `json:"request"`
	Response  *ResponseData `json:"response,omitempty"`
	StartTime time.Time     `json:"start_time"`
	EndTime   time.Time     `json:"end_time,omitempty"`
	Duration  time.Duration `json:"duration,omitempty"`
}

// FilterFunc 过滤规则函数类型
// 返回 true 表示允许通过，false 表示拦截
type FilterFunc func(ctx *InterceptorContext) bool

// InterceptorOption 拦截器选项函数类型
type InterceptorOption func(*RequestInterceptor)

// InterceptorConfig 拦截器配置
type InterceptorConfig struct {
	Enabled bool `json:"enabled"`
}

// RequestInterceptor 请求拦截器
type RequestInterceptor struct {
	config      *InterceptorConfig
	filterFuncs []FilterFunc
}

// NewRequestInterceptor 创建新的请求拦截器
func NewRequestInterceptor(options ...InterceptorOption) *RequestInterceptor {
	interceptor := &RequestInterceptor{
		config: &InterceptorConfig{
			Enabled: true, // 默认启用
		},
		filterFuncs: make([]FilterFunc, 0),
	}

	// 应用所有选项
	for _, option := range options {
		option(interceptor)
	}

	return interceptor
}

// WithEnabled 设置是否启用拦截器
func WithEnabled(enabled bool) InterceptorOption {
	return func(ri *RequestInterceptor) {
		ri.config.Enabled = enabled
	}
}

// WithFilter 添加过滤规则函数
func WithFilter(filterFunc FilterFunc) InterceptorOption {
	return func(ri *RequestInterceptor) {
		if filterFunc != nil {
			ri.filterFuncs = append(ri.filterFuncs, filterFunc)
		}
	}
}

// WithFilters 批量添加多个过滤规则函数
func WithFilters(filterFuncs ...FilterFunc) InterceptorOption {
	return func(ri *RequestInterceptor) {
		for _, filterFunc := range filterFuncs {
			if filterFunc != nil {
				ri.filterFuncs = append(ri.filterFuncs, filterFunc)
			}
		}
	}
}

// AddFilter 动态添加过滤规则函数
func (ri *RequestInterceptor) AddFilter(filterFunc FilterFunc) {
	if filterFunc != nil {
		ri.filterFuncs = append(ri.filterFuncs, filterFunc)
	}
}

// ClearFilters 清空所有过滤函数
func (ri *RequestInterceptor) ClearFilters() {
	ri.filterFuncs = ri.filterFuncs[:0]
}

// GetFilterCount 获取当前过滤函数数量
func (ri *RequestInterceptor) GetFilterCount() int {
	return len(ri.filterFuncs)
}

// Middleware 返回Gin中间件函数
func (ri *RequestInterceptor) Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		// 如果拦截器未启用，直接通过
		if !ri.config.Enabled {
			c.Next()
			return
		}

		startTime := time.Now()

		// 构建请求数据
		requestData, err := ri.buildRequestData(c)
		if err != nil {
		fmt.Printf("[ERROR] Failed to build request data: %v\n", err)
			c.Next()
			return
		}

		// 创建拦截器上下文
		interceptorCtx := &InterceptorContext{
			Request:   requestData,
			StartTime: startTime,
		}

		// 执行所有过滤规则（AND逻辑：所有过滤器都必须返回true才允许通过）
		allowed := ri.executeFilters(interceptorCtx)

		if !allowed {
			fmt.Printf("[WARN] Request blocked by interceptor: %s %s from %s\n",
				requestData.Method, requestData.Path, requestData.ClientIP)

			c.JSON(http.StatusForbidden, gin.H{
				"error":     "请求被拦截",
				"message":   "该请求已被拦截器阻止，如有疑问请联系系统管理员",
				"timestamp": time.Now().Format(time.RFC3339),
			})
			c.Abort()
			return
		}

		// 使用自定义响应写入器来捕获响应数据
		responseWriter := &responseWriterWrapper{
			ResponseWriter: c.Writer,
			body:           &bytes.Buffer{},
		}
		c.Writer = responseWriter

		// 继续处理请求
		c.Next()

		// 处理完成后记录响应信息
		endTime := time.Now()
		interceptorCtx.EndTime = endTime
		interceptorCtx.Duration = endTime.Sub(startTime)

		// 构建响应数据
		responseData := &ResponseData{
			StatusCode: responseWriter.Status(),
			Headers:    responseWriter.Header(),
			Size:       int64(responseWriter.body.Len()),
		}

		// 尝试解析响应体
		if responseWriter.body.Len() > 0 {
			bodyBytes := responseWriter.body.Bytes()
			var jsonBody interface{}
			if err := json.Unmarshal(bodyBytes, &jsonBody); err == nil {
				responseData.Body = jsonBody
			} else {
				responseData.Body = string(bodyBytes)
			}
		}

		interceptorCtx.Response = responseData

		// 记录处理完成的日志
		fmt.Printf("[DEBUG] Request processed: %s %s - %d - %v\n",
			requestData.Method, requestData.Path,
			responseData.StatusCode, interceptorCtx.Duration)
	}
}

// executeFilters 执行所有过滤函数
func (ri *RequestInterceptor) executeFilters(ctx *InterceptorContext) bool {
	// 如果没有过滤函数，默认允许通过
	if len(ri.filterFuncs) == 0 {
		return true
	}

	// 执行所有过滤函数（AND逻辑）
	for i, filterFunc := range ri.filterFuncs {
		allowed := filterFunc(ctx)
		if !allowed {
			fmt.Printf("[DEBUG] Request blocked by filter #%d\n", i+1)
			return false
		}
	}

	return true
}

// buildRequestData 构建请求数据
func (ri *RequestInterceptor) buildRequestData(c *gin.Context) (*RequestData, error) {
	// 读取请求体
	var bodyBytes []byte
	var err error
	if c.Request.Body != nil {
		bodyBytes, err = io.ReadAll(c.Request.Body)
		if err != nil {
			return nil, err
		}

		// 恢复请求体，让后续处理器可以读取
		c.Request.Body = io.NopCloser(bytes.NewBuffer(bodyBytes))
	}

	// 生成请求ID
	requestID := generateRequestID()

	requestData := &RequestData{
		ID:        requestID,
		Timestamp: time.Now(),
		Method:    c.Request.Method,
		URL:       c.Request.URL.String(),
		Path:      c.Request.URL.Path,
		Headers:   c.Request.Header,
		Body:      bodyBytes,
		ClientIP:  c.ClientIP(),
		UserAgent: c.Request.UserAgent(),
	}

	return requestData, nil
}

// generateRequestID 生成唯一的请求ID
func generateRequestID() string {
	now := time.Now()
	return now.Format("20060102150405") + "-" + now.Format("000000000")[0:6]
}

// responseWriterWrapper 响应写入器包装器
type responseWriterWrapper struct {
	gin.ResponseWriter
	body *bytes.Buffer
}

func (w *responseWriterWrapper) Write(data []byte) (int, error) {
	// 同时写入原始响应和缓冲区
	w.body.Write(data)
	return w.ResponseWriter.Write(data)
}

func (w *responseWriterWrapper) WriteString(s string) (int, error) {
	// 同时写入原始响应和缓冲区
	w.body.WriteString(s)
	return w.ResponseWriter.WriteString(s)
}
