const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const claudeAccountService = require('./claudeAccountService');
const sessionHelper = require('../utils/sessionHelper');
const logger = require('../utils/logger');
const config = require('../../config/config');
const claudeCodeHeadersService = require('./claudeCodeHeadersService');
const circuitBreakerService = require('./circuitBreakerService');
const accountRecoveryService = require('./accountRecoveryService');

class ClaudeRelayService {
  constructor() {
    this.claudeApiUrl = config.claude.apiUrl;
    this.apiVersion = config.claude.apiVersion;
    this.betaHeader = config.claude.betaHeader;
    this.systemPrompt = config.claude.systemPrompt;
    this.claudeCodeSystemPrompt = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
  }

  // 🔍 判断是否是真实的 Claude Code 请求
  isRealClaudeCodeRequest(requestBody, clientHeaders) {
    // 检查 user-agent 是否匹配 Claude Code 格式
    const userAgent = clientHeaders?.['user-agent'] || clientHeaders?.['User-Agent'] || '';
    const isClaudeCodeUserAgent = /claude-cli\/\d+\.\d+\.\d+/.test(userAgent);
    
    // 检查系统提示词是否包含 Claude Code 标识
    const hasClaudeCodeSystemPrompt = this._hasClaudeCodeSystemPrompt(requestBody);
    
    // 只有当 user-agent 匹配且系统提示词正确时，才认为是真实的 Claude Code 请求
    return isClaudeCodeUserAgent && hasClaudeCodeSystemPrompt;
  }

  // 🔍 检查请求中是否包含 Claude Code 系统提示词
  _hasClaudeCodeSystemPrompt(requestBody) {
    if (!requestBody || !requestBody.system) return false;
    
    // 如果是字符串格式，一定不是真实的 Claude Code 请求
    if (typeof requestBody.system === 'string') {
      return false;
    } 
    
    // 处理数组格式
    if (Array.isArray(requestBody.system) && requestBody.system.length > 0) {
      const firstItem = requestBody.system[0];
      // 检查第一个元素是否包含 Claude Code 提示词
      return firstItem && 
             firstItem.type === 'text' && 
             firstItem.text && 
             firstItem.text === this.claudeCodeSystemPrompt;
    }
    
    return false;
  }

  // 🚀 转发请求到Claude API
  async relayRequest(requestBody, apiKeyData, clientRequest, clientResponse, clientHeaders, options = {}) {
    const maxRetries = options.maxRetries || 3; // 默认重试3次
    let lastResponse = null;
    let lastError = null;
    let usedAccountIds = new Set(); // 记录已使用的账户ID，避免重复使用
    
    for (let retryCount = 0; retryCount < maxRetries; retryCount++) {
      let upstreamRequest = null;
      
      try {
        // 调试日志：查看API Key数据
        if (retryCount === 0) {
          logger.info('🔍 API Key data received:', {
            apiKeyName: apiKeyData.name,
            enableModelRestriction: apiKeyData.enableModelRestriction,
            restrictedModels: apiKeyData.restrictedModels,
            requestedModel: requestBody.model
          });
        }

        // 检查模型限制
        if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels && apiKeyData.restrictedModels.length > 0) {
          const requestedModel = requestBody.model;
          if (retryCount === 0) {
            logger.info(`🔒 Model restriction check - Requested model: ${requestedModel}, Restricted models: ${JSON.stringify(apiKeyData.restrictedModels)}`);
          }
          
          if (requestedModel && apiKeyData.restrictedModels.includes(requestedModel)) {
            logger.warn(`🚫 Model restriction violation for key ${apiKeyData.name}: Attempted to use restricted model ${requestedModel}`);
            return {
              statusCode: 403,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                error: {
                  type: 'forbidden',
                  message: '暂无该模型访问权限'
                }
              })
            };
          }
        }
        
        // 生成会话哈希用于sticky会话
        const sessionHash = sessionHelper.generateSessionHash(requestBody);
        
        // 选择可用的Claude账户（支持专属绑定和sticky会话）
        let accountId, poolId;
        if (retryCount === 0) {
          const selection = await claudeAccountService.selectAccountForApiKey(apiKeyData, sessionHash);
          accountId = selection.accountId;
          poolId = selection.poolId;
        } else {
          // 重试时，需要选择不同的账户
          const selection = await claudeAccountService.selectAccountForApiKey(apiKeyData, null, usedAccountIds);
          accountId = selection.accountId;
          poolId = selection.poolId;
          logger.info(`🔄 Retry ${retryCount}/${maxRetries - 1}: Switching to new account ${accountId}`);
        }
        
        // 记录已使用的账户
        usedAccountIds.add(accountId);
        
