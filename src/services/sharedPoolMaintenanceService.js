const cron = require('node-cron');
const logger = require('../utils/logger');
const sharedPoolService = require('./sharedPoolService');

class SharedPoolMaintenanceService {
  constructor() {
    this.maintenanceTask = null;
    this.isRunning = false;
    this.lastRunTime = null;
    this.lastRunResults = null;
  }

  // 🚀 启动定时维护任务
  startMaintenanceSchedule(cronExpression = '0 */6 * * *') { // 默认每6小时运行一次
    try {
      if (this.maintenanceTask) {
        logger.warn('⚠️ Maintenance task already running');
        return;
      }

      this.maintenanceTask = cron.schedule(cronExpression, async () => {
        await this.runMaintenance();
      }, {
        scheduled: true,
        timezone: "Asia/Shanghai" // 可以根据需要调整时区
      });

      logger.success(`✅ Shared pool maintenance scheduled with cron: ${cronExpression}`);
      
      // 启动时立即执行一次维护
      this.runMaintenance().catch(error => {
        logger.error('❌ Initial maintenance run failed:', error);
      });
    } catch (error) {
      logger.error('❌ Failed to start maintenance schedule:', error);
      throw error;
    }
  }

  // 🛑 停止定时维护任务
  stopMaintenanceSchedule() {
    if (this.maintenanceTask) {
      this.maintenanceTask.stop();
      this.maintenanceTask = null;
      logger.info('🛑 Shared pool maintenance schedule stopped');
    }
  }

  // 🔧 执行维护任务
  async runMaintenance() {
    if (this.isRunning) {
      logger.warn('⚠️ Maintenance already in progress, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info('🔧 Starting scheduled shared pool maintenance...');
      
      // 执行共享池维护
      const results = await sharedPoolService.performPoolMaintenance();
      
      const duration = Date.now() - startTime;
      
      this.lastRunTime = new Date().toISOString();
      this.lastRunResults = {
        ...results,
        duration: `${duration}ms`,
        success: true
      };

      logger.success(`✅ Scheduled maintenance completed in ${duration}ms`);
      
      return this.lastRunResults;
    } catch (error) {
      logger.error('❌ Scheduled maintenance failed:', error);
      
      this.lastRunResults = {
        error: error.message,
        success: false,
        timestamp: new Date().toISOString()
      };
      
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  // 📊 获取维护状态
  getMaintenanceStatus() {
    return {
      isScheduled: !!this.maintenanceTask,
      isRunning: this.isRunning,
      lastRunTime: this.lastRunTime,
      lastRunResults: this.lastRunResults
    };
  }

  // 🔄 手动触发维护
  async triggerManualMaintenance() {
    logger.info('🔄 Manual maintenance triggered');
    return await this.runMaintenance();
  }
}

module.exports = new SharedPoolMaintenanceService();