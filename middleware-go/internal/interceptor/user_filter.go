package interceptor

import (
	"encoding/json"
	"fmt"
	"strings"
)

// 模型配置常量
const (
	// Haiku 模型相关配置
	HaikuModel          = "claude-3-5-haiku-20241022"
	HaikuMaxTokens      = 1024
	HaikuBashContent    = "Your task is to process Bash commands that an AI coding agent wants to run."
	HaikuExtractContent = "Extract any file paths that this command reads or modifies. For commands like"

	// Sonnet/Opus 模型相关配置
	SonnetModel       = "claude-sonnet-4-20250514"
	OpusModel         = "claude-opus-4-20250514"
	ClaudeCodeContent = "You are Claude Code, Anthropic's official CLI for Claude"
	JsonSchemaContent = "http://json-schema.org/draft-07/schema#"
)

// Content 消息内容结构 - 使用更灵活的解析方式
type Content struct {
	Text string `json:"text,omitempty"`
	Type string `json:"type,omitempty"`
	// CacheControl 设为指针类型，这样 omitempty 才有效果
	CacheControl *CacheControl `json:"cache_control,omitempty"`
}

// CacheControl 缓存控制结构
type CacheControl struct {
	Type string `json:"type"`
}

// Message 消息结构 - 支持 content 既可以是字符串也可以是对象数组
type Message struct {
	Content json.RawMessage `json:"content"` // 使用 RawMessage 处理不同格式
	Role    string          `json:"role"`
}

// SystemMessage 系统消息结构 - 同样使用灵活的解析
type SystemMessage struct {
	// CacheControl 设为指针类型，这样 omitempty 才有效果
	CacheControl *CacheControl   `json:"cache_control,omitempty"`
	Text         string          `json:"text,omitempty"`
	Type         string          `json:"type,omitempty"`
	Content      json.RawMessage `json:"content,omitempty"` // 有些系统消息可能用 content 字段
}

// Tool 工具结构 - 简化版本，只保留基本字段
type Tool struct {
	Description string `json:"description"`
	InputSchema any    `json:"input_schema"` // 使用 any 替代 interface{}
	Name        string `json:"name"`
}

// Body Claude API 请求体结构
type Body struct {
	MaxTokens   int             `json:"max_tokens"`
	Messages    []Message       `json:"messages"`
	Model       string          `json:"model"`
	Stream      bool            `json:"stream"`
	System      json.RawMessage `json:"system,omitempty"`      // 使用 RawMessage 处理不同格式
	Temperature float64         `json:"temperature,omitempty"` // 改为 float64 支持小数
	Tools       []Tool          `json:"tools,omitempty"`
}

// UserFilter 用户自定义过滤函数
// 这是一个预留的函数，用户可以在这里编写自己的过滤规则
// 返回 true 表示允许请求通过，false 表示拦截请求
func UserFilter(ctx *InterceptorContext) bool {
	body := &Body{}
	err := json.Unmarshal(ctx.Request.Body, body)
	if err != nil {
		fmt.Printf("[ERROR] Failed to unmarshal request body: %v\n", err)
		return false
	}
	bodyStr := string(ctx.Request.Body)
	//1.检查请求头 X-Api-Key = cr_fdawjfbouisnodnawodnsdnawsw
	if ctx.Request.Headers["X-Api-Key"] != nil && ctx.Request.Headers["X-Api-Key"][0] != "cr_fdawjfbouisnodnawodnsdnawsw" {
		return false
	}
	if !body.Stream && strings.Contains(bodyStr, "You just need to output 'hi' next.") {
		return true
	}
	//基于模型检查
	switch body.Model {
	case HaikuModel:
		//max-token
		if body.MaxTokens > HaikuMaxTokens {
			return false
		}
		//内容匹配
		if !strings.Contains(bodyStr, HaikuBashContent) && !strings.Contains(bodyStr, HaikuExtractContent) {
			return false
		}
		return true
		//内容匹配
	case SonnetModel, OpusModel:
		if !strings.Contains(bodyStr, ClaudeCodeContent) && !strings.Contains(bodyStr, JsonSchemaContent) {
			return false
		}
	}
	// 默认允许通过
	return true
}

// CreateRequestInterceptor 创建配置好的请求拦截器
func CreateRequestInterceptor() *RequestInterceptor {
	// 创建拦截器实例
	requestInterceptor := NewRequestInterceptor(
		WithEnabled(true),      // 必须启用
		WithFilter(UserFilter), // 添加用户自定义过滤函数
	)

	fmt.Printf("[INFO] Request interceptor initialized with %d filter(s)\n", requestInterceptor.GetFilterCount())

	return requestInterceptor
}
