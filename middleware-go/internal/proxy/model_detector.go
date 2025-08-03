package proxy

import (
	"encoding/json"
	"strings"
)

// ModelDetector 模型检测器
type ModelDetector struct{}

// RequestBody 请求体结构，用于解析模型信息
type RequestBody struct {
	Model   string `json:"model"`
	// 可能还有其他字段，但我们只关心 model
}

// ExtractModelFromRequest 从请求体中提取模型名称
func (md *ModelDetector) ExtractModelFromRequest(requestBody []byte, requestPath string) string {
	// 仅从请求体JSON中解析模型
	if len(requestBody) > 0 {
		var body RequestBody
		if err := json.Unmarshal(requestBody, &body); err == nil && body.Model != "" {
			return body.Model
		}
	}
	
	// 如果请求体中没有模型信息，返回空字符串
	return ""
}

// IsOpusModel 检查是否为 Opus 模型
func (md *ModelDetector) IsOpusModel(model string) bool {
	// 包含 "claude-opus-4" 的模型都视为 Opus 模型
	return strings.Contains(model, "claude-opus-4")
}

// RequiresMAXAccount 检查模型是否需要 MAX 账号
func (md *ModelDetector) RequiresMAXAccount(model string) bool {
	return md.IsOpusModel(model)
}