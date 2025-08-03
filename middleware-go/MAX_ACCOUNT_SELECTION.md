# MAX 账号选择功能

## 功能说明

middleware-go 现在支持基于模型类型的智能账号选择，特别是为 `claude-opus-4-20250514` 模型提供 MAX 账号优先选择。

## 核心特性

### 1. MAX 账号识别

支持两种方式识别 MAX 账号：

1. **Redis 字段识别**：从 Redis 中的 `isMAX` 字段读取
2. **名称规则识别**：账号名称以 "MAX" 开头的自动识别为 MAX 账号

```go
// Redis 中的账号数据示例
{
  "id": "account-123",
  "name": "MAX-Account-1", 
  "isActive": "true",
  "isMAX": "true",  // 可选字段
  "status": "active"
}

// 或者仅通过名称识别
{
  "id": "account-456", 
  "name": "MAX-Premium-Account",  // 以 MAX 开头，自动识别为 MAX 账号
  "isActive": "true",
  "status": "active"
}
```

### 2. 模型检测

系统会自动检测请求中的模型类型：

**仅从请求体 JSON 解析**：`{"model": "模型名称"}`

**MAX 账号触发规则**：包含 `claude-opus-4` 的模型名称都会使用 MAX 账号，例如：
- `claude-opus-4-20250514`
- `claude-opus-4-20250601` 
- `claude-opus-4-preview`
- `claude-opus-4`
- `new-claude-opus-4-model`

**注意**：系统不再从 URL 路径解析模型信息，只从 JSON 请求体中的 `model` 字段获取模型名称。如果请求体中没有 `model` 字段或 JSON 格式无效，将被视为普通请求，使用常规账号选择策略。

### 3. 账号选择策略

#### 对于包含 claude-opus-4 的模型：
1. **优先级 1**：可用的 MAX 账号
2. **优先级 2**：限流中的 MAX 账号  
3. **优先级 3**：有问题的 MAX 账号
4. **备选方案**：如果没有 MAX 账号，使用普通账号（会记录警告）

#### 对于其他模型：
1. **优先级 1**：所有可用账号（包括 MAX 和普通）
2. **优先级 2**：限流中的账号
3. **优先级 3**：有问题的账号

## 日志示例

```
🔍 Model detected: 'claude-opus-4-20250601', requires MAX account: true
📊 Account status: 3 available (2 MAX), 1 rate-limited (0 MAX), 0 problematic (0 MAX)
🎯 Using MAX available accounts for Opus model
✅ Selected MAX account: account-123 (MAX-Account-1)
```

```
🔍 Model detected: 'claude-sonnet-3-5', requires MAX account: false  
📊 Account status: 5 available (2 MAX), 0 rate-limited (0 MAX), 0 problematic (0 MAX)
🎯 Using all available accounts for regular model
✅ Selected regular account: account-789 (Regular-Account-2)
```

**说明**：任何包含 `claude-opus-4` 的模型名称都会触发 MAX 账号选择策略。当检测不到模型（如空请求体、无效 JSON 等）时，`Model detected` 会显示为空字符串，系统将使用常规账号选择策略。

## 配置建议

### 在 Redis 中标记 MAX 账号

```bash
# 方法 1：设置 isMAX 字段
redis-cli HSET claude:account:123 isMAX true

# 方法 2：确保账号名称以 MAX 开头
redis-cli HSET claude:account:456 name "MAX-Premium-Account"
```

### 账号命名规范

建议的 MAX 账号命名：
- `MAX-Account-1`
- `MAX-Premium-001` 
- `MAX-Opus-Primary`

普通账号命名：
- `Regular-Account-1`
- `Standard-001`
- `Basic-Account`

## 兼容性

- **向后兼容**：现有账号无需修改，会继续正常工作
- **渐进升级**：可以逐步为高级账号添加 MAX 标识
- **优雅降级**：如果没有 MAX 账号，Opus 模型会使用普通账号

## 监控建议

通过日志监控以下指标：
1. Opus 模型的 MAX 账号使用率
2. MAX 账号的限流频率  
3. 是否有 Opus 请求被分配到普通账号（应该避免）

## 扩展性

该架构易于扩展，未来可以支持：
- 更多模型类型的特殊账号要求
- 基于用户等级的账号分配
- 动态账号优先级调整