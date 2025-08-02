const { v4: uuidv4 } = require('uuid');
const redis = require('../models/redis');
const logger = require('../utils/logger');

class SharedPoolService {
  constructor() {
    // 共享池相关常量
    this.POOL_KEY_PREFIX = 'shared_pool:';
    this.POOL_ACCOUNTS_KEY_PREFIX = 'shared_pool_accounts:';
    this.APIKEY_POOLS_KEY_PREFIX = 'apikey_pools:';
    this.DEFAULT_POOL_ID = 'default-shared-pool';
  }

  // 🏊 创建新的共享池
  async createPool(options = {}) {
    const {
      name = 'Unnamed Pool',
      description = '',
      isActive = true,
      priority = 100, // 优先级，数字越大优先级越高
      maxConcurrency = 0, // 池级别的最大并发限制，0表示无限制
      accountSelectionStrategy = 'least_used' // 账户选择策略：least_used, round_robin, random
    } = options;

    const poolId = uuidv4();
    
    const poolData = {
      id: poolId,
      name,
      description,
      isActive: isActive.toString(),
      priority: priority.toString(),
      maxConcurrency: maxConcurrency.toString(),
      accountSelectionStrategy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const client = redis.getClientSafe();
    await client.hset(`${this.POOL_KEY_PREFIX}${poolId}`, poolData);
    
    logger.success(`🏊 Created shared pool: ${name} (${poolId})`);
    
    return {
      id: poolId,
      ...poolData,
      isActive: poolData.isActive === 'true',
      priority: parseInt(poolData.priority),
      maxConcurrency: parseInt(poolData.maxConcurrency)
    };
  }

  // 📋 获取所有共享池
  async getAllPools() {
    try {
      const client = redis.getClient();
      if (!client) return [];

      const keys = await client.keys(`${this.POOL_KEY_PREFIX}*`);
      const pools = [];

      for (const key of keys) {
        const poolData = await client.hgetall(key);
        if (poolData && Object.keys(poolData).length > 0) {
          const poolId = key.replace(this.POOL_KEY_PREFIX, '');
          
          // 获取池中的账户数量
          const accountIds = await client.smembers(`${this.POOL_ACCOUNTS_KEY_PREFIX}${poolId}`);
          
          pools.push({
            id: poolId,
            ...poolData,
            isActive: poolData.isActive === 'true',
            priority: parseInt(poolData.priority || 100),
            maxConcurrency: parseInt(poolData.maxConcurrency || 0),
            accountCount: accountIds.length
          });
        }
      }

      // 按优先级排序
      return pools.sort((a, b) => b.priority - a.priority);
    } catch (error) {
      logger.error('❌ Failed to get shared pools:', error);
      throw error;
    }
  }

  // 🔍 获取单个共享池
  async getPool(poolId) {
    try {
      const client = redis.getClient();
      if (!client) return null;

      const poolData = await client.hgetall(`${this.POOL_KEY_PREFIX}${poolId}`);
      
      if (!poolData || Object.keys(poolData).length === 0) {
        return null;
      }

      // 获取池中的账户
      const accountIds = await client.smembers(`${this.POOL_ACCOUNTS_KEY_PREFIX}${poolId}`);

      return {
        id: poolId,
        ...poolData,
        isActive: poolData.isActive === 'true',
        priority: parseInt(poolData.priority || 100),
        maxConcurrency: parseInt(poolData.maxConcurrency || 0),
        accountIds
      };
    } catch (error) {
      logger.error(`❌ Failed to get pool ${poolId}:`, error);
      throw error;
    }
  }

  // 🏊 获取默认共享池
  async getDefaultPool() {
    try {
      return await this.getPool(this.DEFAULT_POOL_ID);
    } catch (error) {
      logger.error('❌ Failed to get default pool:', error);
      return null;
    }
  }

  // 🏊 获取或创建默认共享池
  async getOrCreateDefaultPool() {
    try {
      const client = redis.getClient();
      if (!client) return null;

      // 检查默认池是否存在
      const defaultPool = await this.getPool(this.DEFAULT_POOL_ID);
      if (defaultPool) {
        return defaultPool;
      }

      // 创建默认池
      const poolData = {
        id: this.DEFAULT_POOL_ID,
        name: '默认共享池',
        description: '系统默认共享池，用于未分配到特定池的API Key',
        isActive: 'true',
        priority: '0', // 最低优先级
        maxConcurrency: '0',
        accountSelectionStrategy: 'least_used',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await client.hset(`${this.POOL_KEY_PREFIX}${this.DEFAULT_POOL_ID}`, poolData);
      
      // 将未分配到任何池的共享账户添加到默认池
      const accounts = await redis.getAllClaudeAccounts();
      const sharedAccounts = accounts.filter(account => 
        account.accountType === 'shared' && account.isActive === 'true'
      );

      if (sharedAccounts.length > 0) {
        // 获取所有非默认池
        const allPools = await this.getAllPools();
        const nonDefaultPools = allPools.filter(pool => pool.id !== this.DEFAULT_POOL_ID);
        
        // 收集已分配到其他池的账户ID
        const assignedAccountIds = new Set();
        for (const pool of nonDefaultPools) {
          const accountIds = await client.smembers(`${this.POOL_ACCOUNTS_KEY_PREFIX}${pool.id}`);
          accountIds.forEach(id => assignedAccountIds.add(id));
        }
        
        // 只添加未分配的账户
        const unassignedAccounts = sharedAccounts.filter(acc => !assignedAccountIds.has(acc.id));
        if (unassignedAccounts.length > 0) {
          const accountIds = unassignedAccounts.map(acc => acc.id);
          await client.sadd(`${this.POOL_ACCOUNTS_KEY_PREFIX}${this.DEFAULT_POOL_ID}`, ...accountIds);
          logger.info(`🏊 Added ${accountIds.length} unassigned shared accounts to default pool`);
        }
      }

      logger.success('🏊 Created default shared pool');
      
      // 获取实际添加到默认池的账户ID
      const finalAccountIds = await client.smembers(`${this.POOL_ACCOUNTS_KEY_PREFIX}${this.DEFAULT_POOL_ID}`);
      
      return {
        id: this.DEFAULT_POOL_ID,
        ...poolData,
        isActive: true,
        priority: 0,
        maxConcurrency: 0,
        accountIds: finalAccountIds
      };
    } catch (error) {
      logger.error('❌ Failed to get or create default pool:', error);
      throw error;
    }
  }

  // 📝 更新共享池
  async updatePool(poolId, updates) {
    try {
      const client = redis.getClientSafe();
      const poolData = await client.hgetall(`${this.POOL_KEY_PREFIX}${poolId}`);
      
      if (!poolData || Object.keys(poolData).length === 0) {
        throw new Error('Pool not found');
      }

      const allowedUpdates = ['name', 'description', 'isActive', 'priority', 'maxConcurrency', 'accountSelectionStrategy'];
      const updatedData = { ...poolData };

      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          updatedData[field] = value.toString();
        }
      }

      updatedData.updatedAt = new Date().toISOString();
      
      await client.hset(`${this.POOL_KEY_PREFIX}${poolId}`, updatedData);
      
      logger.success(`📝 Updated shared pool: ${poolId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to update shared pool:', error);
      throw error;
    }
  }

  // 🗑️ 删除共享池
  async deletePool(poolId) {
    try {
      const client = redis.getClientSafe();
      
      // 删除池数据
      const result = await client.del(`${this.POOL_KEY_PREFIX}${poolId}`);
      
      if (result === 0) {
        throw new Error('Pool not found');
      }
      
      // 删除池账户关联
      await client.del(`${this.POOL_ACCOUNTS_KEY_PREFIX}${poolId}`);
      
      // 从所有API Key的池关联中移除此池
      const apiKeyIds = await client.keys(`${this.APIKEY_POOLS_KEY_PREFIX}*`);
      for (const key of apiKeyIds) {
        await client.srem(key, poolId);
      }
      
      logger.success(`🗑️ Deleted shared pool: ${poolId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to delete shared pool:', error);
      throw error;
    }
  }

  // ➕ 添加账户到共享池
  async addAccountToPool(poolId, accountId) {
    try {
      const client = redis.getClientSafe();
      
      // 验证池是否存在
      const poolExists = await client.exists(`${this.POOL_KEY_PREFIX}${poolId}`);
      if (!poolExists) {
        throw new Error('Pool not found');
      }
      
      // 添加账户到池
      await client.sadd(`${this.POOL_ACCOUNTS_KEY_PREFIX}${poolId}`, accountId);
      
      logger.success(`➕ Added account ${accountId} to pool ${poolId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to add account to pool:', error);
      throw error;
    }
  }

  // ➖ 从共享池移除账户
  async removeAccountFromPool(poolId, accountId) {
    try {
      const client = redis.getClientSafe();
      
      const result = await client.srem(`${this.POOL_ACCOUNTS_KEY_PREFIX}${poolId}`, accountId);
      
      if (result === 0) {
        throw new Error('Account not found in pool');
      }
      
      logger.success(`➖ Removed account ${accountId} from pool ${poolId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to remove account from pool:', error);
      throw error;
    }
  }

  // 🔗 将API Key关联到共享池
  async addApiKeyToPool(apiKeyId, poolId) {
    try {
      const client = redis.getClientSafe();
      
      // 验证池是否存在
      const poolExists = await client.exists(`${this.POOL_KEY_PREFIX}${poolId}`);
      if (!poolExists) {
        throw new Error('Pool not found');
      }
      
      // 添加池ID到API Key的池列表
      await client.sadd(`${this.APIKEY_POOLS_KEY_PREFIX}${apiKeyId}`, poolId);
      
      logger.success(`🔗 Added API Key ${apiKeyId} to pool ${poolId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to add API Key to pool:', error);
      throw error;
    }
  }

  // 🔓 将API Key从共享池移除
  async removeApiKeyFromPool(apiKeyId, poolId) {
    try {
      const client = redis.getClientSafe();
      
      const result = await client.srem(`${this.APIKEY_POOLS_KEY_PREFIX}${apiKeyId}`, poolId);
      
      if (result === 0) {
        throw new Error('API Key not found in pool');
      }
      
      logger.success(`🔓 Removed API Key ${apiKeyId} from pool ${poolId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to remove API Key from pool:', error);
      throw error;
    }
  }

  // 📋 获取API Key关联的所有共享池
  async getApiKeyPools(apiKeyId) {
    try {
      const client = redis.getClient();
      if (!client) return [];

      const poolIds = await client.smembers(`${this.APIKEY_POOLS_KEY_PREFIX}${apiKeyId}`);
      const pools = [];

      for (const poolId of poolIds) {
        const pool = await this.getPool(poolId);
        if (pool) {
          pools.push(pool);
        }
      }

      // 按优先级排序
      return pools.sort((a, b) => b.priority - a.priority);
    } catch (error) {
      logger.error(`❌ Failed to get pools for API Key ${apiKeyId}:`, error);
      throw error;
    }
  }

  // 📋 获取共享池中的所有账户
  async getPoolAccounts(poolId) {
    try {
      const client = redis.getClient();
      if (!client) return [];

      const accountIds = await client.smembers(`${this.POOL_ACCOUNTS_KEY_PREFIX}${poolId}`);
      return accountIds;
    } catch (error) {
      logger.error(`❌ Failed to get accounts for pool ${poolId}:`, error);
      throw error;
    }
  }

  // 🎯 从API Key的所有池中选择账户（考虑优先级和策略）
  async selectAccountFromPools(apiKeyId, sessionHash = null, excludeAccountIds = null) {
    try {
      // 获取API Key关联的共享池ID
      const poolIds = await redis.getApiKeySharedPools(apiKeyId);
      let pools = [];
      
      if (poolIds && poolIds.length > 0) {
        // 如果API Key指定了特定的共享池，只使用这些池
        logger.info(`📋 API Key ${apiKeyId} is associated with ${poolIds.length} specific pools`);
        for (const poolId of poolIds) {
          const pool = await this.getPool(poolId);
          if (pool && pool.isActive) {
            pools.push(pool);
          }
        }
        // 按优先级排序
        pools.sort((a, b) => b.priority - a.priority);
      } else {
        // 如果没有指定共享池，使用默认池
        logger.info(`📋 API Key ${apiKeyId} not associated with specific pools, using default pool`);
        const defaultPool = await this.getDefaultPool();
        if (defaultPool && defaultPool.isActive) {
          pools = [defaultPool];
        } else {
          // 如果没有默认池，则使用所有激活的池作为后备方案
          logger.warn('⚠️ No default pool found, falling back to all active pools');
          const allPools = await this.getAllPools();
          pools = allPools.filter(pool => pool.isActive);
          // 按优先级排序
          pools.sort((a, b) => b.priority - a.priority);
        }
      }
      
      if (pools.length === 0) {
        throw new Error('No active shared pools available');
      }

      // 按优先级尝试每个池
      for (const pool of pools) {
        if (pool.isActive) {
          const accountId = await this._selectAccountFromPool(
            pool,
            sessionHash,
            excludeAccountIds
          );
          
          if (accountId) {
            logger.info(`🎯 Selected account ${accountId} from pool ${pool.name} (${pool.id})`);
            return {
              accountId,
              poolId: pool.id,
              poolName: pool.name
            };
          }
        }
      }

      throw new Error('No available accounts in any associated pools');
    } catch (error) {
      logger.error(`❌ Failed to select account from pools for API Key ${apiKeyId}:`, error);
      throw error;
    }
  }

  // 🎯 从单个池中选择账户（内部方法）
  async _selectAccountFromPool(pool, sessionHash = null, excludeAccountIds = null) {
    try {
      const accountIds = await this.getPoolAccounts(pool.id);
      
      if (accountIds.length === 0) {
        return null;
      }

      // 根据策略选择账户
      let selectedAccountId = null;

      switch (pool.accountSelectionStrategy) {
        case 'round_robin':
          selectedAccountId = await this._selectRoundRobin(pool.id, accountIds, excludeAccountIds);
          break;
        case 'random':
          selectedAccountId = await this._selectRandom(accountIds, excludeAccountIds);
          break;
        case 'least_used':
        default:
          selectedAccountId = await this._selectLeastUsed(accountIds, excludeAccountIds);
          break;
      }

      return selectedAccountId;
    } catch (error) {
      logger.error(`❌ Failed to select account from pool ${pool.id}:`, error);
      return null;
    }
  }

  // 🔄 轮询选择策略
  async _selectRoundRobin(poolId, accountIds, excludeAccountIds) {
    const client = redis.getClient();
    if (!client) return null;
    
    const claudeAccountService = require('./claudeAccountService');

    // 过滤掉排除的账户
    const availableIds = excludeAccountIds 
      ? accountIds.filter(id => !excludeAccountIds.has(id))
      : accountIds;

    if (availableIds.length === 0) return null;

    // 过滤掉限流和不可用的账户
    const activeAccountIds = [];
    for (const accountId of availableIds) {
      const accountData = await claudeAccountService._getAccountData(accountId);
      if (accountData && accountData.isActive === 'true' && accountData.status !== 'error' && accountData.status !== 'banned') {
        // 检查是否被限流
        const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
        if (!isRateLimited) {
          activeAccountIds.push(accountId);
        }
      }
    }

    if (activeAccountIds.length === 0) {
      // 如果所有账户都被限流，则从原始可用账户中选择（作为备用方案）
      logger.warn(`⚠️ All accounts in pool ${poolId} are rate limited, falling back to original list`);
      if (availableIds.length === 0) return null;
      
      // 获取并更新轮询索引
      const indexKey = `pool_round_robin:${poolId}`;
      const currentIndex = parseInt(await client.get(indexKey) || '0');
      const nextIndex = (currentIndex + 1) % availableIds.length;
      await client.set(indexKey, nextIndex);
      
      return availableIds[currentIndex % availableIds.length];
    }

    // 获取并更新轮询索引（基于活跃账户列表）
    const indexKey = `pool_round_robin:${poolId}`;
    const currentIndex = parseInt(await client.get(indexKey) || '0');
    const nextIndex = (currentIndex + 1) % activeAccountIds.length;
    await client.set(indexKey, nextIndex);

    return activeAccountIds[currentIndex % activeAccountIds.length];
  }

  // 🎲 随机选择策略
  async _selectRandom(accountIds, excludeAccountIds) {
    const claudeAccountService = require('./claudeAccountService');
    
    // 过滤掉排除的账户
    const availableIds = excludeAccountIds 
      ? accountIds.filter(id => !excludeAccountIds.has(id))
      : accountIds;

    if (availableIds.length === 0) return null;

    // 过滤掉限流和不可用的账户
    const activeAccountIds = [];
    for (const accountId of availableIds) {
      const accountData = await claudeAccountService._getAccountData(accountId);
      if (accountData && accountData.isActive === 'true' && accountData.status !== 'error' && accountData.status !== 'banned') {
        // 检查是否被限流
        const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
        if (!isRateLimited) {
          activeAccountIds.push(accountId);
        }
      }
    }

    if (activeAccountIds.length === 0) {
      // 如果所有账户都被限流，则从原始可用账户中选择（作为备用方案）
      logger.warn('⚠️ All accounts are rate limited in random selection, falling back to original list');
      if (availableIds.length === 0) return null;
      const randomIndex = Math.floor(Math.random() * availableIds.length);
      return availableIds[randomIndex];
    }

    const randomIndex = Math.floor(Math.random() * activeAccountIds.length);
    return activeAccountIds[randomIndex];
  }

  // 📊 最少使用选择策略
  async _selectLeastUsed(accountIds, excludeAccountIds) {
    const claudeAccountService = require('./claudeAccountService');
    
    // 过滤掉排除的账户
    const availableIds = excludeAccountIds 
      ? accountIds.filter(id => !excludeAccountIds.has(id))
      : accountIds;

    if (availableIds.length === 0) return null;

    // 获取所有账户的使用信息
    const accountsWithUsage = [];
    
    for (const accountId of availableIds) {
      const accountData = await claudeAccountService._getAccountData(accountId);
      if (accountData && accountData.isActive === 'true' && accountData.status !== 'error' && accountData.status !== 'banned') {
        // 检查是否被限流
        const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
        if (!isRateLimited) {
          accountsWithUsage.push({
            id: accountId,
            lastUsedAt: new Date(accountData.lastUsedAt || 0).getTime()
          });
        }
      }
    }

    if (accountsWithUsage.length === 0) {
      // 如果没有非限流账户，从所有可用账户中选择
      for (const accountId of availableIds) {
        const accountData = await claudeAccountService._getAccountData(accountId);
        if (accountData && accountData.isActive === 'true') {
          return accountId;
        }
      }
      return null;
    }

    // 选择最久未使用的账户
    accountsWithUsage.sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    return accountsWithUsage[0].id;
  }

  // 🧹 清理无效的池关联
  async cleanupInvalidAssociations() {
    try {
      const client = redis.getClient();
      if (!client) return 0;

      let cleanedCount = 0;

      // 清理API Key的无效池关联
      const apiKeyPoolKeys = await client.keys(`${this.APIKEY_POOLS_KEY_PREFIX}*`);
      for (const key of apiKeyPoolKeys) {
        const poolIds = await client.smembers(key);
        for (const poolId of poolIds) {
          const poolExists = await client.exists(`${this.POOL_KEY_PREFIX}${poolId}`);
          if (!poolExists) {
            await client.srem(key, poolId);
            cleanedCount++;
          }
        }
      }

      // 清理池的无效账户关联
      const poolAccountKeys = await client.keys(`${this.POOL_ACCOUNTS_KEY_PREFIX}*`);
      for (const key of poolAccountKeys) {
        const poolId = key.replace(this.POOL_ACCOUNTS_KEY_PREFIX, '');
        const poolExists = await client.exists(`${this.POOL_KEY_PREFIX}${poolId}`);
        if (!poolExists) {
          await client.del(key);
          cleanedCount++;
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Cleaned up ${cleanedCount} invalid associations`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('❌ Failed to cleanup invalid associations:', error);
      return 0;
    }
  }
}

module.exports = new SharedPoolService();