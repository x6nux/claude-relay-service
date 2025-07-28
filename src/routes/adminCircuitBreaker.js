const router = require('express').Router();
const { authenticateAdmin } = require('../middleware/auth');
const circuitBreakerService = require('../services/circuitBreakerService');
const accountRecoveryService = require('../services/accountRecoveryService');
const logger = require('../utils/logger');

// 获取所有熔断器状态
router.get('/circuit-breakers', authenticateAdmin, async (req, res) => {
  try {
    const states = await circuitBreakerService.getAllStates();
    const stats = await circuitBreakerService.getStats();
    
    res.json({
      success: true,
      stats,
      states
    });
  } catch (error) {
    logger.error('Failed to get circuit breaker states:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get circuit breaker states'
    });
  }
});

// 获取特定账户的熔断器状态
router.get('/circuit-breakers/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params;
    const state = await circuitBreakerService.getState(accountId);
    
    res.json({
      success: true,
      accountId,
      state
    });
  } catch (error) {
    logger.error(`Failed to get circuit breaker state for ${req.params.accountId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to get circuit breaker state'
    });
  }
});

// 重置熔断器
router.post('/circuit-breakers/:accountId/reset', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params;
    await circuitBreakerService.reset(accountId);
    
    logger.info(`Circuit breaker reset for account ${accountId} by admin ${req.admin.username}`);
    
    res.json({
      success: true,
      message: 'Circuit breaker reset successfully'
    });
  } catch (error) {
    logger.error(`Failed to reset circuit breaker for ${req.params.accountId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset circuit breaker'
    });
  }
});

// 获取账户恢复服务状态
router.get('/recovery-service/status', authenticateAdmin, async (req, res) => {
  try {
    const status = accountRecoveryService.getStatus();
    
    res.json({
      success: true,
      status
    });
  } catch (error) {
    logger.error('Failed to get recovery service status:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get recovery service status'
    });
  }
});

// 手动触发账户恢复
router.post('/recovery-service/recover/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params;
    const result = await accountRecoveryService.triggerRecovery(accountId);
    
    logger.info(`Account recovery triggered for ${accountId} by admin ${req.admin.username}`);
    
    res.json({
      success: result.success,
      message: result.success ? 'Account recovery successful' : 'Account recovery failed',
      error: result.error
    });
  } catch (error) {
    logger.error(`Failed to trigger recovery for ${req.params.accountId}:`, error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger account recovery'
    });
  }
});

// 触发健康检查
router.post('/recovery-service/health-check', authenticateAdmin, async (req, res) => {
  try {
    logger.info(`Health check triggered by admin ${req.admin.username}`);
    
    // 异步执行健康检查
    accountRecoveryService.performHealthCheck().catch(error => {
      logger.error('Health check failed:', error);
    });
    
    res.json({
      success: true,
      message: 'Health check started'
    });
  } catch (error) {
    logger.error('Failed to trigger health check:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to trigger health check'
    });
  }
});

module.exports = router;