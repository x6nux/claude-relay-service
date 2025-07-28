const claudeAccountService = require('./claudeAccountService');
const circuitBreakerService = require('./circuitBreakerService');
const logger = require('../utils/logger');
const redis = require('../models/redis');
const EventEmitter = require('events');

/**
 * 账户恢复服务 - 自动检测和恢复不健康的账户
 */
class AccountRecoveryService extends EventEmitter {
  constructor() {
    super();
    
    // 恢复策略配置
    this.config = {
      // 健康检查间隔（毫秒）
      healthCheckInterval: 300000, // 5分钟
      // 恢复尝试间隔（毫秒）
      recoveryAttemptInterval: 600000, // 10分钟
      // 最大恢复尝试次数
      maxRecoveryAttempts: 3,
      // 恢复成功后的观察期（毫秒）
      observationPeriod: 1800000, // 30分钟
      // 批量检查大小
      batchSize: 10,
      // 并发恢复数
      concurrentRecoveries: 3
    };
    
    // 恢复状态存储前缀
    this.REDIS_PREFIX = 'account_recovery:';
    
    // 定时器引用
    this.healthCheckTimer = null;
    this.recoveryTimer = null;
    
    // 恢复队列
    this.recoveryQueue = new Set();
    
    // 恢复中的账户
    this.recoveringAccounts = new Set();
  }

  /**
   * 启动恢复服务
   */
  start() {
    logger.info('🚀 Starting account recovery service');
    
    // 启动健康检查定时器
    this.healthCheckTimer = setInterval(() => {
      this.performHealthCheck().catch(error => {
        logger.error('Health check failed:', error);
      });
    }, this.config.healthCheckInterval);
    
    // 启动恢复定时器
    this.recoveryTimer = setInterval(() => {
      this.processRecoveryQueue().catch(error => {
        logger.error('Recovery process failed:', error);
      });
    }, this.config.recoveryAttemptInterval);
    
    // 立即执行一次检查
    this.performHealthCheck().catch(error => {
      logger.error('Initial health check failed:', error);
    });
  }

  /**
   * 停止恢复服务
   */
  stop() {
    logger.info('🛑 Stopping account recovery service');
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    
    this.recoveryQueue.clear();
    this.recoveringAccounts.clear();
  }

