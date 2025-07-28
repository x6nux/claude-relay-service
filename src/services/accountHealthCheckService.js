const claudeAccountService = require('./claudeAccountService');
const logger = require('../utils/logger');
const config = require('../../config/config');

class AccountHealthCheckService {
  constructor() {
    this.isRunning = false;
    this.checkInterval = null;
    this.checkIntervalMs = (config.healthCheck?.intervalMinutes || 30) * 60 * 1000; // 默认30分钟
  }

  // 🚀 启动健康检查服务
  start() {
    if (this.isRunning) {
      logger.warn('⚠️ Account health check service is already running');
      return;
    }

    this.isRunning = true;
    logger.info(`🚀 Starting account health check service (interval: ${this.checkIntervalMs / 60000} minutes)`);

    // 立即执行一次检查
    this.checkAllAccounts();

    // 设置定期检查
    this.checkInterval = setInterval(() => {
      this.checkAllAccounts();
    }, this.checkIntervalMs);
  }

  // 🛑 停止健康检查服务
  stop() {
    if (!this.isRunning) {
      logger.warn('⚠️ Account health check service is not running');
      return;
    }

    this.isRunning = false;
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('🛑 Account health check service stopped');
  }

  // 🏥 检查所有账户的健康状态
  async checkAllAccounts() {
    try {
      logger.info('🏥 Starting account health check...');
      const startTime = Date.now();

      const accounts = await claudeAccountService.getAllAccounts();
      logger.info(`📊 Found ${accounts.length} accounts to check`);

      let healthyCount = 0;
      let unhealthyCount = 0;
      let rateLimitedCount = 0;
      let checkedCount = 0;

      // 批量检查账户
      const checkPromises = accounts.map(async (account) => {
        if (!account.isActive) {
          logger.debug(`⏭️ Skipping inactive account: ${account.name} (${account.id})`);
          return;
        }

        try {
          const result = await this.checkAccountHealth(account.id);
          checkedCount++;

          if (result.isHealthy) {
            healthyCount++;
            logger.debug(`✅ Account healthy: ${account.name} (${account.id})`);
          } else if (result.isRateLimited) {
            rateLimitedCount++;
            logger.warn(`🚫 Account rate limited: ${account.name} (${account.id})`);
          } else {
            unhealthyCount++;
            logger.warn(`❌ Account unhealthy: ${account.name} (${account.id}) - ${result.error}`);
          }

          return result;
        } catch (error) {
          logger.error(`❌ Failed to check account ${account.name} (${account.id}):`, error);
          unhealthyCount++;
          return { accountId: account.id, isHealthy: false, error: error.message };
        }
      });

      // 等待所有检查完成
      await Promise.allSettled(checkPromises);

      const duration = Date.now() - startTime;
      logger.info(`🏥 Health check completed in ${duration}ms - Checked: ${checkedCount}, Healthy: ${healthyCount}, Unhealthy: ${unhealthyCount}, Rate Limited: ${rateLimitedCount}`);

    } catch (error) {
      logger.error('❌ Failed to perform health check:', error);
    }
  }

  // 🔍 检查单个账户的健康状态
  async checkAccountHealth(accountId) {
    try {
      // 检查是否被限流
      const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
      if (isRateLimited) {
        const rateLimitInfo = await claudeAccountService.getAccountRateLimitInfo(accountId);
        return {
          accountId,
          isHealthy: false,
          isRateLimited: true,
          rateLimitInfo
        };
      }

      // 尝试获取有效的访问token（会自动刷新过期的token）
      try {
        const accessToken = await claudeAccountService.getValidAccessToken(accountId);
        
        if (accessToken) {
          // Token获取成功，账户健康
          return {
            accountId,
            isHealthy: true,
            isRateLimited: false
          };
        } else {
          // 没有获取到token
          return {
            accountId,
            isHealthy: false,
            isRateLimited: false,
            error: 'No access token available'
          };
        }
      } catch (tokenError) {
        // Token刷新失败
        logger.debug(`🔐 Token refresh failed for account ${accountId}: ${tokenError.message}`);
        
        // 检查错误类型，更新账户状态
        const accountData = await claudeAccountService._getAccountData(accountId);
        if (accountData) {
          accountData.status = 'error';
          accountData.errorMessage = tokenError.message;
          accountData.lastHealthCheckAt = new Date().toISOString();
          await claudeAccountService._updateAccountData(accountId, accountData);
        }

        return {
          accountId,
          isHealthy: false,
          isRateLimited: false,
          error: tokenError.message
        };
      }
    } catch (error) {
      logger.error(`❌ Failed to check health for account ${accountId}:`, error);
      return {
        accountId,
        isHealthy: false,
        isRateLimited: false,
        error: error.message
      };
    }
  }

  // 📊 获取健康检查统计信息
  async getHealthStats() {
    try {
      const accounts = await claudeAccountService.getAllAccounts();
      const stats = {
        total: accounts.length,
        active: 0,
        inactive: 0,
        healthy: 0,
        error: 0,
        rateLimited: 0,
        lastCheckAt: null
      };

      for (const account of accounts) {
        if (account.isActive) {
          stats.active++;
        } else {
          stats.inactive++;
          continue;
        }

        if (account.status === 'active') {
          stats.healthy++;
        } else if (account.status === 'error') {
          stats.error++;
        }

        if (account.rateLimitStatus) {
          stats.rateLimited++;
        }

        // 获取最后检查时间
        if (account.lastHealthCheckAt) {
          const checkTime = new Date(account.lastHealthCheckAt);
          if (!stats.lastCheckAt || checkTime > stats.lastCheckAt) {
            stats.lastCheckAt = checkTime;
          }
        }
      }

      return stats;
    } catch (error) {
      logger.error('❌ Failed to get health stats:', error);
      throw error;
    }
  }

  // 🔄 更新检查间隔
  updateCheckInterval(intervalMinutes) {
    const newIntervalMs = intervalMinutes * 60 * 1000;
    if (newIntervalMs === this.checkIntervalMs) {
      return;
    }

    this.checkIntervalMs = newIntervalMs;
    logger.info(`🔄 Updating health check interval to ${intervalMinutes} minutes`);

    // 如果服务正在运行，重启以应用新的间隔
    if (this.isRunning) {
      this.stop();
      this.start();
    }
  }
}

module.exports = new AccountHealthCheckService();