        // 检查熔断器状态
        const circuitCheck = await circuitBreakerService.canRequest(accountId);
        if (!circuitCheck.allowed) {
          logger.warn(`🚫 Circuit breaker OPEN for account ${accountId}, state: ${circuitCheck.state}`);
          
          // 如果是第一次尝试或还有其他账户可用，尝试其他账户
          if (retryCount < maxRetries - 1) {
            continue;
          }
          
          // 没有可用账户了
          return {
            statusCode: 503,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error: {
                type: 'service_unavailable',
                message: 'Service temporarily unavailable. Please try again later.'
              }
            })
          };
        }
        
        logger.info(`📤 Processing API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId}${sessionHash ? `, session: ${sessionHash}` : ''}${retryCount > 0 ? `, retry: ${retryCount}` : ''}`);
        
        // 获取有效的访问token
        const accessToken = await claudeAccountService.getValidAccessToken(accountId);
        
        // 处理请求体（传递 clientHeaders 以判断是否需要设置 Claude Code 系统提示词）
        const processedBody = this._processRequestBody(requestBody, clientHeaders);
        
        // 获取代理配置
        const proxyAgent = await this._getProxyAgent(accountId);
        
        // 设置客户端断开监听器
        const handleClientDisconnect = () => {
          logger.info('🔌 Client disconnected, aborting upstream request');
          if (upstreamRequest && !upstreamRequest.destroyed) {
            upstreamRequest.destroy();
          }
        };
        
        // 监听客户端断开事件
        if (clientRequest) {
          clientRequest.once('close', handleClientDisconnect);
        }
        if (clientResponse) {
          clientResponse.once('close', handleClientDisconnect);
        }
        
        // 发送请求到Claude API（传入回调以获取请求对象）
        const response = await this._makeClaudeRequest(
          processedBody, 
          accessToken, 
          proxyAgent,
          clientHeaders,
          accountId,
          (req) => { upstreamRequest = req; },
          options
        );
        
        // 移除监听器（请求成功完成）
        if (clientRequest) {
          clientRequest.removeListener('close', handleClientDisconnect);
        }
        if (clientResponse) {
          clientResponse.removeListener('close', handleClientDisconnect);
        }
        
        // 检查响应状态
        if (response.statusCode === 429) {
          // 429状态码，需要重试
          logger.warn(`🚫 Rate limit (429) detected for account ${accountId}`);
          await claudeAccountService.markAccountRateLimited(accountId, sessionHash);
          // 记录失败到熔断器和恢复服务
          await circuitBreakerService.recordFailure(accountId, 'HTTP 429 Rate limit');
          await accountRecoveryService.recordAccountFailure(accountId, new Error('HTTP 429 Rate limit'));
          lastResponse = response;
          
          // 如果还有重试次数，继续下一次重试
          if (retryCount < maxRetries - 1) {
            // 指数退避延迟
            const delay = Math.min(1000 * Math.pow(2, retryCount), 10000); // 最长10秒
            logger.info(`⏳ Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        } else if (response.statusCode !== 200 && response.statusCode !== 201) {
          // 检查其他错误类型
          let isRateLimited = false;
          let isTokenRevoked = false;
          let isOrganizationDisabled = false;
          
          try {
            const responseBody = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
            
            // 检查是否是限流错误
            if (responseBody && responseBody.error && responseBody.error.message) {
              const errorMessage = responseBody.error.message.toLowerCase();
              const errorType = responseBody.error.type;
              
              if (errorMessage.includes('exceed your account\'s rate limit')) {
                isRateLimited = true;
              }
              // 检查是否是OAuth token被撤销的错误
              else if (errorMessage.includes('oauth token revoked') || 
                       errorMessage.includes('please run /login') ||
                       (errorMessage.includes('authentication_error') && !errorMessage.includes('OAuth authentication is currently not supported'))) {
                isTokenRevoked = true;
              }
              // 检查是否是组织被禁用
              else if (errorType === 'invalid_request_error' && 
                       errorMessage.includes('this organization has been disabled')) {
                isOrganizationDisabled = true;
              }
            }
          } catch (e) {
            // 如果解析失败，检查原始字符串
            if (response.body) {
              const bodyLower = response.body.toLowerCase();
              if (bodyLower.includes('exceed your account\'s rate limit')) {
                isRateLimited = true;
              } else if (bodyLower.includes('oauth token revoked') || 
                         bodyLower.includes('please run /login') ||
                         bodyLower.includes('authentication_error')) {
                isTokenRevoked = true;
              } else if (bodyLower.includes('this organization has been disabled')) {
                isOrganizationDisabled = true;
              }
            }
          }
          
          if (isOrganizationDisabled) {
            logger.error(`🚫 Account ${accountId} has been banned (organization disabled)`);
            // 标记账号为被封禁
            await claudeAccountService.updateAccount(accountId, {
              status: 'banned',
              errorMessage: 'Organization has been disabled',
              isActive: false
            });
            // 记录失败到熔断器和恢复服务
            await circuitBreakerService.recordFailure(accountId, 'Organization disabled');
            await accountRecoveryService.recordAccountFailure(accountId, new Error('Organization disabled'));
            lastResponse = response;
            
            // 如果还有重试次数，切换账号继续重试
            if (retryCount < maxRetries - 1) {
              logger.info(`🔄 Account banned, switching to a different account...`);
              continue;
            }
          } else if (isTokenRevoked) {
            logger.warn(`🔐 OAuth token revoked for account ${accountId}`);
            // 标记账号为不活跃
            await claudeAccountService.markAccountOAuthRevoked(accountId, 'OAuth token revoked');
            // 记录失败到熔断器和恢复服务
            await circuitBreakerService.recordFailure(accountId, 'OAuth token revoked');
            await accountRecoveryService.recordAccountFailure(accountId, new Error('OAuth token revoked'));
            lastResponse = response;
            
            // 如果还有重试次数，切换账号继续重试
            if (retryCount < maxRetries - 1) {
              logger.info(`🔄 OAuth token revoked, switching to a different account...`);
              continue;
            }
          } else if (isRateLimited) {
            logger.warn(`🚫 Rate limit detected for account ${accountId}, status: ${response.statusCode}`);
            // 标记账号为限流状态并删除粘性会话映射
            await claudeAccountService.markAccountRateLimited(accountId, sessionHash);
            // 记录失败到熔断器和恢复服务
            await circuitBreakerService.recordFailure(accountId, 'Rate limit exceeded');
            await accountRecoveryService.recordAccountFailure(accountId, new Error('Rate limit exceeded'));
            lastResponse = response;
            
            // 如果还有重试次数，继续下一次重试
            if (retryCount < maxRetries - 1) {
              const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
              logger.info(`⏳ Waiting ${delay}ms before retry...`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
          }
        } else if (response.statusCode === 200 || response.statusCode === 201) {
          // 请求成功
          // 如果请求成功，检查并移除限流状态
          const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
          if (isRateLimited) {
            await claudeAccountService.removeAccountRateLimit(accountId);
          }
          
          // 记录成功到熔断器和恢复服务
          await circuitBreakerService.recordSuccess(accountId);
          await accountRecoveryService.recordAccountSuccess(accountId);
          
          // 只有真实的 Claude Code 请求才更新 headers
          if (clientHeaders && Object.keys(clientHeaders).length > 0 && this.isRealClaudeCodeRequest(requestBody, clientHeaders)) {
            await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders);
          }
          
          // 记录成功的API调用
          const inputTokens = requestBody.messages ? 
            requestBody.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4 : 0; // 粗略估算
          const outputTokens = response.content ? 
            response.content.reduce((sum, content) => sum + (content.text?.length || 0), 0) / 4 : 0;
          
          logger.info(`✅ API request completed - Key: ${apiKeyData.name}, Account: ${accountId}, Model: ${requestBody.model}, Input: ~${Math.round(inputTokens)} tokens, Output: ~${Math.round(outputTokens)} tokens`);
          
          // 记录成功到熔断器和恢复服务
          await circuitBreakerService.recordSuccess(accountId);
          await accountRecoveryService.recordAccountSuccess(accountId);
          
          // 在响应中添加accountId和poolId，以便调用方记录账户级别和共享池统计
          response.accountId = accountId;
          response.poolId = poolId;
          return response;
        }
        
        // 其他错误，直接返回
        lastResponse = response;
        break;
        
      } catch (error) {
        logger.error(`❌ Claude relay request failed for key: ${apiKeyData.name || apiKeyData.id}, retry: ${retryCount}:`, error.message);
        lastError = error;
        
        // 记录失败到熔断器和恢复服务（如果有accountId）
        if (accountId) {
          await circuitBreakerService.recordFailure(accountId, error.message);
          await accountRecoveryService.recordAccountFailure(accountId, error);
        }
        
        // 如果还有重试次数，继续下一次重试
        if (retryCount < maxRetries - 1) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 10000);
          logger.info(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
      }
    }
    
    // 所有重试都失败了
    if (lastResponse) {
      logger.error(`❌ All retries exhausted. Final response status: ${lastResponse.statusCode}`);
      return lastResponse;
    } else if (lastError) {
      logger.error(`❌ All retries exhausted. Final error: ${lastError.message}`);
      throw lastError;
    } else {
      throw new Error('Unexpected error: No response or error recorded');
    }
  }

  // 🔄 处理请求体
  _processRequestBody(body, clientHeaders = {}) {
    if (!body) return body;

    // 深拷贝请求体
    const processedBody = JSON.parse(JSON.stringify(body));

    // 验证并限制max_tokens参数
    this._validateAndLimitMaxTokens(processedBody);

    // 移除cache_control中的ttl字段
    this._stripTtlFromCacheControl(processedBody);

    // 判断是否是真实的 Claude Code 请求
    const isRealClaudeCode = this.isRealClaudeCodeRequest(processedBody, clientHeaders);
    
    // 如果不是真实的 Claude Code 请求，需要设置 Claude Code 系统提示词
    if (!isRealClaudeCode) {
      const claudeCodePrompt = {
        type: 'text',
        text: this.claudeCodeSystemPrompt,
        cache_control: {
          type: 'ephemeral'
        }
      };

      if (processedBody.system) {
        if (typeof processedBody.system === 'string') {
          // 字符串格式：转换为数组，Claude Code 提示词在第一位
          const userSystemPrompt = {
            type: 'text',
            text: processedBody.system
          };
          // 如果用户的提示词与 Claude Code 提示词相同，只保留一个
          if (processedBody.system.trim() === this.claudeCodeSystemPrompt) {
            processedBody.system = [claudeCodePrompt];
          } else {
            processedBody.system = [claudeCodePrompt, userSystemPrompt];
          }
        } else if (Array.isArray(processedBody.system)) {
          // 检查第一个元素是否是 Claude Code 系统提示词
          const firstItem = processedBody.system[0];
          const isFirstItemClaudeCode = firstItem && 
                                        firstItem.type === 'text' && 
                                        firstItem.text === this.claudeCodeSystemPrompt;
          
          if (!isFirstItemClaudeCode) {
            // 如果第一个不是 Claude Code 提示词，需要在开头插入
            // 同时检查数组中是否有其他位置包含 Claude Code 提示词，如果有则移除
            const filteredSystem = processedBody.system.filter(item => 
              !(item && item.type === 'text' && item.text === this.claudeCodeSystemPrompt)
            );
            processedBody.system = [claudeCodePrompt, ...filteredSystem];
          }
        } else {
          // 其他格式，记录警告但不抛出错误，尝试处理
          logger.warn('⚠️ Unexpected system field type:', typeof processedBody.system);
          processedBody.system = [claudeCodePrompt];
        }
      } else {
        // 用户没有传递 system，需要添加 Claude Code 提示词
        processedBody.system = [claudeCodePrompt];
      }
    }
    
    // 处理原有的系统提示（如果配置了）
    if (this.systemPrompt && this.systemPrompt.trim()) {
      const systemPrompt = {
        type: 'text',
        text: this.systemPrompt
      };

      // 经过上面的处理，system 现在应该总是数组格式
      if (processedBody.system && Array.isArray(processedBody.system)) {
        // 不要重复添加相同的系统提示
        const hasSystemPrompt = processedBody.system.some(item => 
          item && item.text && item.text === this.systemPrompt
        );
        if (!hasSystemPrompt) {
          processedBody.system.push(systemPrompt);
        }
      } else {
        // 理论上不应该走到这里，但为了安全起见
        processedBody.system = [systemPrompt];
      }
    } else {
      // 如果没有配置系统提示，且system字段为空，则删除它
      if (processedBody.system && Array.isArray(processedBody.system)) {
        const hasValidContent = processedBody.system.some(item => 
          item && item.text && item.text.trim()
        );
        if (!hasValidContent) {
          delete processedBody.system;
        }
      }
    }

    return processedBody;
  }

  // 🔢 验证并限制max_tokens参数
  _validateAndLimitMaxTokens(body) {
    if (!body || !body.max_tokens) return;

    try {
      // 读取模型定价配置文件
      const pricingFilePath = path.join(__dirname, '../../data/model_pricing.json');
      
      if (!fs.existsSync(pricingFilePath)) {
        logger.warn('⚠️ Model pricing file not found, skipping max_tokens validation');
        return;
      }

      const pricingData = JSON.parse(fs.readFileSync(pricingFilePath, 'utf8'));
      const model = body.model || 'claude-sonnet-4-20250514';
      
      // 查找对应模型的配置
      const modelConfig = pricingData[model];
      
      if (!modelConfig) {
        logger.debug(`🔍 Model ${model} not found in pricing file, skipping max_tokens validation`);
        return;
      }

      // 获取模型的最大token限制
      const maxLimit = modelConfig.max_tokens || modelConfig.max_output_tokens;
      
      if (!maxLimit) {
        logger.debug(`🔍 No max_tokens limit found for model ${model}, skipping validation`);
        return;
      }

      // 检查并调整max_tokens
      if (body.max_tokens > maxLimit) {
        logger.warn(`⚠️ max_tokens ${body.max_tokens} exceeds limit ${maxLimit} for model ${model}, adjusting to ${maxLimit}`);
        body.max_tokens = maxLimit;
      }
    } catch (error) {
      logger.error('❌ Failed to validate max_tokens from pricing file:', error);
      // 如果文件读取失败，不进行校验，让请求继续处理
    }
  }

  // 🧹 移除TTL字段
  _stripTtlFromCacheControl(body) {
    if (!body || typeof body !== 'object') return;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;
      
      contentArray.forEach(item => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl;
            logger.debug('🧹 Removed ttl from cache_control');
          }
        }
      });
    };

    if (Array.isArray(body.system)) {
      processContentArray(body.system);
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }
  }

  // 🌐 获取代理Agent
  async _getProxyAgent(accountId) {
    try {
      const accountData = await claudeAccountService.getAllAccounts();
      const account = accountData.find(acc => acc.id === accountId);
      
      if (!account || !account.proxy) {
        return null;
      }

      const proxy = account.proxy;
      
      if (proxy.type === 'socks5') {
        const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
        const socksUrl = `socks5://${auth}${proxy.host}:${proxy.port}`;
        return new SocksProxyAgent(socksUrl);
      } else if (proxy.type === 'http' || proxy.type === 'https') {
        const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
        const httpUrl = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
        return new HttpsProxyAgent(httpUrl);
      }
    } catch (error) {
      logger.warn('⚠️ Failed to create proxy agent:', error);
    }

    return null;
  }

  // 🔧 过滤客户端请求头
  _filterClientHeaders(clientHeaders) {
    // 需要移除的敏感 headers
    const sensitiveHeaders = [
      'x-api-key',
      'authorization',
      'host',
      'content-length',
      'connection',
      'proxy-authorization',
      'content-encoding',
      'transfer-encoding'
    ];
    
    // 应该保留的 headers（用于会话一致性和追踪）
    const allowedHeaders = [
      'x-request-id'
    ];
    
    const filteredHeaders = {};
    
    // 转发客户端的非敏感 headers
    Object.keys(clientHeaders || {}).forEach(key => {
      const lowerKey = key.toLowerCase();
      // 如果在允许列表中，直接保留
      if (allowedHeaders.includes(lowerKey)) {
        filteredHeaders[key] = clientHeaders[key];
      } 
      // 如果不在敏感列表中，也保留
      else if (!sensitiveHeaders.includes(lowerKey)) {
        filteredHeaders[key] = clientHeaders[key];
      }
    });
    
    return filteredHeaders;
  }

  // 🔗 发送请求到Claude API
  async _makeClaudeRequest(body, accessToken, proxyAgent, clientHeaders, accountId, onRequest, requestOptions = {}) {
    const url = new URL(this.claudeApiUrl);
    
    // 获取过滤后的客户端 headers
    const filteredHeaders = this._filterClientHeaders(clientHeaders);
    
    // 判断是否是真实的 Claude Code 请求
    const isRealClaudeCode = this.isRealClaudeCodeRequest(body, clientHeaders);
    
    // 如果不是真实的 Claude Code 请求，需要使用从账户获取的 Claude Code headers
    let finalHeaders = { ...filteredHeaders };
    
    if (!isRealClaudeCode) {
      // 获取该账号存储的 Claude Code headers
      const claudeCodeHeaders = await claudeCodeHeadersService.getAccountHeaders(accountId);
      
      // 只添加客户端没有提供的 headers
      Object.keys(claudeCodeHeaders).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (!finalHeaders[key] && !finalHeaders[lowerKey]) {
          finalHeaders[key] = claudeCodeHeaders[key];
        }
      });
    }
    
    return new Promise((resolve, reject) => {
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          ...finalHeaders
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      };
      
      // 如果客户端没有提供 User-Agent，使用默认值
      if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
        options.headers['User-Agent'] = 'claude-cli/1.0.57 (external, cli)';
      }

      // 使用自定义的 betaHeader 或默认值
      const betaHeader = requestOptions?.betaHeader !== undefined ? requestOptions.betaHeader : this.betaHeader;
      if (betaHeader) {
        options.headers['anthropic-beta'] = betaHeader;
      }

      const req = https.request(options, (res) => {
        let responseData = Buffer.alloc(0);
        
        res.on('data', (chunk) => {
          responseData = Buffer.concat([responseData, chunk]);
        });
        
        res.on('end', () => {
          try {
            let bodyString = '';
            
            // 根据Content-Encoding处理响应数据
            const contentEncoding = res.headers['content-encoding'];
            if (contentEncoding === 'gzip') {
              try {
                bodyString = zlib.gunzipSync(responseData).toString('utf8');
              } catch (unzipError) {
                logger.error('❌ Failed to decompress gzip response:', unzipError);
                bodyString = responseData.toString('utf8');
              }
            } else if (contentEncoding === 'deflate') {
              try {
                bodyString = zlib.inflateSync(responseData).toString('utf8');
              } catch (unzipError) {
                logger.error('❌ Failed to decompress deflate response:', unzipError);
                bodyString = responseData.toString('utf8');
              }
            } else {
              bodyString = responseData.toString('utf8');
            }
            
            const response = {
              statusCode: res.statusCode,
              headers: res.headers,
              body: bodyString
            };
            
            logger.debug(`🔗 Claude API response: ${res.statusCode}`);
            
            resolve(response);
          } catch (error) {
            logger.error('❌ Failed to parse Claude API response:', error);
            reject(error);
          }
        });
      });
      
      // 如果提供了 onRequest 回调，传递请求对象
      if (onRequest && typeof onRequest === 'function') {
        onRequest(req);
      }

      req.on('error', (error) => {
        logger.error('❌ Claude API request error:', error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall,
          address: error.address,
          port: error.port
        });
        
        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed';
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server';
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname';
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server';
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server';
        }
        
        reject(new Error(errorMessage));
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('❌ Claude API request timeout');
        reject(new Error('Request timeout'));
      });

      // 写入请求体
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 🌊 处理流式响应（带usage数据捕获）
  async relayStreamRequestWithUsageCapture(requestBody, apiKeyData, responseStream, clientHeaders, usageCallback, streamTransformer = null, options = {}) {
    try {
      // 调试日志：查看API Key数据（流式请求）
      logger.info('🔍 [Stream] API Key data received:', {
        apiKeyName: apiKeyData.name,
        enableModelRestriction: apiKeyData.enableModelRestriction,
        restrictedModels: apiKeyData.restrictedModels,
        requestedModel: requestBody.model
      });

      // 检查模型限制
      if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels && apiKeyData.restrictedModels.length > 0) {
        const requestedModel = requestBody.model;
        logger.info(`🔒 [Stream] Model restriction check - Requested model: ${requestedModel}, Restricted models: ${JSON.stringify(apiKeyData.restrictedModels)}`);
        
        if (requestedModel && apiKeyData.restrictedModels.includes(requestedModel)) {
          logger.warn(`🚫 Model restriction violation for key ${apiKeyData.name}: Attempted to use restricted model ${requestedModel}`);
          
          // 对于流式响应，需要写入错误并结束流
          const errorResponse = JSON.stringify({
            error: {
              type: 'forbidden',
              message: '暂无该模型访问权限'
            }
          });
          
          responseStream.writeHead(403, { 'Content-Type': 'application/json' });
          responseStream.end(errorResponse);
          return;
        }
      }
      
      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(requestBody);
      
      // 选择可用的Claude账户（支持专属绑定和sticky会话）
      const selection = await claudeAccountService.selectAccountForApiKey(apiKeyData, sessionHash);
      const accountId = selection.accountId;
      const poolId = selection.poolId;
      
      // 检查熔断器状态
      const circuitCheck = await circuitBreakerService.canRequest(accountId);
      if (!circuitCheck.allowed) {
        logger.warn(`🚫 [Stream] Circuit breaker OPEN for account ${accountId}, state: ${circuitCheck.state}`);
        
        // 对于流式响应，需要写入错误并结束流
        const errorResponse = JSON.stringify({
          error: {
            type: 'service_unavailable',
            message: 'Service temporarily unavailable. Please try again later.'
          }
        });
        
        responseStream.writeHead(503, { 'Content-Type': 'application/json' });
        responseStream.end(errorResponse);
        return;
      }
      
      logger.info(`📡 Processing streaming API request with usage capture for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId}${sessionHash ? `, session: ${sessionHash}` : ''}`);
      
      // 获取有效的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId);
      
      // 处理请求体（传递 clientHeaders 以判断是否需要设置 Claude Code 系统提示词）
      const processedBody = this._processRequestBody(requestBody, clientHeaders);
      
      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId);
      
      // 发送流式请求并捕获usage数据
      return await this._makeClaudeStreamRequestWithUsageCapture(processedBody, accessToken, proxyAgent, clientHeaders, responseStream, (usageData) => {
        // 在usageCallback中添加accountId和poolId
        usageCallback({ ...usageData, accountId, poolId });
      }, accountId, sessionHash, streamTransformer, options);
    } catch (error) {
      logger.error('❌ Claude stream relay with usage capture failed:', error);
      throw error;
    }
  }

  // 🌊 发送流式请求到Claude API（带usage数据捕获）
  async _makeClaudeStreamRequestWithUsageCapture(body, accessToken, proxyAgent, clientHeaders, responseStream, usageCallback, accountId, sessionHash, streamTransformer = null, requestOptions = {}) {
    // 获取过滤后的客户端 headers
    const filteredHeaders = this._filterClientHeaders(clientHeaders);
    
    // 判断是否是真实的 Claude Code 请求
    const isRealClaudeCode = this.isRealClaudeCodeRequest(body, clientHeaders);
    
    // 如果不是真实的 Claude Code 请求，需要使用从账户获取的 Claude Code headers
    let finalHeaders = { ...filteredHeaders };
    
    if (!isRealClaudeCode) {
      // 获取该账号存储的 Claude Code headers
      const claudeCodeHeaders = await claudeCodeHeadersService.getAccountHeaders(accountId);
      
      // 只添加客户端没有提供的 headers
      Object.keys(claudeCodeHeaders).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (!finalHeaders[key] && !finalHeaders[lowerKey]) {
          finalHeaders[key] = claudeCodeHeaders[key];
        }
      });
    }
    
    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          ...finalHeaders
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      };
      
      // 如果客户端没有提供 User-Agent，使用默认值
      if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
        options.headers['User-Agent'] = 'claude-cli/1.0.57 (external, cli)';
      }

      // 使用自定义的 betaHeader 或默认值
      const betaHeader = requestOptions?.betaHeader !== undefined ? requestOptions.betaHeader : this.betaHeader;
      if (betaHeader) {
        options.headers['anthropic-beta'] = betaHeader;
      }

      const req = https.request(options, (res) => {
        logger.debug(`🌊 Claude stream response status: ${res.statusCode}`);

        // 错误响应处理
        if (res.statusCode !== 200) {
          logger.error(`❌ Claude API returned error status: ${res.statusCode}`);
          // 记录失败到熔断器和恢复服务
          circuitBreakerService.recordFailure(accountId, `HTTP ${res.statusCode}`).catch(() => {});
          accountRecoveryService.recordAccountFailure(accountId, new Error(`HTTP ${res.statusCode}`)).catch(() => {});
          
          let errorData = '';
          
          res.on('data', (chunk) => {
            errorData += chunk.toString();
          });
          
          res.on('end', () => {
            logger.error('❌ Claude API error response:', errorData);
            if (!responseStream.destroyed) {
              // 发送错误事件
              responseStream.write('event: error\n');
              responseStream.write(`data: ${JSON.stringify({ 
                error: 'Claude API error',
                status: res.statusCode,
                details: errorData,
                timestamp: new Date().toISOString()
              })}\n\n`);
              responseStream.end();
            }
            reject(new Error(`Claude API error: ${res.statusCode}`));
          });
          return;
        }

        let buffer = '';
        let finalUsageReported = false; // 防止重复统计的标志
        let collectedUsageData = {}; // 收集来自不同事件的usage数据
        let rateLimitDetected = false; // 限流检测标志
        
        // 监听数据块，解析SSE并寻找usage信息
        res.on('data', (chunk) => {
          try {
            const chunkStr = chunk.toString();
            
            buffer += chunkStr;
            
            // 处理完整的SSE行
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // 保留最后的不完整行
            
            // 转发已处理的完整行到客户端
            if (lines.length > 0 && !responseStream.destroyed) {
              const linesToForward = lines.join('\n') + (lines.length > 0 ? '\n' : '');
              // 如果有流转换器，应用转换
              if (streamTransformer) {
                const transformed = streamTransformer(linesToForward);
                if (transformed) {
                  responseStream.write(transformed);
                }
              } else {
                responseStream.write(linesToForward);
              }
            }
          
          for (const line of lines) {
            // 解析SSE数据寻找usage信息
            if (line.startsWith('data: ') && line.length > 6) {
              try {
                const jsonStr = line.slice(6);
                const data = JSON.parse(jsonStr);
                
                // 收集来自不同事件的usage数据
                if (data.type === 'message_start' && data.message && data.message.usage) {
                  // message_start包含input tokens、cache tokens和模型信息
                  collectedUsageData.input_tokens = data.message.usage.input_tokens || 0;
                  collectedUsageData.cache_creation_input_tokens = data.message.usage.cache_creation_input_tokens || 0;
                  collectedUsageData.cache_read_input_tokens = data.message.usage.cache_read_input_tokens || 0;
                  collectedUsageData.model = data.message.model;
                  
                  logger.info('📊 Collected input/cache data from message_start:', JSON.stringify(collectedUsageData));
                }
                
                // message_delta包含最终的output tokens
                if (data.type === 'message_delta' && data.usage && data.usage.output_tokens !== undefined) {
                  collectedUsageData.output_tokens = data.usage.output_tokens || 0;
                  
                  logger.info('📊 Collected output data from message_delta:', JSON.stringify(collectedUsageData));
                  
                  // 如果已经收集到了input数据，现在有了output数据，可以统计了
                  if (collectedUsageData.input_tokens !== undefined && !finalUsageReported) {
                    logger.info('🎯 Complete usage data collected, triggering callback');
                    usageCallback(collectedUsageData);
                    finalUsageReported = true;
                  }
                }
                
                // 检查是否有错误
                if (data.type === 'error' && data.error && data.error.message) {
                  const errorMessage = data.error.message.toLowerCase();
                  const errorType = data.error.type;
                  
                  // 检查是否有限流错误
                  if (errorMessage.includes('exceed your account\'s rate limit')) {
                    rateLimitDetected = true;
                    logger.warn(`🚫 Rate limit detected in stream for account ${accountId}`);
                  }
                  // 检查是否是OAuth token被撤销的错误
                  else if (errorMessage.includes('oauth token revoked') || 
                           errorMessage.includes('please run /login') ||
                           (errorMessage.includes('authentication_error') && !errorMessage.includes('OAuth authentication is currently not supported'))) {
                    logger.warn(`🔐 OAuth token revoked detected in stream for account ${accountId}`);
                    // 标记账号为不活跃
                    claudeAccountService.markAccountOAuthRevoked(accountId, 'OAuth token revoked in stream').catch(err => {
                      logger.error(`❌ Failed to mark account as OAuth revoked: ${err.message}`);
                    });
                    // 记录失败到熔断器和恢复服务
                    circuitBreakerService.recordFailure(accountId, 'OAuth token revoked').catch(() => {});
                    accountRecoveryService.recordAccountFailure(accountId, new Error('OAuth token revoked')).catch(() => {});
                  }
                  // 检查是否是组织被禁用
                  else if (errorType === 'invalid_request_error' && 
                           errorMessage.includes('this organization has been disabled')) {
                    logger.error(`🚫 Account ${accountId} has been banned (organization disabled) - detected in stream`);
                    // 标记账号为被封禁
                    claudeAccountService.updateAccount(accountId, {
                      status: 'banned',
                      errorMessage: 'Organization has been disabled',
                      isActive: false
                    }).catch(err => {
                      logger.error(`❌ Failed to mark account as banned: ${err.message}`);
                    });
                    // 记录失败到熔断器和恢复服务
                    circuitBreakerService.recordFailure(accountId, 'Organization disabled').catch(() => {});
                    accountRecoveryService.recordAccountFailure(accountId, new Error('Organization disabled')).catch(() => {});
                  }
                }
                
              } catch (parseError) {
                // 忽略JSON解析错误，继续处理
                logger.debug('🔍 SSE line not JSON or no usage data:', line.slice(0, 100));
              }
            }
          }
          } catch (error) {
            logger.error('❌ Error processing stream data:', error);
            // 发送错误但不破坏流，让它自然结束
            if (!responseStream.destroyed) {
              responseStream.write('event: error\n');
              responseStream.write(`data: ${JSON.stringify({ 
                error: 'Stream processing error',
                message: error.message,
                timestamp: new Date().toISOString()
              })}\n\n`);
            }
          }
        });
        
        res.on('end', async () => {
          try {
            // 处理缓冲区中剩余的数据
            if (buffer.trim() && !responseStream.destroyed) {
              if (streamTransformer) {
                const transformed = streamTransformer(buffer);
                if (transformed) {
                  responseStream.write(transformed);
                }
              } else {
                responseStream.write(buffer);
              }
            }
            
            // 确保流正确结束
            if (!responseStream.destroyed) {
              responseStream.end();
            }
          } catch (error) {
            logger.error('❌ Error processing stream end:', error);
          }
          
          // 检查是否捕获到usage数据
          if (!finalUsageReported) {
            logger.warn('⚠️ Stream completed but no usage data was captured! This indicates a problem with SSE parsing or Claude API response format.');
          }
          
          // 处理限流状态
          if (rateLimitDetected || res.statusCode === 429) {
            // 标记账号为限流状态并删除粘性会话映射
            await claudeAccountService.markAccountRateLimited(accountId, sessionHash);
            // 记录失败到熔断器和恢复服务
            await circuitBreakerService.recordFailure(accountId, 'Rate limit in stream');
            await accountRecoveryService.recordAccountFailure(accountId, new Error('Rate limit in stream'));
          } else if (res.statusCode === 200) {
            // 如果请求成功，检查并移除限流状态
            const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId);
            if (isRateLimited) {
              await claudeAccountService.removeAccountRateLimit(accountId);
            }
            
            // 记录成功到熔断器和恢复服务
            await circuitBreakerService.recordSuccess(accountId);
            await accountRecoveryService.recordAccountSuccess(accountId);
            
            // 只有真实的 Claude Code 请求才更新 headers（流式请求）
            if (clientHeaders && Object.keys(clientHeaders).length > 0 && this.isRealClaudeCodeRequest(body, clientHeaders)) {
              await claudeCodeHeadersService.storeAccountHeaders(accountId, clientHeaders);
            }
          }
          
          logger.debug('🌊 Claude stream response with usage capture completed');
          resolve();
        });
      });

      req.on('error', (error) => {
        logger.error('❌ Claude stream request error:', error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall
        });
        
        // 记录失败到熔断器和恢复服务
        circuitBreakerService.recordFailure(accountId, error.message).catch(() => {});
        accountRecoveryService.recordAccountFailure(accountId, error).catch(() => {});
        
        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed';
        let statusCode = 500;
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server';
          statusCode = 502;
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname';
          statusCode = 502;
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server';
          statusCode = 502;
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server';
          statusCode = 504;
        }
        
        if (!responseStream.headersSent) {
          responseStream.writeHead(statusCode, { 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
        }
        
        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n');
          responseStream.write(`data: ${JSON.stringify({ 
            error: errorMessage,
            code: error.code,
            timestamp: new Date().toISOString()
          })}\n\n`);
          responseStream.end();
        }
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('❌ Claude stream request timeout');
        
        // 记录失败到熔断器和恢复服务
        circuitBreakerService.recordFailure(accountId, 'Request timeout').catch(() => {});
        accountRecoveryService.recordAccountFailure(accountId, new Error('Request timeout')).catch(() => {});
        if (!responseStream.headersSent) {
          responseStream.writeHead(504, { 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
        }
        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n');
          responseStream.write(`data: ${JSON.stringify({ 
            error: 'Request timeout',
            code: 'TIMEOUT',
            timestamp: new Date().toISOString()
          })}\n\n`);
          responseStream.end();
        }
        reject(new Error('Request timeout'));
      });

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up stream');
        if (!req.destroyed) {
          req.destroy();
        }
      });

      // 写入请求体
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 🌊 发送流式请求到Claude API
  async _makeClaudeStreamRequest(body, accessToken, proxyAgent, clientHeaders, responseStream, requestOptions = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl);
      
      // 获取过滤后的客户端 headers
      const filteredHeaders = this._filterClientHeaders(clientHeaders);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          ...filteredHeaders
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      };
      
      // 如果客户端没有提供 User-Agent，使用默认值
      if (!filteredHeaders['User-Agent'] && !filteredHeaders['user-agent']) {
        options.headers['User-Agent'] = 'claude-cli/1.0.53 (external, cli)';
      }

      // 使用自定义的 betaHeader 或默认值
      const betaHeader = requestOptions?.betaHeader !== undefined ? requestOptions.betaHeader : this.betaHeader;
      if (betaHeader) {
        options.headers['anthropic-beta'] = betaHeader;
      }

      const req = https.request(options, (res) => {
        // 设置响应头
        responseStream.statusCode = res.statusCode;
        Object.keys(res.headers).forEach(key => {
          responseStream.setHeader(key, res.headers[key]);
        });

        // 管道响应数据
        res.pipe(responseStream);
        
        res.on('end', () => {
          logger.debug('🌊 Claude stream response completed');
          resolve();
        });
      });

      req.on('error', (error) => {
        logger.error('❌ Claude stream request error:', error.message, {
          code: error.code,
          errno: error.errno,
          syscall: error.syscall
        });
        
        // 根据错误类型提供更具体的错误信息
        let errorMessage = 'Upstream request failed';
        let statusCode = 500;
        if (error.code === 'ECONNRESET') {
          errorMessage = 'Connection reset by Claude API server';
          statusCode = 502;
        } else if (error.code === 'ENOTFOUND') {
          errorMessage = 'Unable to resolve Claude API hostname';
          statusCode = 502;
        } else if (error.code === 'ECONNREFUSED') {
          errorMessage = 'Connection refused by Claude API server';
          statusCode = 502;
        } else if (error.code === 'ETIMEDOUT') {
          errorMessage = 'Connection timed out to Claude API server';
          statusCode = 504;
        }
        
        if (!responseStream.headersSent) {
          responseStream.writeHead(statusCode, { 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
        }
        
        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n');
          responseStream.write(`data: ${JSON.stringify({ 
            error: errorMessage,
            code: error.code,
            timestamp: new Date().toISOString()
          })}\n\n`);
          responseStream.end();
        }
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('❌ Claude stream request timeout');
        
        // 记录失败到熔断器和恢复服务
        circuitBreakerService.recordFailure(accountId, 'Request timeout').catch(() => {});
        accountRecoveryService.recordAccountFailure(accountId, new Error('Request timeout')).catch(() => {});
        if (!responseStream.headersSent) {
          responseStream.writeHead(504, { 
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
          });
        }
        if (!responseStream.destroyed) {
          // 发送 SSE 错误事件
          responseStream.write('event: error\n');
          responseStream.write(`data: ${JSON.stringify({ 
            error: 'Request timeout',
            code: 'TIMEOUT',
            timestamp: new Date().toISOString()
          })}\n\n`);
          responseStream.end();
        }
        reject(new Error('Request timeout'));
      });

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up stream');
        if (!req.destroyed) {
          req.destroy();
        }
      });

      // 写入请求体
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 🔄 重试逻辑
  async _retryRequest(requestFunc, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await requestFunc();
      } catch (error) {
        lastError = error;
        
        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000; // 指数退避
          logger.warn(`⏳ Retry ${i + 1}/${maxRetries} in ${delay}ms: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  // 🎯 健康检查
  async healthCheck() {
    try {
      const accounts = await claudeAccountService.getAllAccounts();
      const activeAccounts = accounts.filter(acc => acc.isActive && acc.status === 'active');
      
      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('❌ Health check failed:', error);
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  // 🏥 测试账户健康状态
  async testAccountHealth(accountId) {
    try {
      // 获取账户的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId);
      
      if (!accessToken) {
        return {
          success: false,
          error: 'No valid access token'
        };
      }

      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId);
      
      // 构建一个最小的测试请求
      const testBody = {
        model: 'claude-sonnet-4-20250514',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false,
        // 添加 Claude Code 系统提示词，模拟真实的 Claude Code 请求
        system: [{
          type: 'text',
          text: this.claudeCodeSystemPrompt
        }]
      };

      // 发送测试请求
      try {
        // 模拟 Claude Code 的 headers
        const testHeaders = {
          'user-agent': 'claude-cli/1.0.57 (external, cli)'
        };
        
        const response = await this._makeClaudeRequest(
          testBody, 
          accessToken, 
          proxyAgent,
          testHeaders, // 使用模拟的headers
          accountId,
          null, // 不需要请求回调
          { betaHeader: '' } // 不使用beta header
        );
        
        // 检查响应状态
        if (response.statusCode === 200 || response.statusCode === 201) {
          return {
            success: true,
            statusCode: response.statusCode
          };
        } else {
          // 解析错误信息
          let errorMessage = `HTTP ${response.statusCode}`;
          let isOrganizationDisabled = false;
          let isOAuthNotSupported = false;
          
          try {
            const responseBody = typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
            if (responseBody && responseBody.error && responseBody.error.message) {
              errorMessage = responseBody.error.message;
              
              // 检查是否是组织被禁用的错误
              if (responseBody.error.type === 'invalid_request_error' && 
                  errorMessage.includes('This organization has been disabled')) {
                isOrganizationDisabled = true;
                errorMessage = '账号已被封禁 (Organization disabled)';
              }
              // 检查是否是OAuth不支持的错误
              else if (errorMessage.includes('OAuth authentication is currently not supported')) {
                isOAuthNotSupported = true;
                errorMessage = '该账户不支持OAuth认证';
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
          
          // 如果是账号被封禁，更新账户状态
          if (isOrganizationDisabled) {
            logger.error(`🚫 Account ${accountId} has been banned (organization disabled)`);
            await claudeAccountService.updateAccount(accountId, {
              status: 'banned',
              errorMessage: 'Organization has been disabled',
              isActive: false
            });
          }
          
          return {
            success: false,
            error: errorMessage,
            statusCode: response.statusCode,
            isBanned: isOrganizationDisabled,
            isOAuthNotSupported: isOAuthNotSupported
          };
        }
      } catch (requestError) {
        return {
          success: false,
          error: requestError.message
        };
      }
    } catch (error) {
      logger.error(`❌ Account health test failed for ${accountId}:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new ClaudeRelayService();