  /**
   * 执行健康检查
   */
  async performHealthCheck() {
    logger.info('🏥 Starting account health check');
    
    try {
      // 获取所有账户
      const accounts = await claudeAccountService.getAllAccounts();
      
      // 分批检查
      for (let i = 0; i < accounts.length; i += this.config.batchSize) {
        const batch = accounts.slice(i, i + this.config.batchSize);
        await this.checkBatch(batch);
        
        // 批次间稍作延迟，避免过度压力
        if (i + this.config.batchSize < accounts.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      logger.info(`✅ Health check completed. Unhealthy accounts: ${this.recoveryQueue.size}`);
      
      // 触发健康检查完成事件
      this.emit('healthCheckComplete', {
        totalAccounts: accounts.length,
        unhealthyAccounts: this.recoveryQueue.size,
        timestamp: Date.now()
      });
      
    } catch (error) {
      logger.error('Health check error:', error);
      throw error;
    }
  }

  /**
   * 检查一批账户
   */
  async checkBatch(accounts) {
    const promises = accounts.map(account => this.checkAccount(account));
    const results = await Promise.allSettled(promises);
    
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        logger.error(`Failed to check account ${accounts[index].id}:`, result.reason);
      }
    });
  }

  /**
   * 检查单个账户健康状态
   */
  async checkAccount(account) {
    try {
      // 跳过非活跃账户
      if (!account.isActive) {
        return { healthy: true, reason: 'inactive' };
      }
      
      // 检查熔断器状态
      const circuitState = await circuitBreakerService.getState(account.id);
      if (circuitState.state !== 'CLOSED') {
        logger.debug(`Account ${account.id} is in circuit breaker state: ${circuitState.state}`);
        
        // 如果在熔断状态，加入恢复队列
        if (!this.recoveringAccounts.has(account.id)) {
          this.recoveryQueue.add(account.id);
        }
        return { healthy: false, reason: 'circuit_breaker', state: circuitState.state };
      }
      
      // 检查账户状态
      if (account.status === 'error' || account.status === 'expired') {
        logger.debug(`Account ${account.id} has error status: ${account.status}`);
        
        // 加入恢复队列
        if (!this.recoveringAccounts.has(account.id)) {
          this.recoveryQueue.add(account.id);
        }
        return { healthy: false, reason: 'error_status', status: account.status };
      }
      
      // 检查token过期
      if (account.expiresAt) {
        const expiresAt = parseInt(account.expiresAt);
        const now = Date.now();
        const bufferTime = 300000; // 5分钟缓冲
        
        if (expiresAt - now < bufferTime) {
          logger.debug(`Account ${account.id} token is expiring soon`);
          
          // 尝试刷新token
          try {
            await claudeAccountService.refreshAccountToken(account.id);
            logger.info(`✅ Refreshed token for account ${account.id}`);
            return { healthy: true, reason: 'token_refreshed' };
          } catch (error) {
            logger.error(`Failed to refresh token for account ${account.id}:`, error.message);
            
            // 加入恢复队列
            if (!this.recoveringAccounts.has(account.id)) {
              this.recoveryQueue.add(account.id);
            }
            return { healthy: false, reason: 'token_refresh_failed', error: error.message };
          }
        }
      }
      
      // 检查最近的使用情况
      const recoveryState = await this.getRecoveryState(account.id);
      if (recoveryState.consecutiveFailures >= 3) {
        logger.debug(`Account ${account.id} has consecutive failures: ${recoveryState.consecutiveFailures}`);
        
        // 加入恢复队列
        if (!this.recoveringAccounts.has(account.id)) {
          this.recoveryQueue.add(account.id);
        }
        return { healthy: false, reason: 'consecutive_failures', failures: recoveryState.consecutiveFailures };
      }
      
      return { healthy: true, reason: 'ok' };
      
    } catch (error) {
      logger.error(`Error checking account ${account.id}:`, error);
      return { healthy: false, reason: 'check_error', error: error.message };
    }
  }

  /**
   * 处理恢复队列
   */
  async processRecoveryQueue() {
    if (this.recoveryQueue.size === 0) {
      return;
    }
    
    logger.info(`🔧 Processing recovery queue: ${this.recoveryQueue.size} accounts`);
    
    const accountsToRecover = Array.from(this.recoveryQueue).slice(0, this.config.concurrentRecoveries);
    
    // 并发恢复
    const promises = accountsToRecover.map(accountId => this.recoverAccount(accountId));
    const results = await Promise.allSettled(promises);
    
    results.forEach((result, index) => {
      const accountId = accountsToRecover[index];
      
      if (result.status === 'fulfilled' && result.value.success) {
        logger.info(`✅ Successfully recovered account ${accountId}`);
        this.recoveryQueue.delete(accountId);
      } else {
        const error = result.status === 'rejected' ? result.reason : result.value.error;
        logger.error(`Failed to recover account ${accountId}:`, error);
      }
      
      this.recoveringAccounts.delete(accountId);
    });
    
    // 触发恢复完成事件
    this.emit('recoveryBatchComplete', {
      processed: accountsToRecover.length,
      remaining: this.recoveryQueue.size,
      timestamp: Date.now()
    });
  }

  /**
   * 恢复单个账户
   */
  async recoverAccount(accountId) {
    logger.info(`🔧 Attempting to recover account ${accountId}`);
    
    try {
      this.recoveringAccounts.add(accountId);
      
      // 获取账户信息
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }
      
      // 获取恢复状态
      const recoveryState = await this.getRecoveryState(accountId);
      
      // 检查恢复尝试次数
      if (recoveryState.attempts >= this.config.maxRecoveryAttempts) {
        logger.warn(`Max recovery attempts reached for account ${accountId}`);
        
        // 标记账户为不可恢复
        await claudeAccountService.updateAccount(accountId, {
          status: 'unrecoverable',
          errorMessage: `Max recovery attempts (${this.config.maxRecoveryAttempts}) exceeded`
        });
        
        return { success: false, error: 'max_attempts_exceeded' };
      }
      
      // 增加恢复尝试计数
      recoveryState.attempts++;
      recoveryState.lastAttemptTime = Date.now();
      await this.setRecoveryState(accountId, recoveryState);
      
      // 尝试不同的恢复策略
      const strategies = [
        this.strategyRefreshToken.bind(this),
        this.strategyTestConnection.bind(this),
        this.strategyResetCircuitBreaker.bind(this),
        this.strategyClearRateLimit.bind(this)
      ];
      
      let recovered = false;
      let lastError = null;
      
      for (const strategy of strategies) {
        try {
          const result = await strategy(accountId, accountData);
          if (result.success) {
            recovered = true;
            break;
          }
        } catch (error) {
          lastError = error;
          logger.debug(`Recovery strategy failed for ${accountId}:`, error.message);
        }
      }
      
      if (recovered) {
        // 重置恢复状态
        await this.resetRecoveryState(accountId);
        
        // 重置熔断器
        await circuitBreakerService.reset(accountId);
        
        // 更新账户状态
        await claudeAccountService.updateAccount(accountId, {
          status: 'active',
          errorMessage: ''
        });
        
        logger.success(`✅ Account ${accountId} recovered successfully`);
        
        // 触发恢复成功事件
        this.emit('accountRecovered', {
          accountId,
          attempts: recoveryState.attempts,
          timestamp: Date.now()
        });
        
        return { success: true };
      } else {
        // 更新失败信息
        recoveryState.consecutiveFailures++;
        await this.setRecoveryState(accountId, recoveryState);
        
        throw new Error(lastError?.message || 'All recovery strategies failed');
      }
      
    } catch (error) {
      logger.error(`Recovery failed for account ${accountId}:`, error);
      
      // 触发恢复失败事件
      this.emit('accountRecoveryFailed', {
        accountId,
        error: error.message,
        timestamp: Date.now()
      });
      
      return { success: false, error: error.message };
    } finally {
      this.recoveringAccounts.delete(accountId);
    }
  }

  /**
   * 恢复策略：刷新Token
   */
  async strategyRefreshToken(accountId, accountData) {
    logger.debug(`Trying token refresh strategy for ${accountId}`);
    
    try {
      const result = await claudeAccountService.refreshAccountToken(accountId);
      if (result.success) {
        logger.info(`✅ Token refreshed for account ${accountId}`);
        return { success: true };
      }
    } catch (error) {
      if (error.message.includes('No refresh token')) {
        // 如果没有refresh token，这个策略不适用
        return { success: false, skip: true };
      }
      throw error;
    }
    
    return { success: false };
  }

  /**
   * 恢复策略：测试连接
   */
  async strategyTestConnection(accountId, accountData) {
    logger.debug(`Trying connection test strategy for ${accountId}`);
    
    // 动态引入以避免循环依赖
    const claudeRelayService = require('./claudeRelayService');
    
    try {
      const result = await claudeRelayService.testAccountHealth(accountId);
      if (result.success) {
        logger.info(`✅ Connection test passed for account ${accountId}`);
        return { success: true };
      } else {
        logger.debug(`Connection test failed for ${accountId}: ${result.error}`);
        return { success: false, error: result.error };
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * 恢复策略：重置熔断器
   */
  async strategyResetCircuitBreaker(accountId, accountData) {
    logger.debug(`Trying circuit breaker reset strategy for ${accountId}`);
    
    const circuitState = await circuitBreakerService.getState(accountId);
    
    if (circuitState.state !== 'CLOSED') {
      await circuitBreakerService.reset(accountId);
      logger.info(`✅ Circuit breaker reset for account ${accountId}`);
      
      // 给一点时间让系统稳定
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      return { success: true };
    }
    
    return { success: false, skip: true };
  }

  /**
   * 恢复策略：清除限流状态
   */
  async strategyClearRateLimit(accountId, accountData) {
    logger.debug(`Trying rate limit clear strategy for ${accountId}`);
    
    const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
    
    if (isRateLimited) {
      await claudeAccountService.removeAccountRateLimit(accountId);
      logger.info(`✅ Rate limit cleared for account ${accountId}`);
      return { success: true };
    }
    
    return { success: false, skip: true };
  }

  /**
   * 获取恢复状态
   */
  async getRecoveryState(accountId) {
    try {
      const key = `${this.REDIS_PREFIX}${accountId}`;
      const data = await redis.getClient().hgetall(key);
      
      if (!data || Object.keys(data).length === 0) {
        return {
          attempts: 0,
          lastAttemptTime: 0,
          consecutiveFailures: 0,
          firstFailureTime: 0
        };
      }
      
      return {
        attempts: parseInt(data.attempts) || 0,
        lastAttemptTime: parseInt(data.lastAttemptTime) || 0,
        consecutiveFailures: parseInt(data.consecutiveFailures) || 0,
        firstFailureTime: parseInt(data.firstFailureTime) || 0
      };
    } catch (error) {
      logger.error(`Failed to get recovery state for ${accountId}:`, error);
      return {
        attempts: 0,
        lastAttemptTime: 0,
        consecutiveFailures: 0,
        firstFailureTime: 0
      };
    }
  }

  /**
   * 设置恢复状态
   */
  async setRecoveryState(accountId, state) {
    try {
      const key = `${this.REDIS_PREFIX}${accountId}`;
      const data = {
        attempts: state.attempts.toString(),
        lastAttemptTime: state.lastAttemptTime.toString(),
        consecutiveFailures: state.consecutiveFailures.toString(),
        firstFailureTime: state.firstFailureTime.toString()
      };
      
      await redis.getClient().hset(key, data);
      
      // 设置过期时间（7天）
      await redis.getClient().expire(key, 604800);
    } catch (error) {
      logger.error(`Failed to set recovery state for ${accountId}:`, error);
    }
  }

  /**
   * 重置恢复状态
   */
  async resetRecoveryState(accountId) {
    try {
      const key = `${this.REDIS_PREFIX}${accountId}`;
      await redis.getClient().del(key);
      logger.debug(`Reset recovery state for account ${accountId}`);
    } catch (error) {
      logger.error(`Failed to reset recovery state for ${accountId}:`, error);
    }
  }

  /**
   * 手动触发账户恢复
   */
  async triggerRecovery(accountId) {
    logger.info(`📍 Manually triggering recovery for account ${accountId}`);
    
    if (this.recoveringAccounts.has(accountId)) {
      return { success: false, error: 'Recovery already in progress' };
    }
    
    this.recoveryQueue.add(accountId);
    
    // 立即尝试恢复
    return await this.recoverAccount(accountId);
  }

  /**
   * 获取恢复服务状态
   */
  getStatus() {
    return {
      running: this.healthCheckTimer !== null && this.recoveryTimer !== null,
      recoveryQueue: Array.from(this.recoveryQueue),
      recoveringAccounts: Array.from(this.recoveringAccounts),
      config: this.config
    };
  }

  /**
   * 记录账户失败
   */
  async recordAccountFailure(accountId, error) {
    try {
      const recoveryState = await this.getRecoveryState(accountId);
      
      recoveryState.consecutiveFailures++;
      if (recoveryState.firstFailureTime === 0) {
        recoveryState.firstFailureTime = Date.now();
      }
      
      await this.setRecoveryState(accountId, recoveryState);
      
      // 如果连续失败超过阈值，加入恢复队列
      if (recoveryState.consecutiveFailures >= 3 && !this.recoveringAccounts.has(accountId)) {
        this.recoveryQueue.add(accountId);
        logger.warn(`Account ${accountId} added to recovery queue after ${recoveryState.consecutiveFailures} failures`);
      }
    } catch (err) {
      logger.error(`Failed to record account failure for ${accountId}:`, err);
    }
  }

  /**
   * 记录账户成功
   */
  async recordAccountSuccess(accountId) {
    try {
      const recoveryState = await this.getRecoveryState(accountId);
      
      if (recoveryState.consecutiveFailures > 0) {
        // 重置失败计数
        await this.resetRecoveryState(accountId);
        logger.debug(`Reset failure count for account ${accountId} after success`);
      }
    } catch (err) {
      logger.error(`Failed to record account success for ${accountId}:`, err);
    }
  }
}

module.exports = new AccountRecoveryService();