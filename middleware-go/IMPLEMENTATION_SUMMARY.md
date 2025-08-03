# Middleware-Go MAX 账号选择功能实现完成

## 实现总结

已成功为 middleware-go 添加了智能的 MAX 账号选择功能，特别针对 `claude-opus-4-20250514` 模型的需求。

## 完成的功能

### 1. **MAX 账号识别** ✅
- 添加了 `IsMAX` 字段到 `ClaudeAccount` 结构体
- 支持从 Redis `isMAX` 字段读取 MAX 标识
- 实现基于账号名称的自动识别（以 "MAX" 开头）
- 向后兼容现有账号数据

### 2. **模型检测** ✅
- 创建了 `ModelDetector` 实现智能模型识别
- **仅支持从 JSON 请求体解析模型名称**：`{"model": "模型名称"}`
- **灵活匹配规则**：包含 `claude-opus-4` 的模型都使用 MAX 账号
- 移除了 URL 路径解析功能，确保检测的精确性
- 支持模型版本变化，如 `claude-opus-4-20250514`、`claude-opus-4-preview` 等

### 3. **智能账号选择** ✅
- 重构了 `selectAvailableAccount` 和 `selectAvailableAccountExcluding` 函数
- 实现基于模型类型的差异化选择策略：
  - **包含 claude-opus-4 的模型**：优先使用 MAX 账号（可用 > 限流 > 有问题）
  - **其他模型**：使用所有账号（节省 MAX 资源）
- 完整的降级策略，确保服务可用性

### 4. **请求处理优化** ✅
- 修改 `ProxyHandler` 提前读取请求体用于模型检测
- 更新重试逻辑传递模型信息
- 保持 context 传递机制完整性

### 5. **完善的日志** ✅
- 详细的账号分类日志（MAX vs 普通账号）
- 模型检测结果记录
- 账号选择决策过程可视化
- 便于监控和调试

## 关键代码结构

```
internal/
├── redis/
│   └── client.go           # 添加 IsMAX 字段支持
├── proxy/
│   ├── service.go          # 核心账号选择逻辑
│   ├── model_detector.go   # 模型检测功能
│   ├── context.go          # Context 传递机制
│   └── middleware.go       # 可选中间件
└── 文档/
    ├── MAX_ACCOUNT_SELECTION.md    # 功能使用说明
    ├── PER_REQUEST_FETCHING.md     # 请求时获取说明
    └── RATE_LIMIT_CONFIG.md        # 限流配置说明
```

## 使用示例

### 配置 MAX 账号
```bash
# 方法 1：设置 isMAX 字段
redis-cli HSET claude:account:123 isMAX true

# 方法 2：账号名称以 MAX 开头
redis-cli HSET claude:account:456 name "MAX-Premium-Account"
```

### 日志示例
```
🔍 Model detected: 'claude-opus-4-20250514', requires MAX account: true
📊 Account status: 3 available (2 MAX), 1 rate-limited (0 MAX), 0 problematic (0 MAX)
🎯 Using MAX available accounts for Opus model
✅ Selected MAX account: account-123 (MAX-Account-1)
```

### 测试验证

- ✅ claude-opus-4 模型匹配测试（10/10 通过）
- ✅ 编译成功验证
- ✅ 向后兼容性确认
- ✅ 支持各种 claude-opus-4 版本变体
- ✅ 正确排除非 opus-4 模型

## 技术优势

1. **精准识别**：双重识别机制确保 MAX 账号正确标识
2. **智能分配**：基于模型类型的差异化策略
3. **资源优化**：普通模型避免占用 MAX 账号资源
4. **高可用性**：完整的降级和重试机制
5. **易于监控**：详细的日志便于运维
6. **检测精确**：仅从JSON模型字段获取，避免URL误判
7. **版本兼容**：支持 claude-opus-4 的各种版本变体

## 兼容性保证

- 现有账号无需修改即可正常工作
- 渐进式升级，可逐步添加 MAX 标识
- 优雅降级，没有 MAX 账号时自动使用普通账号

这个实现完全满足了包含 `claude-opus-4` 的模型使用 MAX 账号的需求，具备良好的版本兼容性，能够适应未来可能的模型版本变化，同时保持了系统的灵活性和可扩展性。