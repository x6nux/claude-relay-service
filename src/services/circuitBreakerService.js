const redis = require('../models/redis');
const logger = require('../utils/logger');
const EventEmitter = require('events');

/**
 * 熔断器服务 - 用于账户错误隔离和自动恢复
 * 
 * 熔断器状态:
 * - CLOSED: 正常状态，请求正常通过
 * - OPEN: 熔断状态，请求被拒绝
 * - HALF_OPEN: 半开状态，允许少量请求通过以测试服务是否恢复
 */
class CircuitBreakerService extends EventEmitter {
  constructor() {
    super();
    
    // 熔断器配置
    this.config = {
      // 失败阈值 - 连续失败多少次后触发熔断
      failureThreshold: 5,
      // 成功阈值 - 半开状态下成功多少次后恢复
      successThreshold: 2,
      // 熔断持续时间（毫秒）
      timeout: 60000, // 1分钟
      // 半开状态测试间隔（毫秒）
      halfOpenTestInterval: 10000, // 10秒
      // 监控窗口大小（毫秒）
      monitoringWindow: 300000, // 5分钟
      // 错误率阈值（百分比）
      errorRateThreshold: 50
    };
    
    // 熔断器状态存储前缀
    this.REDIS_PREFIX = 'circuit_breaker:';
    
    // 熔断器状态枚举
    this.STATES = {
      CLOSED: 'CLOSED',
      OPEN: 'OPEN',
      HALF_OPEN: 'HALF_OPEN'
    };
    
    // 内存缓存，减少Redis查询
    this.stateCache = new Map();
    this.CACHE_TTL = 5000; // 5秒缓存
  }

