const fs = require('fs');
const path = require('path');
const config = require('../../config/config');
const logger = require('../utils/logger');

/**
 * 请求日志记录中间件
 * 记录来自 /claude 路径的请求体和请求头到 JSON 文件
 */
function createRequestLoggerMiddleware() {
  // 确保数据目录存在
  const dataDir = path.join(__dirname, '..', '..', 'data', 'request-logs');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  return (req, _res, next) => {
    // 检查是否启用了请求日志功能
    if (!config.requestLogging?.enabled) {
      return next();
    }

    // 检查是否是来自 /claude 路径的请求
    if (!req.originalUrl.startsWith('/claude')) {
      return next();
    }

    try {
      // 生成唯一的请求ID和时间戳
      const requestId = generateRequestId();
      const timestamp = new Date().toISOString();
      
      // 收集请求信息
      const requestData = {
        id: requestId,
        timestamp: timestamp,
        method: req.method,
        url: req.originalUrl,
        path: req.path,
        query: req.query,
        headers: req.headers, // 不再进行敏感信息掩码
        body: req.body,
        ip: req.ip || req.connection.remoteAddress,
        userAgent: req.get('User-Agent'),
        contentType: req.get('Content-Type'),
        contentLength: req.get('Content-Length')
      };

      // 异步写入文件，不阻塞请求
      setImmediate(() => {
        writeRequestLog(requestData, dataDir);
      });

      logger.debug(`📝 Request logged: ${requestId} - ${req.method} ${req.originalUrl}`);

    } catch (error) {
      logger.error('❌ Failed to log request:', error);
      // 不阻塞请求继续执行
    }

    next();
  };
}

/**
 * 生成唯一的请求ID
 */
function generateRequestId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `req_${timestamp}_${random}`;
}

/**
 * 写入请求日志到文件
 */
function writeRequestLog(requestData, dataDir) {
  try {
    // 按日期组织文件
    const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    const filename = `claude-requests-${date}.json`;
    const filepath = path.join(dataDir, filename);

    // 读取现有文件内容（如果存在）
    let logs = [];
    if (fs.existsSync(filepath)) {
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        logs = JSON.parse(content);
      } catch (parseError) {
        logger.warn(`⚠️ Failed to parse existing log file ${filename}, starting fresh:`, parseError.message);
        logs = [];
      }
    }

    // 添加新的请求记录
    logs.push(requestData);

    // 限制单个文件的记录数量（避免文件过大）
    const maxRecordsPerFile = config.requestLogging?.maxRecordsPerFile || 1000;
    if (logs.length > maxRecordsPerFile) {
      logs = logs.slice(-maxRecordsPerFile); // 保留最新的记录
    }

    // 写入文件
    fs.writeFileSync(filepath, JSON.stringify(logs, null, 2), 'utf8');
    
    logger.debug(`📁 Request log written to: ${filename} (${logs.length} records)`);

  } catch (error) {
    logger.error('❌ Failed to write request log:', error);
  }
}

/**
 * 清理过期的日志文件
 */
function cleanupOldLogs() {
  if (!config.requestLogging?.enabled) {
    return;
  }

  try {
    const dataDir = path.join(__dirname, '..', '..', 'data', 'request-logs');
    if (!fs.existsSync(dataDir)) {
      return;
    }

    const retentionDays = config.requestLogging?.retentionDays || 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    const files = fs.readdirSync(dataDir);
    let deletedCount = 0;

    files.forEach(file => {
      if (!file.startsWith('claude-requests-') || !file.endsWith('.json')) {
        return;
      }

      const filePath = path.join(dataDir, file);
      const stats = fs.statSync(filePath);
      
      if (stats.mtime < cutoffDate) {
        fs.unlinkSync(filePath);
        deletedCount++;
        logger.debug(`🗑️ Deleted old request log: ${file}`);
      }
    });

    if (deletedCount > 0) {
      logger.info(`🧹 Cleaned up ${deletedCount} old request log files`);
    }

  } catch (error) {
    logger.error('❌ Failed to cleanup old request logs:', error);
  }
}

module.exports = {
  createRequestLoggerMiddleware,
  cleanupOldLogs
};