const logger = require('../utils/logger');
const redis = require('../models/redis');

class AccountTempBanService {
  constructor() {
    // Redis key 前缀
    this.TEMP_BAN_KEY_PREFIX = 'temp_ban:account:';
    this.BAN_REASON_KEY_PREFIX = 'temp_ban:reason:';
    
    // 默认禁用时长（10分钟）
    this.DEFAULT_BAN_DURATION = 10 * 60; // 秒
    
    // 错误类型和对应的禁用时长
    this.BAN_DURATIONS = {
      'rate_limit': 30 * 60,        // 限流错误禁用30分钟
      'unauthorized': 60 * 60,       // 认证错误禁用1小时
      'server_error': 10 * 60,       // 服务器错误禁用10分钟
      'timeout': 5 * 60,             // 超时错误禁用5分钟
      'network_error': 5 * 60,       // 网络错误禁用5分钟
      'invalid_response': 10 * 60,   // 无效响应禁用10分钟
      'default': 10 * 60             // 默认禁用10分钟
    };
  }

  // 🚫 临时禁用账号
  async banAccount(accountId, reason = 'unknown', duration = null) {
    try {
      const client = redis.getClient();
      if (!client) {
        logger.error('❌ Redis client not available for temp ban');
        return false;
      }

      // 确定禁用时长
      const banDuration = duration || this.BAN_DURATIONS[reason] || this.DEFAULT_BAN_DURATION;
      
      // 设置禁用标记
      const banKey = `${this.TEMP_BAN_KEY_PREFIX}${accountId}`;
      const reasonKey = `${this.BAN_REASON_KEY_PREFIX}${accountId}`;
      
      // 记录禁用时间和原因
      const banData = {
        bannedAt: new Date().toISOString(),
        reason: reason,
        duration: banDuration,
        expiresAt: new Date(Date.now() + banDuration * 1000).toISOString()
      };
      
      // 使用 Redis 事务确保原子性
      const multi = client.multi();
      multi.setex(banKey, banDuration, JSON.stringify(banData));
      multi.setex(reasonKey, banDuration, reason);
      await multi.exec();
      
      logger.warn(`🚫 Account ${accountId} temporarily banned for ${banDuration}s due to: ${reason}`);
      
      return true;
    } catch (error) {
      logger.error(`❌ Failed to ban account ${accountId}:`, error);
      return false;
    }
  }

  // ✅ 检查账号是否被临时禁用
  async isAccountBanned(accountId) {
    try {
      const client = redis.getClient();
      if (!client) {
        // Redis 不可用时，不阻止账号使用
        return false;
      }

      const banKey = `${this.TEMP_BAN_KEY_PREFIX}${accountId}`;
      const banData = await client.get(banKey);
      
      if (banData) {
        const ban = JSON.parse(banData);
        logger.debug(`🚫 Account ${accountId} is banned until ${ban.expiresAt}`);
        return {
          isBanned: true,
          reason: ban.reason,
          expiresAt: ban.expiresAt,
          remainingSeconds: Math.max(0, Math.floor((new Date(ban.expiresAt) - new Date()) / 1000))
        };
      }
      
      return { isBanned: false };
    } catch (error) {
      logger.error(`❌ Failed to check ban status for account ${accountId}:`, error);
      // 错误时不阻止账号使用
      return { isBanned: false };
    }
  }

  // 🔓 手动解除账号禁用
  async unbanAccount(accountId) {
    try {
      const client = redis.getClient();
      if (!client) return false;

      const banKey = `${this.TEMP_BAN_KEY_PREFIX}${accountId}`;
      const reasonKey = `${this.BAN_REASON_KEY_PREFIX}${accountId}`;
      
      const multi = client.multi();
      multi.del(banKey);
      multi.del(reasonKey);
      await multi.exec();
      
      logger.info(`🔓 Account ${accountId} manually unbanned`);
      
      return true;
    } catch (error) {
      logger.error(`❌ Failed to unban account ${accountId}:`, error);
      return false;
    }
  }

  // 📊 获取所有被禁用的账号
  async getBannedAccounts() {
    try {
      const client = redis.getClient();
      if (!client) return [];

      const banKeys = await client.keys(`${this.TEMP_BAN_KEY_PREFIX}*`);
      const bannedAccounts = [];
      
      for (const key of banKeys) {
        const accountId = key.replace(this.TEMP_BAN_KEY_PREFIX, '');
        const banData = await client.get(key);
        
        if (banData) {
          const ban = JSON.parse(banData);
          bannedAccounts.push({
            accountId,
            ...ban
          });
        }
      }
      
      return bannedAccounts;
    } catch (error) {
      logger.error('❌ Failed to get banned accounts:', error);
      return [];
    }
  }

  // 🔍 根据错误判断是否应该禁用账号
  shouldBanAccount(error, response) {
    // 429 - 限流错误
    if (response?.status === 429) {
      return { shouldBan: true, reason: 'rate_limit' };
    }
    
    // 401/403 - 认证错误
    if (response?.status === 401 || response?.status === 403) {
      return { shouldBan: true, reason: 'unauthorized' };
    }
    
    // 5xx - 服务器错误
    if (response?.status >= 500) {
      return { shouldBan: true, reason: 'server_error' };
    }
    
    // 超时错误
    if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
      return { shouldBan: true, reason: 'timeout' };
    }
    
    // 网络错误
    if (error?.code === 'ENOTFOUND' || error?.code === 'ECONNREFUSED') {
      return { shouldBan: true, reason: 'network_error' };
    }
    
    // 无效响应
    if (response && !response.data) {
      return { shouldBan: true, reason: 'invalid_response' };
    }
    
    // 默认不禁用
    return { shouldBan: false };
  }

  // 🧹 清理过期的禁用记录（通过 Redis TTL 自动处理，这个方法用于手动清理）
  async cleanupExpiredBans() {
    try {
      const bannedAccounts = await this.getBannedAccounts();
      let cleanedCount = 0;
      
      for (const account of bannedAccounts) {
        const expiresAt = new Date(account.expiresAt);
        if (expiresAt < new Date()) {
          await this.unbanAccount(account.accountId);
          cleanedCount++;
        }
      }
      
      if (cleanedCount > 0) {
        logger.info(`🧹 Cleaned up ${cleanedCount} expired account bans`);
      }
      
      return cleanedCount;
    } catch (error) {
      logger.error('❌ Failed to cleanup expired bans:', error);
      return 0;
    }
  }
}

module.exports = new AccountTempBanService();