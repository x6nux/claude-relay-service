const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const config = require('../../config/config');
const redis = require('../models/redis');
const logger = require('../utils/logger');

class ApiKeyService {
  constructor() {
    this.prefix = config.security.apiKeyPrefix;
  }

  // 🔑 生成新的API Key
  async generateApiKey(options = {}) {
    const {
      name = 'Unnamed Key',
      description = '',
      tokenLimit = config.limits.defaultTokenLimit,
      expiresAt = null,
      claudeAccountId = null,
      geminiAccountId = null,
      permissions = 'all', // 'claude', 'gemini', 'all'
      isActive = true,
      concurrencyLimit = 0,
      rateLimitWindow = null,
      rateLimitRequests = null,
      enableModelRestriction = false,
      restrictedModels = [],
      enableClientRestriction = false,
      allowedClients = [],
      dailyCostLimit = 0
    } = options;

    // 生成简单的API Key (64字符十六进制)
    const apiKey = `${this.prefix}${this._generateSecretKey()}`;
    const keyId = uuidv4();
    const hashedKey = this._hashApiKey(apiKey);
    
    const keyData = {
      id: keyId,
      name,
      description,
      apiKey: hashedKey,
      tokenLimit: String(tokenLimit ?? 0),
      concurrencyLimit: String(concurrencyLimit ?? 0),
      rateLimitWindow: String(rateLimitWindow ?? 0),
      rateLimitRequests: String(rateLimitRequests ?? 0),
      isActive: String(isActive),
      claudeAccountId: claudeAccountId || '',
      geminiAccountId: geminiAccountId || '',
      permissions: permissions || 'all',
      enableModelRestriction: String(enableModelRestriction),
      restrictedModels: JSON.stringify(restrictedModels || []),
      enableClientRestriction: String(enableClientRestriction || false),
      allowedClients: JSON.stringify(allowedClients || []),
      dailyCostLimit: String(dailyCostLimit || 0),
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      expiresAt: expiresAt || '',
      createdBy: 'admin' // 可以根据需要扩展用户系统
    };

    // 保存API Key数据并建立哈希映射
    await redis.setApiKey(keyId, keyData, hashedKey);
    
    
    logger.success(`🔑 Generated new API key: ${name} (${keyId})`);
    
    return {
      id: keyId,
      apiKey, // 只在创建时返回完整的key
      name: keyData.name,
      description: keyData.description,
      tokenLimit: parseInt(keyData.tokenLimit),
      concurrencyLimit: parseInt(keyData.concurrencyLimit),
      rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
      rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
      isActive: keyData.isActive === 'true',
      claudeAccountId: keyData.claudeAccountId,
      geminiAccountId: keyData.geminiAccountId,
      permissions: keyData.permissions,
      enableModelRestriction: keyData.enableModelRestriction === 'true',
      restrictedModels: JSON.parse(keyData.restrictedModels),
      enableClientRestriction: keyData.enableClientRestriction === 'true',
      allowedClients: JSON.parse(keyData.allowedClients || '[]'),
      dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      createdBy: keyData.createdBy
    };
  }

  // 🔍 验证API Key  
  async validateApiKey(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' };
      }

      // 计算API Key的哈希值
      const hashedKey = this._hashApiKey(apiKey);
      
      // 通过哈希值直接查找API Key（性能优化）
      const keyData = await redis.findApiKeyByHash(hashedKey);
      
      if (!keyData) {
        return { valid: false, error: 'API key not found' };
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        return { valid: false, error: 'API key is disabled' };
      }

