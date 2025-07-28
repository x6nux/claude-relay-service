// 通用工具函数

/**
 * 获取请求的真实 IP 地址
 * 优先级：CF-Connecting-IP > X-Forwarded-For > X-Real-IP > req.ip > socket
 * @param {Object} req - Express 请求对象
 * @returns {string} 客户端 IP 地址
 */
function getRealIP(req) {
  return req.get('CF-Connecting-IP') || 
         req.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
         req.get('X-Real-IP') || 
         req.ip || 
         req.connection?.remoteAddress || 
         req.socket?.remoteAddress || 
         'unknown';
}

module.exports = {
  getRealIP
};