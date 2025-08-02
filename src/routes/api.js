const express = require('express');
const claudeRelayService = require('../services/claudeRelayService');
const apiKeyService = require('../services/apiKeyService');
const claudeAccountService = require('../services/claudeAccountService');
const oauthHelper = require('../utils/oauthHelper');
const { authenticateApiKey } = require('../middleware/auth');
const logger = require('../utils/logger');
const redis = require('../models/redis');

const router = express.Router();

// 🔧 共享的消息处理函数
async function handleMessagesRequest(req, res) {
  try {
    const startTime = Date.now();
    
    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      });
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      });
    }

    // 检查是否为流式请求
    const isStream = req.body.stream === true;
    
    logger.api(`🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`);

    if (isStream) {
      // 流式响应 - 只使用官方真实usage数据
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('X-Accel-Buffering', 'no'); // 禁用 Nginx 缓冲
      
      // 禁用 Nagle 算法，确保数据立即发送
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true);
      }
      
      // 流式响应不需要额外处理，中间件已经设置了监听器
      
      let usageDataCaptured = false;
      
      // 使用自定义流处理器来捕获usage数据
      await claudeRelayService.relayStreamRequestWithUsageCapture(req.body, req.apiKey, res, req.headers, (usageData) => {
        // 回调函数：当检测到完整usage数据时记录真实token使用量
        logger.info('🎯 Usage callback triggered with complete data:', JSON.stringify(usageData, null, 2));
        
        if (usageData && usageData.input_tokens !== undefined && usageData.output_tokens !== undefined) {
          const inputTokens = usageData.input_tokens || 0;
          const outputTokens = usageData.output_tokens || 0;
          const cacheCreateTokens = usageData.cache_creation_input_tokens || 0;
          const cacheReadTokens = usageData.cache_read_input_tokens || 0;
          const model = usageData.model || 'unknown';
          
          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID和池ID）
          const accountId = usageData.accountId;
          const poolId = usageData.poolId;
          apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model, accountId, poolId).catch(error => {
            logger.error('❌ Failed to record stream usage:', error);
          });
          
          // 更新时间窗口内的token计数
          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
            redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens).catch(error => {
              logger.error('❌ Failed to update rate limit token count:', error);
            });
            logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`);
          }
          
          usageDataCaptured = true;
          logger.api(`📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
        } else {
          logger.warn('⚠️ Usage callback triggered but data is incomplete:', JSON.stringify(usageData));
        }
      });
      
      // 流式请求完成后 - 如果没有捕获到usage数据，记录警告但不进行估算
      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn('⚠️ No usage data captured from SSE stream - no statistics recorded (official data only)');
        }
      }, 1000); // 1秒后检查
    } else {
      // 非流式响应 - 只使用官方真实usage数据
      logger.info('📄 Starting non-streaming request', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      });
      
      const response = await claudeRelayService.relayRequest(req.body, req.apiKey, req, res, req.headers);
      
      logger.info('📡 Claude API response received', {
        statusCode: response.statusCode,
        headers: JSON.stringify(response.headers),
        bodyLength: response.body ? response.body.length : 0
      });
      
      res.status(response.statusCode);
      
      // 设置响应头
      Object.keys(response.headers).forEach(key => {
        if (key.toLowerCase() !== 'content-encoding') {
          res.setHeader(key, response.headers[key]);
        }
      });
      
      let usageRecorded = false;
      
      // 尝试解析JSON响应并提取usage信息
      try {
        const jsonData = JSON.parse(response.body);
        
        logger.info('📊 Parsed Claude API response:', JSON.stringify(jsonData, null, 2));
        
        // 从Claude API响应中提取usage信息（完整的token分类体系）
        if (jsonData.usage && jsonData.usage.input_tokens !== undefined && jsonData.usage.output_tokens !== undefined) {
          const inputTokens = jsonData.usage.input_tokens || 0;
          const outputTokens = jsonData.usage.output_tokens || 0;
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0;
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0;
          const model = jsonData.model || req.body.model || 'unknown';
          
          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID和池ID）
          const accountId = response.accountId;
          const poolId = response.poolId;
          await apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model, accountId, poolId);
          
          // 更新时间窗口内的token计数
          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens;
            await redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens);
            logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`);
          }
          
          usageRecorded = true;
          logger.api(`📊 Non-stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
        } else {
          logger.warn('⚠️ No usage data found in Claude API JSON response');
        }
        
        res.json(jsonData);
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse Claude API response as JSON:', parseError.message);
        logger.info('📄 Raw response body:', response.body);
        res.send(response.body);
      }
      
      // 如果没有记录usage，只记录警告，不进行估算
      if (!usageRecorded) {
        logger.warn('⚠️ No usage data recorded for non-stream request - no statistics recorded (official data only)');
      }
    }
    
    const duration = Date.now() - startTime;
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`);
    
  } catch (error) {
    logger.error('❌ Claude relay error:', error.message, {
      code: error.code,
      stack: error.stack
    });
    
    // 确保在任何情况下都能返回有效的JSON响应
    if (!res.headersSent) {
      // 根据错误类型设置适当的状态码
      let statusCode = 500;
      let errorType = 'Relay service error';
      
      if (error.message.includes('Connection reset') || error.message.includes('socket hang up')) {
        statusCode = 502;
        errorType = 'Upstream connection error';
      } else if (error.message.includes('Connection refused')) {
        statusCode = 502;
        errorType = 'Upstream service unavailable';
      } else if (error.message.includes('timeout')) {
        statusCode = 504;
        errorType = 'Upstream timeout';
      } else if (error.message.includes('resolve') || error.message.includes('ENOTFOUND')) {
        statusCode = 502;
        errorType = 'Upstream hostname resolution failed';
      }
      
      res.status(statusCode).json({
        error: errorType,
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      });
    } else {
      // 如果响应头已经发送，尝试结束响应
      if (!res.destroyed && !res.finished) {
        res.end();
      }
    }
  }
}

// 🚀 Claude API messages 端点 - /api/v1/messages
router.post('/v1/messages', authenticateApiKey, handleMessagesRequest);

// 🚀 Claude API messages 端点 - /claude/v1/messages (别名)
router.post('/claude/v1/messages', authenticateApiKey, handleMessagesRequest);

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck();
    
    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'claude-relay-service',
      version: '1.0.0',
      ...healthStatus
    });
  } catch (error) {
    logger.error('❌ Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      service: 'claude-relay-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 📊 API Key状态检查端点 - /api/v1/key-info
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id);
    
    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        usage
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Key info error:', error);
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    });
  }
});

// 📈 使用统计端点 - /api/v1/usage
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id);
    
    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: 0 // 请求限制已移除
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Usage stats error:', error);
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    });
  }
});

// 🏢 Claude 账户管理 API 端点

// 验证 API Key 是否有管理账户的权限
// 可以通过以下方式授予权限：
// 1. API Key 名称包含 "admin" 或 "manage"
// 2. API Key 有特殊的前缀 cr_admin_
// 3. API Key 在 description 中包含 [ACCOUNT_MANAGEMENT] 标记
function checkAccountManagementPermission(req, res, next) {
  const apiKey = req.apiKey;
  
  // 检查多种授权方式
  const hasPermission = 
    // 检查 API Key 名称
    (apiKey.name && (apiKey.name.toLowerCase().includes('admin') || apiKey.name.toLowerCase().includes('manage'))) ||
    // 检查 API Key 前缀（需要在生成时特殊处理）
    (apiKey.key && apiKey.key.startsWith('cr_admin_')) ||
    // 检查描述中的特殊标记
    (apiKey.description && apiKey.description.includes('[ACCOUNT_MANAGEMENT]'));
  
  if (!hasPermission) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'This API key does not have permission to manage accounts. Add [ACCOUNT_MANAGEMENT] to the key description or use an admin key.'
    });
  }
  
  next();
}

// 获取所有 Claude 账户
router.get('/v1/accounts', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const accounts = await claudeAccountService.getAllAccounts();
    
    // 隐藏敏感信息
    const sanitizedAccounts = accounts.map(account => ({
      id: account.id,
      name: account.name,
      description: account.description,
      email: account.email,
      status: account.status,
      isActive: account.isActive,
      accountType: account.accountType,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastUsedAt: account.lastUsedAt,
      rateLimitStatus: account.rateLimitStatus,
      proxy: account.proxy ? {
        host: account.proxy.host,
        port: account.proxy.port,
        type: account.proxy.type
      } : null
    }));
    
    res.json({
      success: true,
      data: sanitizedAccounts
    });
  } catch (error) {
    logger.error('❌ Failed to get Claude accounts via API:', error);
    res.status(500).json({
      error: 'Failed to get accounts',
      message: error.message
    });
  }
});

// 创建新的 Claude 账户（支持 OAuth）
router.post('/v1/accounts', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const {
      name,
      description,
      email,
      password,
      refreshToken,
      claudeAiOauth,
      proxy,
      accountType
    } = req.body;

    // 验证必填字段
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    // 验证 accountType 的有效性
    if (accountType && !['shared', 'dedicated'].includes(accountType)) {
      return res.status(400).json({ error: 'Invalid account type. Must be "shared" or "dedicated"' });
    }

    // 验证 OAuth 数据
    if (claudeAiOauth) {
      if (!claudeAiOauth.access_token || !claudeAiOauth.refresh_token) {
        return res.status(400).json({ 
          error: 'Invalid OAuth data. Both access_token and refresh_token are required' 
        });
      }
    }

    // 验证代理配置
    if (proxy) {
      if (!proxy.host || !proxy.port) {
        return res.status(400).json({ 
          error: 'Invalid proxy configuration. Host and port are required' 
        });
      }
      if (proxy.type && !['http', 'https', 'socks5'].includes(proxy.type)) {
        return res.status(400).json({ 
          error: 'Invalid proxy type. Must be "http", "https", or "socks5"' 
        });
      }
    }

    const newAccount = await claudeAccountService.createAccount({
      name,
      description,
      email,
      password,
      refreshToken,
      claudeAiOauth,
      proxy,
      accountType: accountType || 'shared'
    });

    logger.success(`🏢 Account created via API: ${name} (${accountType || 'shared'})`);
    
    // 返回创建的账户信息（隐藏敏感数据）
    res.json({
      success: true,
      data: {
        id: newAccount.id,
        name: newAccount.name,
        description: newAccount.description,
        email: newAccount.email,
        accountType: newAccount.accountType,
        status: newAccount.status,
        createdAt: newAccount.createdAt
      }
    });
  } catch (error) {
    logger.error('❌ Failed to create Claude account via API:', error);
    res.status(500).json({
      error: 'Failed to create account',
      message: error.message
    });
  }
});

// 更新 Claude 账户
router.put('/v1/accounts/:accountId', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const { accountId } = req.params;
    const updates = req.body;

    // 移除不允许通过 API 更新的字段
    delete updates.id;
    delete updates.createdAt;
    delete updates.updatedAt;

    // 验证更新字段
    if (updates.accountType && !['shared', 'dedicated'].includes(updates.accountType)) {
      return res.status(400).json({ error: 'Invalid account type' });
    }

    if (updates.proxy) {
      if (!updates.proxy.host || !updates.proxy.port) {
        return res.status(400).json({ 
          error: 'Invalid proxy configuration. Host and port are required' 
        });
      }
      if (updates.proxy.type && !['http', 'https', 'socks5'].includes(updates.proxy.type)) {
        return res.status(400).json({ 
          error: 'Invalid proxy type' 
        });
      }
    }

    await claudeAccountService.updateAccount(accountId, updates);
    
    logger.success(`📝 Account updated via API: ${accountId}`);
    res.json({
      success: true,
      message: 'Account updated successfully'
    });
  } catch (error) {
    logger.error('❌ Failed to update Claude account via API:', error);
    res.status(500).json({
      error: 'Failed to update account',
      message: error.message
    });
  }
});

// 删除 Claude 账户
router.delete('/v1/accounts/:accountId', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const { accountId } = req.params;
    
    await claudeAccountService.deleteAccount(accountId);
    
    logger.success(`🗑️ Account deleted via API: ${accountId}`);
    res.json({
      success: true,
      message: 'Account deleted successfully'
    });
  } catch (error) {
    logger.error('❌ Failed to delete Claude account via API:', error);
    res.status(500).json({
      error: 'Failed to delete account',
      message: error.message
    });
  }
});

// OAuth 相关端点

// 简化的OAuth账号创建端点 - 直接提供OAuth数据
router.post('/v1/accounts/oauth/create', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const {
      name,
      description,
      proxy,
      accountType,
      // OAuth 数据
      accessToken,
      refreshToken,
      expiresIn = 3600,
      scopes = 'org:create_api_key user:profile user:inference'
    } = req.body;

    // 验证必填字段
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }

    if (!accessToken || !refreshToken) {
      return res.status(400).json({ 
        error: 'Both accessToken and refreshToken are required' 
      });
    }

    // 构造Claude格式的OAuth数据
    const claudeAiOauth = {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: scopes,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString()
    };

    // 创建账户
    const newAccount = await claudeAccountService.createAccount({
      name,
      description: description || '',
      claudeAiOauth,
      proxy,
      accountType: accountType || 'shared'
    });

    logger.success(`🏢 OAuth account created via simplified API: ${name}`);
    
    res.json({
      success: true,
      data: {
        id: newAccount.id,
        name: newAccount.name,
        description: newAccount.description,
        accountType: newAccount.accountType,
        status: newAccount.status,
        createdAt: newAccount.createdAt,
        expiresAt: newAccount.expiresAt
      }
    });
  } catch (error) {
    logger.error('❌ Failed to create OAuth account via simplified API:', error);
    res.status(500).json({
      error: 'Failed to create OAuth account',
      message: error.message
    });
  }
});

// 生成 OAuth 授权 URL
router.post('/v1/accounts/oauth/generate-url', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const { proxy } = req.body;
    const oauthParams = await oauthHelper.generateOAuthParams();
    
    // 创建 OAuth 会话
    const sessionId = require('crypto').randomUUID();
    await redis.setOAuthSession(sessionId, {
      codeVerifier: oauthParams.codeVerifier,
      state: oauthParams.state,
      codeChallenge: oauthParams.codeChallenge,
      proxy: proxy || null,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
    });
    
    logger.success('🔗 Generated OAuth authorization URL via API');
    res.json({
      success: true,
      data: {
        authUrl: oauthParams.authUrl,
        sessionId: sessionId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString()
      }
    });
  } catch (error) {
    logger.error('❌ Failed to generate OAuth URL via API:', error);
    res.status(500).json({
      error: 'Failed to generate OAuth URL',
      message: error.message
    });
  }
});

// 交换授权码获取 token
router.post('/v1/accounts/oauth/exchange-code', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const { sessionId, authorizationCode, callbackUrl } = req.body;
    
    if (!sessionId || (!authorizationCode && !callbackUrl)) {
      return res.status(400).json({ 
        error: 'Session ID and authorization code (or callback URL) are required' 
      });
    }
    
    // 从 Redis 获取 OAuth 会话信息
    const oauthSession = await redis.getOAuthSession(sessionId);
    if (!oauthSession) {
      return res.status(400).json({ error: 'Invalid or expired OAuth session' });
    }
    
    // 检查会话是否过期
    if (new Date() > new Date(oauthSession.expiresAt)) {
      await redis.deleteOAuthSession(sessionId);
      return res.status(400).json({ error: 'OAuth session has expired' });
    }
    
    // 处理授权码
    let finalAuthCode;
    const inputValue = callbackUrl || authorizationCode;
    
    try {
      finalAuthCode = oauthHelper.parseCallbackUrl(inputValue);
    } catch (parseError) {
      return res.status(400).json({ 
        error: 'Failed to parse authorization input',
        message: parseError.message 
      });
    }
    
    // 检查授权码是否已经使用过（通过在Redis中标记）
    const usedCodeKey = `oauth:used_code:${finalAuthCode}`;
    const isUsed = await redis.getClient().get(usedCodeKey);
    
    if (isUsed) {
      return res.status(400).json({ 
        error: 'Authorization code has already been used',
        message: 'Each authorization code can only be used once. Please generate a new authorization URL and try again.'
      });
    }
    
    // 标记授权码为已使用（设置15分钟过期，比授权码有效期略长）
    await redis.getClient().set(usedCodeKey, '1', 'EX', 900);
    
    // 交换访问令牌
    const tokenData = await oauthHelper.exchangeCodeForTokens(
      finalAuthCode,
      oauthSession.codeVerifier,
      oauthSession.state,
      oauthSession.proxy
    );
    
    // 清理 OAuth 会话
    await redis.deleteOAuthSession(sessionId);
    
    logger.success('🎉 Successfully exchanged authorization code via API');
    
    // 将驼峰格式转换为下划线格式
    const claudeAiOauth = {
      access_token: tokenData.accessToken,
      refresh_token: tokenData.refreshToken,
      expires_at: tokenData.expiresAt,
      scopes: tokenData.scopes,
      is_max: tokenData.isMax
    };
    
    res.json({
      success: true,
      data: {
        claudeAiOauth
      }
    });
  } catch (error) {
    logger.error('❌ Failed to exchange authorization code via API:', {
      error: error.message,
      stack: error.stack,
      sessionId: req.body.sessionId,
      // 不记录完整的授权码，只记录长度和前几个字符
      codeLength: req.body.callbackUrl ? req.body.callbackUrl.length : (req.body.authorizationCode ? req.body.authorizationCode.length : 0),
      codePrefix: req.body.callbackUrl ? req.body.callbackUrl.substring(0, 10) + '...' : (req.body.authorizationCode ? req.body.authorizationCode.substring(0, 10) + '...' : 'N/A')
    });
    
    // 返回更详细的错误信息
    let errorMessage = error.message || 'Unknown error';
    let statusCode = 500;
    
    // 根据错误类型设置不同的状态码
    if (errorMessage.includes('Invalid or expired OAuth session')) {
      statusCode = 400;
    } else if (errorMessage.includes('Token exchange failed: HTTP')) {
      statusCode = 502; // Bad Gateway - 上游服务错误
    }
    
    res.status(statusCode).json({
      error: 'Failed to exchange authorization code',
      message: errorMessage,
      details: error.response ? {
        status: error.response.status,
        data: error.response.data
      } : undefined
    });
  }
});

// 刷新账户 token
router.post('/v1/accounts/:accountId/refresh', authenticateApiKey, checkAccountManagementPermission, async (req, res) => {
  try {
    const { accountId } = req.params;
    
    const result = await claudeAccountService.refreshAccountToken(accountId);
    
    logger.success(`🔄 Token refreshed via API for account: ${accountId}`);
    res.json({
      success: true,
      data: {
        accountId,
        status: result.status,
        refreshedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    logger.error('❌ Failed to refresh account token via API:', error);
    res.status(500).json({
      error: 'Failed to refresh token',
      message: error.message
    });
  }
});

module.exports = router;