      // 检查是否过期
      if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
        return { valid: false, error: 'API key has expired' };
      }

      // 获取使用统计（供返回数据使用）
      const usage = await redis.getUsageStats(keyData.id);
      
      // 获取当日费用统计
      const dailyCost = await redis.getDailyCost(keyData.id);

      // 更新最后使用时间（优化：只在实际API调用时更新，而不是验证时）
      // 注意：lastUsedAt的更新已移至recordUsage方法中

      logger.api(`🔓 API key validated successfully: ${keyData.id}`);

      // 解析限制模型数据
      let restrictedModels = [];
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : [];
      } catch (e) {
        restrictedModels = [];
      }

      // 解析允许的客户端
      let allowedClients = [];
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : [];
      } catch (e) {
        allowedClients = [];
      }

      return {
        valid: true,
        keyData: {
          id: keyData.id,
          name: keyData.name,
          description: keyData.description,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          claudeAccountId: keyData.claudeAccountId,
          geminiAccountId: keyData.geminiAccountId,
          permissions: keyData.permissions || 'all',
          tokenLimit: parseInt(keyData.tokenLimit),
          concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
          rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
          rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
          enableModelRestriction: keyData.enableModelRestriction === 'true',
          restrictedModels: restrictedModels,
          enableClientRestriction: keyData.enableClientRestriction === 'true',
          allowedClients: allowedClients,
          dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
          dailyCost: dailyCost || 0,
          usage
        }
      };
    } catch (error) {
      logger.error('❌ API key validation error:', error);
      return { valid: false, error: 'Internal validation error' };
    }
  }

  // 📋 获取所有API Keys
  async getAllApiKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys();
      
      // 为每个key添加使用统计和当前并发数
      for (const key of apiKeys) {
        key.usage = await redis.getUsageStats(key.id);
        key.tokenLimit = parseInt(key.tokenLimit);
        key.concurrencyLimit = parseInt(key.concurrencyLimit || 0);
        key.rateLimitWindow = parseInt(key.rateLimitWindow || 0);
        key.rateLimitRequests = parseInt(key.rateLimitRequests || 0);
        key.currentConcurrency = await redis.getConcurrency(key.id);
        key.isActive = key.isActive === 'true';
        key.enableModelRestriction = key.enableModelRestriction === 'true';
        key.enableClientRestriction = key.enableClientRestriction === 'true';
        key.permissions = key.permissions || 'all'; // 兼容旧数据
        key.dailyCostLimit = parseFloat(key.dailyCostLimit || 0);
        key.dailyCost = await redis.getDailyCost(key.id) || 0;
        try {
          key.restrictedModels = key.restrictedModels ? JSON.parse(key.restrictedModels) : [];
        } catch (e) {
          key.restrictedModels = [];
        }
        try {
          key.allowedClients = key.allowedClients ? JSON.parse(key.allowedClients) : [];
        } catch (e) {
          key.allowedClients = [];
        }
        
        delete key.apiKey; // 不返回哈希后的key
      }

      return apiKeys;
    } catch (error) {
      logger.error('❌ Failed to get API keys:', error);
      throw error;
    }
  }

  // 📝 更新API Key
  async updateApiKey(keyId, updates) {
    try {
      const keyData = await redis.getApiKey(keyId);
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found');
      }

      // 允许更新的字段
      const allowedUpdates = ['name', 'description', 'tokenLimit', 'concurrencyLimit', 'rateLimitWindow', 'rateLimitRequests', 'isActive', 'claudeAccountId', 'geminiAccountId', 'permissions', 'expiresAt', 'enableModelRestriction', 'restrictedModels', 'enableClientRestriction', 'allowedClients', 'dailyCostLimit'];
      const updatedData = { ...keyData };
      
      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          if (field === 'restrictedModels' || field === 'allowedClients') {
            // 特殊处理数组字段
            updatedData[field] = JSON.stringify(value || []);
          } else if (field === 'enableModelRestriction' || field === 'enableClientRestriction') {
            // 布尔值转字符串
            updatedData[field] = String(value);
          } else {
            updatedData[field] = (value != null ? value : '').toString();
          }
        }
      }

      updatedData.updatedAt = new Date().toISOString();
      
      // 更新时不需要重新建立哈希映射，因为API Key本身没有变化
      await redis.setApiKey(keyId, updatedData);
      
      logger.success(`📝 Updated API key: ${keyId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to update API key:', error);
      throw error;
    }
  }

  // 🗑️ 删除API Key
  async deleteApiKey(keyId) {
    try {
      const result = await redis.deleteApiKey(keyId);
      
      if (result === 0) {
        throw new Error('API key not found');
      }
      
      logger.success(`🗑️ Deleted API key: ${keyId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error);
      throw error;
    }
  }

  // 📊 记录使用情况（支持缓存token、账户级别和共享池统计）
  async recordUsage(keyId, inputTokens = 0, outputTokens = 0, cacheCreateTokens = 0, cacheReadTokens = 0, model = 'unknown', accountId = null, poolId = null) {
    try {
      // 检查是否是账户直接认证
      if (keyId && keyId.startsWith('account_')) {
        // 账户直接认证不记录API Key级别的使用统计，只记录账户级别
        const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
        
        if (accountId) {
          await redis.incrementAccountUsage(accountId, totalTokens, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model);
          logger.database(`📊 Recorded direct account usage: ${accountId} - ${totalTokens} tokens`);
        }
        
        return;
      }
      
      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
      
      // 计算费用
      const CostCalculator = require('../utils/costCalculator');
      const costInfo = CostCalculator.calculateCost({
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreateTokens,
        cache_read_input_tokens: cacheReadTokens
      }, model);
      
      // 记录API Key级别的使用统计
      await redis.incrementTokenUsage(keyId, totalTokens, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model);
      
      // 记录费用统计
      if (costInfo.costs.total > 0) {
        await redis.incrementDailyCost(keyId, costInfo.costs.total);
        logger.database(`💰 Recorded cost for ${keyId}: $${costInfo.costs.total.toFixed(6)}, model: ${model}`);
      } else {
        logger.debug(`💰 No cost recorded for ${keyId} - zero cost for model: ${model}`);
      }
      
      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId);
      if (keyData && Object.keys(keyData).length > 0) {
        // 更新最后使用时间
        keyData.lastUsedAt = new Date().toISOString();
        await redis.setApiKey(keyId, keyData);
        
        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(accountId, totalTokens, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model);
          logger.database(`📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`);
        } else {
          logger.debug('⚠️ No accountId provided for usage recording, skipping account-level statistics');
        }
        
        // 记录共享池级别的使用统计
        if (poolId && accountId) {
          await redis.incrementPoolUsage(poolId, accountId, totalTokens, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model);
          logger.database(`🏊 Recorded pool usage: ${poolId} - ${totalTokens} tokens (Account: ${accountId})`);
        }
      }
      
      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`];
      if (cacheCreateTokens > 0) logParts.push(`Cache Create: ${cacheCreateTokens}`);
      if (cacheReadTokens > 0) logParts.push(`Cache Read: ${cacheReadTokens}`);
      logParts.push(`Total: ${totalTokens} tokens`);
      
      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`);
    } catch (error) {
      logger.error('❌ Failed to record usage:', error);
    }
  }

  // 🔐 生成密钥
  _generateSecretKey() {
    return crypto.randomBytes(32).toString('hex');
  }

  // 🔒 哈希API Key
  _hashApiKey(apiKey) {
    return crypto.createHash('sha256').update(apiKey + config.security.encryptionKey).digest('hex');
  }

  // 📈 获取使用统计
  async getUsageStats(keyId) {
    // 检查是否是账户直接认证
    if (keyId && keyId.startsWith('account_')) {
      // 提取实际的账户ID
      const accountId = keyId.replace('account_', '');
      // 获取账户级别的使用统计
      return await redis.getAccountUsageStats(accountId);
    }
    
    return await redis.getUsageStats(keyId);
  }

  // 📊 获取账户使用统计
  async getAccountUsageStats(accountId) {
    return await redis.getAccountUsageStats(accountId);
  }

  // 📈 获取所有账户使用统计
  async getAllAccountsUsageStats() {
    return await redis.getAllAccountsUsageStats();
  }


  // 🧹 清理过期的API Keys
  async cleanupExpiredKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys();
      const now = new Date();
      let cleanedCount = 0;

      for (const key of apiKeys) {
        // 检查是否已过期且仍处于激活状态
        if (key.expiresAt && new Date(key.expiresAt) < now && key.isActive === 'true') {
          // 将过期的 API Key 标记为禁用状态，而不是直接删除
          await this.updateApiKey(key.id, { isActive: false });
          logger.info(`🔒 API Key ${key.id} (${key.name}) has expired and been disabled`);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Disabled ${cleanedCount} expired API keys`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('❌ Failed to cleanup expired keys:', error);
      return 0;
    }
  }

}

// 导出实例和单独的方法
const apiKeyService = new ApiKeyService();

// 为了方便其他服务调用，导出 recordUsage 方法
apiKeyService.recordUsageMetrics = apiKeyService.recordUsage.bind(apiKeyService);

module.exports = apiKeyService;