const redis = require('../models/redis');
const logger = require('../utils/logger');

class AccountErrorStatsService {
  constructor() {
    // Redis key 前缀
    this.ERROR_STATS_KEY_PREFIX = 'account:error:stats:';
    this.ERROR_HISTORY_KEY_PREFIX = 'account:error:history:';
    
    // 错误历史保留时长（24小时）
    this.ERROR_HISTORY_TTL = 24 * 60 * 60;
    
    // 最大历史记录数
    this.MAX_HISTORY_ENTRIES = 100;
  }

  // 📊 记录账号错误
  async recordError(accountId, errorCode, errorMessage) {
    try {
      const client = redis.getClient();
      if (!client) return;

      const now = Date.now();
      const errorData = {
        code: errorCode,
        message: errorMessage,
        timestamp: new Date().toISOString(),
        time: now
      };

      // 更新错误统计
      const statsKey = `${this.ERROR_STATS_KEY_PREFIX}${accountId}`;
      const multi = client.multi();
      
      // 增加错误计数
      multi.hincrby(statsKey, 'totalErrors', 1);
      multi.hincrby(statsKey, `error_${errorCode}`, 1);
      
      // 更新最后错误时间和信息
      multi.hset(statsKey, 'lastErrorTime', errorData.timestamp);
      multi.hset(statsKey, 'lastErrorCode', errorCode);
      multi.hset(statsKey, 'lastErrorMessage', errorMessage);
      
      // 添加到错误历史（使用有序集合，时间戳作为分数）
      const historyKey = `${this.ERROR_HISTORY_KEY_PREFIX}${accountId}`;
      multi.zadd(historyKey, now, JSON.stringify(errorData));
      
      // 设置过期时间
      multi.expire(historyKey, this.ERROR_HISTORY_TTL);
      
      // 限制历史记录数量
      multi.zremrangebyrank(historyKey, 0, -this.MAX_HISTORY_ENTRIES - 1);
      
      await multi.exec();
      
      logger.debug(`📊 Recorded error for account ${accountId}: ${errorCode}`);
    } catch (error) {
      logger.error(`❌ Failed to record error stats for account ${accountId}:`, error);
    }
  }

  // 📊 获取账号错误统计
  async getErrorStats(accountId) {
    try {
      const client = redis.getClient();
      if (!client) return null;

      const statsKey = `${this.ERROR_STATS_KEY_PREFIX}${accountId}`;
      const stats = await client.hgetall(statsKey);
      
      if (!stats || Object.keys(stats).length === 0) {
        return {
          totalErrors: 0,
          lastErrorTime: null,
          lastErrorCode: null,
          lastErrorMessage: null,
          errorBreakdown: {}
        };
      }

      // 解析错误分类统计
      const errorBreakdown = {};
      Object.keys(stats).forEach(key => {
        if (key.startsWith('error_')) {
          const errorCode = key.replace('error_', '');
          errorBreakdown[errorCode] = parseInt(stats[key]) || 0;
        }
      });

      return {
        totalErrors: parseInt(stats.totalErrors) || 0,
        lastErrorTime: stats.lastErrorTime || null,
        lastErrorCode: stats.lastErrorCode || null,
        lastErrorMessage: stats.lastErrorMessage || null,
        errorBreakdown
      };
    } catch (error) {
      logger.error(`❌ Failed to get error stats for account ${accountId}:`, error);
      return null;
    }
  }

  // 📊 获取账号最近的错误历史
  async getErrorHistory(accountId, limit = 10) {
    try {
      const client = redis.getClient();
      if (!client) return [];

      const historyKey = `${this.ERROR_HISTORY_KEY_PREFIX}${accountId}`;
      
      // 获取最近的错误记录（按时间倒序）
      const history = await client.zrevrange(historyKey, 0, limit - 1);
      
      return history.map(entry => {
        try {
          return JSON.parse(entry);
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
    } catch (error) {
      logger.error(`❌ Failed to get error history for account ${accountId}:`, error);
      return [];
    }
  }

  // 🧹 清除账号的错误统计
  async clearErrorStats(accountId) {
    try {
      const client = redis.getClient();
      if (!client) return;

      const multi = client.multi();
      multi.del(`${this.ERROR_STATS_KEY_PREFIX}${accountId}`);
      multi.del(`${this.ERROR_HISTORY_KEY_PREFIX}${accountId}`);
      await multi.exec();
      
      logger.info(`🧹 Cleared error stats for account ${accountId}`);
    } catch (error) {
      logger.error(`❌ Failed to clear error stats for account ${accountId}:`, error);
    }
  }

  // 📊 批量获取多个账号的错误统计
  async getBatchErrorStats(accountIds) {
    try {
      const results = {};
      
      // 使用 Promise.all 并行获取
      const statsPromises = accountIds.map(async (accountId) => {
        const stats = await this.getErrorStats(accountId);
        return { accountId, stats };
      });
      
      const statsResults = await Promise.all(statsPromises);
      
      statsResults.forEach(({ accountId, stats }) => {
        results[accountId] = stats;
      });
      
      return results;
    } catch (error) {
      logger.error('❌ Failed to get batch error stats:', error);
      return {};
    }
  }

  // 📊 获取错误代码的友好描述
  getErrorDescription(errorCode) {
    const errorDescriptions = {
      '400': 'Bad Request',
      '401': 'Unauthorized',
      '403': 'Forbidden',
      '404': 'Not Found',
      '429': 'Rate Limited',
      '500': 'Internal Server Error',
      '502': 'Bad Gateway',
      '503': 'Service Unavailable',
      '504': 'Gateway Timeout',
      'ECONNABORTED': 'Connection Aborted',
      'ETIMEDOUT': 'Connection Timeout',
      'ENOTFOUND': 'DNS Lookup Failed',
      'ECONNREFUSED': 'Connection Refused',
      'ECONNRESET': 'Connection Reset',
      'rate_limit': 'Rate Limit Exceeded',
      'unauthorized': 'Authentication Failed',
      'server_error': 'Server Error',
      'timeout': 'Request Timeout',
      'network_error': 'Network Error',
      'invalid_response': 'Invalid Response'
    };
    
    return errorDescriptions[errorCode] || errorCode;
  }
}

module.exports = new AccountErrorStatsService();