  /**
   * 获取账户的熔断器状态
   */
  async getState(accountId) {
    try {
      // 检查内存缓存
      const cached = this.stateCache.get(accountId);
      if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
        return cached.data;
      }
      
      const key = `${this.REDIS_PREFIX}${accountId}`;
      const data = await redis.getClient().hgetall(key);
      
      if (!data || Object.keys(data).length === 0) {
        // 初始化熔断器状态
        const initialState = {
          state: this.STATES.CLOSED,
          failures: 0,
          successes: 0,
          lastFailureTime: 0,
          lastSuccessTime: 0,
          lastStateChangeTime: Date.now(),
          totalRequests: 0,
          totalFailures: 0,
          errorRate: 0
        };
        
        await this._setState(accountId, initialState);
        return initialState;
      }
      
      // 解析存储的数据
      const state = {
        state: data.state || this.STATES.CLOSED,
        failures: parseInt(data.failures) || 0,
        successes: parseInt(data.successes) || 0,
        lastFailureTime: parseInt(data.lastFailureTime) || 0,
        lastSuccessTime: parseInt(data.lastSuccessTime) || 0,
        lastStateChangeTime: parseInt(data.lastStateChangeTime) || Date.now(),
        totalRequests: parseInt(data.totalRequests) || 0,
        totalFailures: parseInt(data.totalFailures) || 0,
        errorRate: parseFloat(data.errorRate) || 0
      };
      
      // 更新缓存
      this.stateCache.set(accountId, {
        data: state,
        timestamp: Date.now()
      });
      
      return state;
    } catch (error) {
      logger.error(`Failed to get circuit breaker state for ${accountId}:`, error);
      // 失败时返回关闭状态，避免影响正常请求
      return {
        state: this.STATES.CLOSED,
        failures: 0,
        successes: 0,
        lastFailureTime: 0,
        lastSuccessTime: 0,
        lastStateChangeTime: Date.now(),
        totalRequests: 0,
        totalFailures: 0,
        errorRate: 0
      };
    }
  }

  /**
   * 设置账户的熔断器状态
   */
  async _setState(accountId, state) {
    try {
      const key = `${this.REDIS_PREFIX}${accountId}`;
      const data = {
        state: state.state,
        failures: state.failures.toString(),
        successes: state.successes.toString(),
        lastFailureTime: state.lastFailureTime.toString(),
        lastSuccessTime: state.lastSuccessTime.toString(),
        lastStateChangeTime: state.lastStateChangeTime.toString(),
        totalRequests: state.totalRequests.toString(),
        totalFailures: state.totalFailures.toString(),
        errorRate: state.errorRate.toString()
      };
      
      await redis.getClient().hset(key, data);
      
      // 设置过期时间（比监控窗口长一些）
      await redis.getClient().expire(key, this.config.monitoringWindow / 1000 + 3600);
      
      // 清除缓存
      this.stateCache.delete(accountId);
      
      // 触发状态变更事件
      this.emit('stateChange', {
        accountId,
        oldState: state.oldState,
        newState: state.state,
        timestamp: Date.now()
      });
    } catch (error) {
      logger.error(`Failed to set circuit breaker state for ${accountId}:`, error);
    }
  }

  /**
   * 检查是否允许请求通过
   */
  async canRequest(accountId) {
    const state = await this.getState(accountId);
    const now = Date.now();
    
    switch (state.state) {
      case this.STATES.CLOSED:
        // 正常状态，允许通过
        return { allowed: true, state: state.state };
        
      case this.STATES.OPEN:
        // 检查是否应该转换到半开状态
        if (now - state.lastStateChangeTime >= this.config.timeout) {
          // 转换到半开状态
          await this._transitionToHalfOpen(accountId, state);
          return { allowed: true, state: this.STATES.HALF_OPEN };
        }
        // 仍在熔断中
        return { 
          allowed: false, 
          state: state.state,
          retryAfter: this.config.timeout - (now - state.lastStateChangeTime)
        };
        
      case this.STATES.HALF_OPEN:
        // 半开状态，限制请求频率
        const timeSinceLastRequest = now - Math.max(state.lastFailureTime, state.lastSuccessTime);
        if (timeSinceLastRequest >= this.config.halfOpenTestInterval) {
          return { allowed: true, state: state.state };
        }
        return { 
          allowed: false, 
          state: state.state,
          retryAfter: this.config.halfOpenTestInterval - timeSinceLastRequest
        };
        
      default:
        logger.warn(`Unknown circuit breaker state: ${state.state} for account ${accountId}`);
        return { allowed: true, state: this.STATES.CLOSED };
    }
  }

  /**
   * 记录请求成功
   */
  async recordSuccess(accountId) {
    const state = await this.getState(accountId);
    const now = Date.now();
    
    // 更新统计
    state.successes++;
    state.lastSuccessTime = now;
    state.totalRequests++;
    
    // 计算错误率
    if (state.totalRequests > 0) {
      state.errorRate = (state.totalFailures / state.totalRequests) * 100;
    }
    
    logger.debug(`🟢 Circuit breaker success recorded for ${accountId}: ${state.successes} successes`);
    
    switch (state.state) {
      case this.STATES.HALF_OPEN:
        // 检查是否达到恢复阈值
        if (state.successes >= this.config.successThreshold) {
          await this._transitionToClosed(accountId, state);
        } else {
          await this._setState(accountId, state);
        }
        break;
        
      case this.STATES.CLOSED:
        // 在关闭状态下重置失败计数
        if (state.failures > 0) {
          state.failures = 0;
        }
        await this._setState(accountId, state);
        break;
        
      case this.STATES.OPEN:
        // 不应该在开启状态下有成功请求，但还是记录
        await this._setState(accountId, state);
        break;
    }
  }

  /**
   * 记录请求失败
   */
  async recordFailure(accountId, error = null) {
    const state = await this.getState(accountId);
    const now = Date.now();
    
    // 更新统计
    state.failures++;
    state.lastFailureTime = now;
    state.totalRequests++;
    state.totalFailures++;
    
    // 计算错误率
    if (state.totalRequests > 0) {
      state.errorRate = (state.totalFailures / state.totalRequests) * 100;
    }
    
    logger.warn(`🔴 Circuit breaker failure recorded for ${accountId}: ${state.failures} failures${error ? `, error: ${error}` : ''}`);
    
    switch (state.state) {
      case this.STATES.CLOSED:
        // 检查是否达到熔断阈值
        if (state.failures >= this.config.failureThreshold || 
            (state.totalRequests >= 10 && state.errorRate >= this.config.errorRateThreshold)) {
          await this._transitionToOpen(accountId, state);
        } else {
          await this._setState(accountId, state);
        }
        break;
        
      case this.STATES.HALF_OPEN:
        // 半开状态下任何失败都会重新开启熔断
        await this._transitionToOpen(accountId, state);
        break;
        
      case this.STATES.OPEN:
        // 已经在开启状态，只更新统计
        await this._setState(accountId, state);
        break;
    }
  }

  /**
   * 转换到关闭状态
   */
  async _transitionToClosed(accountId, currentState) {
    logger.info(`✅ Circuit breaker CLOSED for account ${accountId}`);
    
    const newState = {
      ...currentState,
      state: this.STATES.CLOSED,
      oldState: currentState.state,
      failures: 0,
      successes: 0,
      lastStateChangeTime: Date.now()
    };
    
    await this._setState(accountId, newState);
  }

  /**
   * 转换到开启状态
   */
  async _transitionToOpen(accountId, currentState) {
    logger.warn(`🚫 Circuit breaker OPEN for account ${accountId} - Error rate: ${currentState.errorRate.toFixed(2)}%`);
    
    const newState = {
      ...currentState,
      state: this.STATES.OPEN,
      oldState: currentState.state,
      successes: 0,
      lastStateChangeTime: Date.now()
    };
    
    await this._setState(accountId, newState);
  }

  /**
   * 转换到半开状态
   */
  async _transitionToHalfOpen(accountId, currentState) {
    logger.info(`🔶 Circuit breaker HALF_OPEN for account ${accountId} - Testing recovery`);
    
    const newState = {
      ...currentState,
      state: this.STATES.HALF_OPEN,
      oldState: currentState.state,
      failures: 0,
      successes: 0,
      lastStateChangeTime: Date.now()
    };
    
    await this._setState(accountId, newState);
  }

  /**
   * 手动重置熔断器
   */
  async reset(accountId) {
    logger.info(`🔄 Manually resetting circuit breaker for account ${accountId}`);
    
    const state = await this.getState(accountId);
    await this._transitionToClosed(accountId, state);
  }

  /**
   * 获取所有账户的熔断器状态
   */
  async getAllStates() {
    try {
      const keys = await redis.getClient().keys(`${this.REDIS_PREFIX}*`);
      const states = {};
      
      for (const key of keys) {
        const accountId = key.replace(this.REDIS_PREFIX, '');
        states[accountId] = await this.getState(accountId);
      }
      
      return states;
    } catch (error) {
      logger.error('Failed to get all circuit breaker states:', error);
      return {};
    }
  }

  /**
   * 获取熔断器统计信息
   */
  async getStats() {
    const states = await this.getAllStates();
    const stats = {
      total: 0,
      closed: 0,
      open: 0,
      halfOpen: 0,
      averageErrorRate: 0,
      accounts: []
    };
    
    let totalErrorRate = 0;
    
    for (const [accountId, state] of Object.entries(states)) {
      stats.total++;
      
      switch (state.state) {
        case this.STATES.CLOSED:
          stats.closed++;
          break;
        case this.STATES.OPEN:
          stats.open++;
          break;
        case this.STATES.HALF_OPEN:
          stats.halfOpen++;
          break;
      }
      
      totalErrorRate += state.errorRate;
      
      if (state.state !== this.STATES.CLOSED) {
        stats.accounts.push({
          accountId,
          state: state.state,
          errorRate: state.errorRate,
          failures: state.failures,
          lastFailureTime: state.lastFailureTime
        });
      }
    }
    
    if (stats.total > 0) {
      stats.averageErrorRate = totalErrorRate / stats.total;
    }
    
    return stats;
  }

  /**
   * 清理过期的熔断器数据
   */
  async cleanup() {
    try {
      const states = await this.getAllStates();
      const now = Date.now();
      
      for (const [accountId, state] of Object.entries(states)) {
        // 如果账户长时间没有活动且处于关闭状态，清理数据
        const lastActivity = Math.max(state.lastFailureTime, state.lastSuccessTime);
        if (state.state === this.STATES.CLOSED && 
            now - lastActivity > this.config.monitoringWindow * 2) {
          const key = `${this.REDIS_PREFIX}${accountId}`;
          await redis.getClient().del(key);
          this.stateCache.delete(accountId);
          logger.debug(`🧹 Cleaned up circuit breaker data for inactive account ${accountId}`);
        }
      }
    } catch (error) {
      logger.error('Failed to cleanup circuit breaker data:', error);
    }
  }
}

module.exports = new CircuitBreakerService();