const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const axios = require('axios');
const redis = require('../models/redis');
const logger = require('../utils/logger');
const config = require('../../config/config');
const { maskToken } = require('../utils/tokenMask');
const {
  logRefreshStart,
  logRefreshSuccess,
  logRefreshError,
  logTokenUsage,
  logRefreshSkipped
} = require('../utils/tokenRefreshLogger');
const tokenRefreshService = require('./tokenRefreshService');

class ClaudeAccountService {
  constructor() {
    this.claudeApiUrl = 'https://console.anthropic.com/v1/oauth/token';
    this.claudeOauthClientId = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
    
    // 加密相关常量
    this.ENCRYPTION_ALGORITHM = 'aes-256-cbc';
    this.ENCRYPTION_SALT = 'salt';
  }

  // 🏢 创建Claude账户
  async createAccount(options = {}) {
    const {
      name = 'Unnamed Account',
      description = '',
      email = '',
      password = '',
      refreshToken = '',
      claudeAiOauth = null, // Claude标准格式的OAuth数据
      proxy = null, // { type: 'socks5', host: 'localhost', port: 1080, username: '', password: '' }
      isActive = true,
      accountType = 'shared' // 'dedicated' or 'shared'
    } = options;

    const accountId = uuidv4();
    
    let accountData;
    
    if (claudeAiOauth) {
      // 使用Claude标准格式的OAuth数据
      // 支持下划线和驼峰两种格式
      const accessToken = claudeAiOauth.access_token || claudeAiOauth.accessToken || '';
      const refreshToken = claudeAiOauth.refresh_token || claudeAiOauth.refreshToken || '';
      const expiresIn = claudeAiOauth.expires_in || claudeAiOauth.expiresIn || 3600;
      const expiresAt = claudeAiOauth.expires_at || claudeAiOauth.expiresAt || 
        new Date(Date.now() + expiresIn * 1000).toISOString();
      const scopes = claudeAiOauth.scope || claudeAiOauth.scopes || '';
      const scopesString = Array.isArray(scopes) ? scopes.join(' ') : scopes;
      
      accountData = {
        id: accountId,
        name,
        description,
        email: this._encryptSensitiveData(email),
        password: this._encryptSensitiveData(password),
        claudeAiOauth: this._encryptSensitiveData(JSON.stringify(claudeAiOauth)),
        accessToken: this._encryptSensitiveData(accessToken),
        refreshToken: this._encryptSensitiveData(refreshToken),
        expiresAt: new Date(expiresAt).toISOString(),
        scopes: scopesString,
        proxy: proxy ? JSON.stringify(proxy) : '',
        isActive: isActive.toString(),
        accountType: accountType, // 账号类型：'dedicated' 或 'shared'
        createdAt: new Date().toISOString(),
        lastUsedAt: '',
        lastRefreshAt: '',
        status: 'active', // 有OAuth数据的账户直接设为active
        errorMessage: ''
      };
    } else {
      // 兼容旧格式
      accountData = {
        id: accountId,
        name,
        description,
        email: this._encryptSensitiveData(email),
        password: this._encryptSensitiveData(password),
        refreshToken: this._encryptSensitiveData(refreshToken),
        accessToken: '',
        expiresAt: '',
        scopes: '',
        proxy: proxy ? JSON.stringify(proxy) : '',
        isActive: isActive.toString(),
        accountType: accountType, // 账号类型：'dedicated' 或 'shared'
        createdAt: new Date().toISOString(),
        lastUsedAt: '',
        lastRefreshAt: '',
        status: 'created', // created, active, expired, error
        errorMessage: ''
      };
    }

    await redis.setClaudeAccount(accountId, accountData);
    
    logger.success(`🏢 Created Claude account: ${name} (${accountId})`);
    
    return {
      id: accountId,
      name,
      description,
      email,
      isActive,
      proxy,
      accountType,
      status: accountData.status,
      createdAt: accountData.createdAt,
      expiresAt: accountData.expiresAt,
      scopes: claudeAiOauth ? claudeAiOauth.scopes : []
    };
  }

  // 🔄 刷新Claude账户token
  async refreshAccountToken(accountId) {
    let lockAcquired = false;
    
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      const refreshToken = this._decryptSensitiveData(accountData.refreshToken);
      
      if (!refreshToken) {
        throw new Error('No refresh token available - manual token update required');
      }

      // 尝试获取分布式锁
      lockAcquired = await tokenRefreshService.acquireRefreshLock(accountId, 'claude');
      
      if (!lockAcquired) {
        // 如果无法获取锁，说明另一个进程正在刷新
        logger.info(`🔒 Token refresh already in progress for account: ${accountData.name} (${accountId})`);
        logRefreshSkipped(accountId, accountData.name, 'claude', 'already_locked');
        
        // 等待一段时间后返回，期望其他进程已完成刷新
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // 重新获取账户数据（可能已被其他进程刷新）
        const updatedData = await redis.getClaudeAccount(accountId);
        if (updatedData && updatedData.accessToken) {
          const accessToken = this._decryptSensitiveData(updatedData.accessToken);
          return {
            success: true,
            accessToken: accessToken,
            expiresAt: updatedData.expiresAt
          };
        }
        
        throw new Error('Token refresh in progress by another process');
      }

      // 记录开始刷新
      logRefreshStart(accountId, accountData.name, 'claude', 'manual_refresh');
      logger.info(`🔄 Starting token refresh for account: ${accountData.name} (${accountId})`);

      // 创建代理agent
      const agent = this._createProxyAgent(accountData.proxy);

      const response = await axios.post(this.claudeApiUrl, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.claudeOauthClientId
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'claude-cli/1.0.56 (external, cli)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://claude.ai/',
          'Origin': 'https://claude.ai'
        },
        httpsAgent: agent,
        timeout: 30000
      });

      if (response.status === 200) {
        const { access_token, refresh_token, expires_in } = response.data;
        
        // 更新账户数据
        accountData.accessToken = this._encryptSensitiveData(access_token);
        accountData.refreshToken = this._encryptSensitiveData(refresh_token);
        accountData.expiresAt = (Date.now() + (expires_in * 1000)).toString();
        accountData.lastRefreshAt = new Date().toISOString();
        accountData.status = 'active';
        accountData.errorMessage = '';

        await redis.setClaudeAccount(accountId, accountData);
        
        // 记录刷新成功
        logRefreshSuccess(accountId, accountData.name, 'claude', {
          accessToken: access_token,
          refreshToken: refresh_token,
          expiresAt: accountData.expiresAt,
          scopes: accountData.scopes
        });
        
        logger.success(`🔄 Refreshed token for account: ${accountData.name} (${accountId}) - Access Token: ${maskToken(access_token)}`);
        
        return {
          success: true,
          accessToken: access_token,
          expiresAt: accountData.expiresAt
        };
      } else {
        throw new Error(`Token refresh failed with status: ${response.status}`);
      }
    } catch (error) {
      // 记录刷新失败
      const accountData = await redis.getClaudeAccount(accountId);
      if (accountData) {
        logRefreshError(accountId, accountData.name, 'claude', error);
        accountData.status = 'error';
        accountData.errorMessage = error.message;
        await redis.setClaudeAccount(accountId, accountData);
      }
      
      logger.error(`❌ Failed to refresh token for account ${accountId}:`, error);
      
      throw error;
    } finally {
      // 释放锁
      if (lockAcquired) {
        await tokenRefreshService.releaseRefreshLock(accountId, 'claude');
      }
    }
  }

  // 🎯 获取有效的访问token
  async getValidAccessToken(accountId) {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      if (accountData.isActive !== 'true') {
        throw new Error('Account is disabled');
      }

      // 检查token是否过期
      const expiresAt = parseInt(accountData.expiresAt);
      const now = Date.now();
      const isExpired = !expiresAt || now >= (expiresAt - 60000); // 60秒提前刷新
      
      // 记录token使用情况
      logTokenUsage(accountId, accountData.name, 'claude', accountData.expiresAt, isExpired);
      
      if (isExpired) {
        logger.info(`🔄 Token expired/expiring for account ${accountId}, attempting refresh...`);
        try {
          const refreshResult = await this.refreshAccountToken(accountId);
          return refreshResult.accessToken;
        } catch (refreshError) {
          logger.warn(`⚠️ Token refresh failed for account ${accountId}: ${refreshError.message}`);
          // 如果刷新失败，仍然尝试使用当前token（可能是手动添加的长期有效token）
          const currentToken = this._decryptSensitiveData(accountData.accessToken);
          if (currentToken) {
            logger.info(`🔄 Using current token for account ${accountId} (refresh failed)`);
            return currentToken;
          }
          throw refreshError;
        }
      }

      const accessToken = this._decryptSensitiveData(accountData.accessToken);
      
      if (!accessToken) {
        throw new Error('No access token available');
      }

      // 更新最后使用时间
      accountData.lastUsedAt = new Date().toISOString();
      await redis.setClaudeAccount(accountId, accountData);

      return accessToken;
    } catch (error) {
      logger.error(`❌ Failed to get valid access token for account ${accountId}:`, error);
      throw error;
    }
  }

  // 📋 获取所有Claude账户
  async getAllAccounts() {
    try {
      const accounts = await redis.getAllClaudeAccounts();
      
      // 处理返回数据，移除敏感信息并添加限流状态
      const processedAccounts = await Promise.all(accounts.map(async account => {
        // 获取限流状态信息
        const rateLimitInfo = await this.getAccountRateLimitInfo(account.id);
        
        return {
          id: account.id,
          name: account.name,
          description: account.description,
          email: account.email ? this._maskEmail(this._decryptSensitiveData(account.email)) : '',
          isActive: account.isActive === 'true',
          proxy: account.proxy ? JSON.parse(account.proxy) : null,
          status: account.status,
          errorMessage: account.errorMessage,
          accountType: account.accountType || 'shared', // 兼容旧数据，默认为共享
          createdAt: account.createdAt,
          lastUsedAt: account.lastUsedAt,
          lastRefreshAt: account.lastRefreshAt,
          expiresAt: account.expiresAt,
          // 添加限流状态信息
          rateLimitStatus: rateLimitInfo ? {
            isRateLimited: rateLimitInfo.isRateLimited,
            rateLimitedAt: rateLimitInfo.rateLimitedAt,
            minutesRemaining: rateLimitInfo.minutesRemaining
          } : null
        };
      }));
      
      return processedAccounts;
    } catch (error) {
      logger.error('❌ Failed to get Claude accounts:', error);
      throw error;
    }
  }

  // 📝 更新Claude账户
  async updateAccount(accountId, updates) {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      const allowedUpdates = ['name', 'description', 'email', 'password', 'refreshToken', 'proxy', 'isActive', 'claudeAiOauth', 'accountType'];
      const updatedData = { ...accountData };

      // 检查是否新增了 refresh token
      const oldRefreshToken = this._decryptSensitiveData(accountData.refreshToken);
      
      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          if (['email', 'password', 'refreshToken'].includes(field)) {
            updatedData[field] = this._encryptSensitiveData(value);
          } else if (field === 'proxy') {
            updatedData[field] = value ? JSON.stringify(value) : '';
          } else if (field === 'claudeAiOauth') {
            // 更新 Claude AI OAuth 数据
            if (value) {
              updatedData.claudeAiOauth = this._encryptSensitiveData(JSON.stringify(value));
              
              // 安全地更新各个字段，检查是否存在
              if (value.accessToken || value.access_token) {
                updatedData.accessToken = this._encryptSensitiveData(value.accessToken || value.access_token);
              }
              
              if (value.refreshToken || value.refresh_token) {
                updatedData.refreshToken = this._encryptSensitiveData(value.refreshToken || value.refresh_token);
              }
              
              // 处理 expiresAt 字段（可能是多种格式）
              if (value.expiresAt || value.expires_at) {
                updatedData.expiresAt = (value.expiresAt || value.expires_at).toString();
              } else if (value.expires_in) {
                // 如果只有 expires_in，计算 expiresAt
                updatedData.expiresAt = (Date.now() + value.expires_in * 1000).toString();
              }
              
              // 处理 scopes 字段
              if (value.scopes) {
                updatedData.scopes = Array.isArray(value.scopes) ? value.scopes.join(' ') : value.scopes;
              } else if (value.scope) {
                updatedData.scopes = value.scope;
              }
              
              updatedData.status = 'active';
              updatedData.errorMessage = '';
              updatedData.lastRefreshAt = new Date().toISOString();
            }
          } else {
            updatedData[field] = value.toString();
          }
        }
      }
      
      // 如果新增了 refresh token（之前没有，现在有了），更新过期时间为10分钟
      if (updates.refreshToken && !oldRefreshToken && updates.refreshToken.trim()) {
        const newExpiresAt = Date.now() + (10 * 60 * 1000); // 10分钟
        updatedData.expiresAt = newExpiresAt.toString();
        logger.info(`🔄 New refresh token added for account ${accountId}, setting expiry to 10 minutes`);
      }
      
      // 如果通过 claudeAiOauth 更新，也要检查是否新增了 refresh token
      if (updates.claudeAiOauth && updates.claudeAiOauth.refreshToken && !oldRefreshToken) {
        // 如果 expiresAt 设置的时间过长（超过1小时），调整为10分钟
        const providedExpiry = parseInt(updates.claudeAiOauth.expiresAt);
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        if (providedExpiry - now > oneHour) {
          const newExpiresAt = now + (10 * 60 * 1000); // 10分钟
          updatedData.expiresAt = newExpiresAt.toString();
          logger.info(`🔄 Adjusted expiry time to 10 minutes for account ${accountId} with refresh token`);
        }
      }

      updatedData.updatedAt = new Date().toISOString();
      
      await redis.setClaudeAccount(accountId, updatedData);
      
      logger.success(`📝 Updated Claude account: ${accountId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to update Claude account:', error);
      throw error;
    }
  }

  // 🗑️ 删除Claude账户
  async deleteAccount(accountId) {
    try {
      const result = await redis.deleteClaudeAccount(accountId);
      
      if (result === 0) {
        throw new Error('Account not found');
      }
      
      logger.success(`🗑️ Deleted Claude account: ${accountId}`);
      
      return { success: true };
    } catch (error) {
      logger.error('❌ Failed to delete Claude account:', error);
      throw error;
    }
  }

  // 🎯 智能选择可用账户（支持sticky会话）
  async selectAvailableAccount(sessionHash = null) {
    try {
      const accounts = await redis.getAllClaudeAccounts();
      
      const activeAccounts = accounts.filter(account => 
        account.isActive === 'true' && 
        account.status !== 'error'
      );

      if (activeAccounts.length === 0) {
        throw new Error('No active Claude accounts available');
      }

      // 如果有会话哈希，检查是否有已映射的账户
      if (sessionHash) {
        const mappedAccountId = await redis.getSessionAccountMapping(sessionHash);
        if (mappedAccountId) {
          // 验证映射的账户是否仍然可用
          const mappedAccount = activeAccounts.find(acc => acc.id === mappedAccountId);
          if (mappedAccount) {
            logger.info(`🎯 Using sticky session account: ${mappedAccount.name} (${mappedAccountId}) for session ${sessionHash}`);
            return mappedAccountId;
          } else {
            logger.warn(`⚠️ Mapped account ${mappedAccountId} is no longer available, selecting new account`);
            // 清理无效的映射
            await redis.deleteSessionAccountMapping(sessionHash);
          }
        }
      }

      // 如果没有映射或映射无效，选择新账户
      // 优先选择最久未使用的账户（负载均衡）
      const sortedAccounts = activeAccounts.sort((a, b) => {
        const aLastUsed = new Date(a.lastUsedAt || 0).getTime();
        const bLastUsed = new Date(b.lastUsedAt || 0).getTime();
        return aLastUsed - bLastUsed; // 最久未使用的优先
      });

      const selectedAccountId = sortedAccounts[0].id;
      
      // 如果有会话哈希，建立新的映射
      if (sessionHash) {
        await redis.setSessionAccountMapping(sessionHash, selectedAccountId, 3600); // 1小时过期
        logger.info(`🎯 Created new sticky session mapping: ${sortedAccounts[0].name} (${selectedAccountId}) for session ${sessionHash}`);
      }

      return selectedAccountId;
    } catch (error) {
      logger.error('❌ Failed to select available account:', error);
      throw error;
    }
  }

  // 🎯 基于API Key选择账户（支持专属绑定和多共享池）
  async selectAccountForApiKey(apiKeyData, sessionHash = null, excludeAccountIds = null) {
    try {
      // 检查是否是账户直接认证（API Key ID以 account_ 开头）
      if (apiKeyData.id && apiKeyData.id.startsWith('account_')) {
        // 这是账户直接认证，直接返回绑定的账户ID
        const accountId = apiKeyData.claudeAccountId;
        logger.info(`🎯 Direct account authentication: ${accountId}`);
        
        // 验证账户是否可用
        const account = await redis.getClaudeAccount(accountId);
        if (!account || account.isActive !== 'true' || account.status === 'error' || account.status === 'banned') {
          throw new Error(`Direct account ${accountId} is not available`);
        }
        
        return {
          accountId: accountId,
          poolId: null
        };
      }
      
      // 如果API Key绑定了专属账户，优先使用
      if (apiKeyData.claudeAccountId && (!excludeAccountIds || !excludeAccountIds.has(apiKeyData.claudeAccountId))) {
        const boundAccount = await redis.getClaudeAccount(apiKeyData.claudeAccountId);
        if (boundAccount && boundAccount.isActive === 'true' && boundAccount.status !== 'error' && boundAccount.status !== 'banned') {
          logger.info(`🎯 Using bound dedicated account: ${boundAccount.name} (${apiKeyData.claudeAccountId}) for API key ${apiKeyData.name}`);
          // 专属账户不属于任何池，poolId为null
          return {
            accountId: apiKeyData.claudeAccountId,
            poolId: null
          };
        } else {
          const status = boundAccount ? boundAccount.status : 'not found';
          logger.warn(`⚠️ Bound account ${apiKeyData.claudeAccountId} is not available (status: ${status}), falling back to shared pools`);
        }
      }

      // 从共享账户中选择
      logger.info(`🎯 Selecting from shared accounts for API key ${apiKeyData.name}`);
      
      // 检查会话映射
      if (sessionHash) {
        const mappedAccountId = await redis.getSessionAccountMapping(sessionHash);
        if (mappedAccountId && (!excludeAccountIds || !excludeAccountIds.has(mappedAccountId))) {
          const mappedAccount = await redis.getClaudeAccount(mappedAccountId);
          if (mappedAccount && mappedAccount.isActive === 'true' && mappedAccount.status !== 'error' && mappedAccount.status !== 'banned') {
            const isRateLimited = await this.isAccountRateLimited(mappedAccountId);
            if (!isRateLimited) {
              logger.info(`🎯 Using mapped account ${mappedAccountId} for session`);
              return {
                accountId: mappedAccountId,
                poolId: null
              };
            } else {
              logger.warn(`⚠️ Mapped account ${mappedAccountId} is rate limited, selecting new account`);
              await redis.deleteSessionAccountMapping(sessionHash);
            }
          }
        }
      }

      // 如果仍然没有找到账户，作为最后的备用方案
      const accounts = await redis.getAllClaudeAccounts();
      
      let sharedAccounts = accounts.filter(account => 
        account.isActive === 'true' && 
        account.status !== 'error' &&
        account.status !== 'banned' &&
        (account.accountType === 'shared' || !account.accountType) // 兼容旧数据
      );

      // 排除已使用的账户
      if (excludeAccountIds && excludeAccountIds.size > 0) {
        sharedAccounts = sharedAccounts.filter(account => !excludeAccountIds.has(account.id));
        logger.info(`🔍 Excluding ${excludeAccountIds.size} already used accounts, ${sharedAccounts.length} accounts remaining`);
      }

      if (sharedAccounts.length === 0) {
        throw new Error('No active shared Claude accounts available');
      }

      // 如果有会话哈希，检查是否有已映射的账户
      if (sessionHash && (!excludeAccountIds || excludeAccountIds.size === 0)) {
        const mappedAccountId = await redis.getSessionAccountMapping(sessionHash);
        if (mappedAccountId) {
          // 验证映射的账户是否仍然在共享池中且可用
          const mappedAccount = sharedAccounts.find(acc => acc.id === mappedAccountId);
          if (mappedAccount) {
            // 如果映射的账户被限流了，删除映射并重新选择
            const isRateLimited = await this.isAccountRateLimited(mappedAccountId);
            if (isRateLimited) {
              logger.warn(`⚠️ Mapped account ${mappedAccountId} is rate limited, selecting new account`);
              await redis.deleteSessionAccountMapping(sessionHash);
            } else {
              logger.info(`🎯 Using sticky session shared account: ${mappedAccount.name} (${mappedAccountId}) for session ${sessionHash}`);
              // 会话映射的账户不属于任何池
              return {
                accountId: mappedAccountId,
                poolId: null
              };
            }
          } else {
            logger.warn(`⚠️ Mapped shared account ${mappedAccountId} is no longer available, selecting new account`);
            // 清理无效的映射
            await redis.deleteSessionAccountMapping(sessionHash);
          }
        }
      }

      // 将账户分为限流和非限流两组
      const nonRateLimitedAccounts = [];
      const rateLimitedAccounts = [];
      
      for (const account of sharedAccounts) {
        const isRateLimited = await this.isAccountRateLimited(account.id);
        if (isRateLimited) {
          const rateLimitInfo = await this.getAccountRateLimitInfo(account.id);
          account._rateLimitInfo = rateLimitInfo; // 临时存储限流信息
          rateLimitedAccounts.push(account);
        } else {
          nonRateLimitedAccounts.push(account);
        }
      }

      // 优先从非限流账户中选择
      let candidateAccounts = nonRateLimitedAccounts;
      
      // 如果没有非限流账户，则从限流账户中选择（按限流时间排序，最早限流的优先）
      if (candidateAccounts.length === 0) {
        logger.warn('⚠️ All shared accounts are rate limited, selecting from rate limited pool');
        candidateAccounts = rateLimitedAccounts.sort((a, b) => {
          const aRateLimitedAt = new Date(a._rateLimitInfo.rateLimitedAt).getTime();
          const bRateLimitedAt = new Date(b._rateLimitInfo.rateLimitedAt).getTime();
          return aRateLimitedAt - bRateLimitedAt; // 最早限流的优先
        });
      } else {
        // 非限流账户按最后使用时间排序（最久未使用的优先）
        candidateAccounts = candidateAccounts.sort((a, b) => {
          const aLastUsed = new Date(a.lastUsedAt || 0).getTime();
          const bLastUsed = new Date(b.lastUsedAt || 0).getTime();
          return aLastUsed - bLastUsed; // 最久未使用的优先
        });
      }

      if (candidateAccounts.length === 0) {
        throw new Error('No available shared Claude accounts');
      }

      const selectedAccountId = candidateAccounts[0].id;
      
      // 如果有会话哈希，建立新的映射
      if (sessionHash) {
        await redis.setSessionAccountMapping(sessionHash, selectedAccountId, 3600); // 1小时过期
        logger.info(`🎯 Created new sticky session mapping for shared account: ${candidateAccounts[0].name} (${selectedAccountId}) for session ${sessionHash}`);
      }

      logger.info(`🎯 Selected shared account: ${candidateAccounts[0].name} (${selectedAccountId}) for API key ${apiKeyData.name}`);
      // 备用方案选择的账户不属于任何池
      return {
        accountId: selectedAccountId,
        poolId: null
      };
    } catch (error) {
      logger.error('❌ Failed to select account for API key:', error);
      throw error;
    }
  }

  // 🌐 创建代理agent
  _createProxyAgent(proxyConfig) {
    if (!proxyConfig) {
      return null;
    }

    try {
      const proxy = JSON.parse(proxyConfig);
      
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
      logger.warn('⚠️ Invalid proxy configuration:', error);
    }

    return null;
  }

  // 🔐 加密敏感数据
  _encryptSensitiveData(data) {
    if (!data) return '';
    
    try {
      const key = this._generateEncryptionKey();
      const iv = crypto.randomBytes(16);
      
      const cipher = crypto.createCipheriv(this.ENCRYPTION_ALGORITHM, key, iv);
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      
      // 将IV和加密数据一起返回，用:分隔
      return iv.toString('hex') + ':' + encrypted;
    } catch (error) {
      logger.error('❌ Encryption error:', error);
      return data;
    }
  }

  // 🔓 解密敏感数据
  _decryptSensitiveData(encryptedData) {
    if (!encryptedData) return '';
    
    try {
      // 检查是否是新格式（包含IV）
      if (encryptedData.includes(':')) {
        // 新格式：iv:encryptedData
        const parts = encryptedData.split(':');
        if (parts.length === 2) {
          const key = this._generateEncryptionKey();
          const iv = Buffer.from(parts[0], 'hex');
          const encrypted = parts[1];
          
          const decipher = crypto.createDecipheriv(this.ENCRYPTION_ALGORITHM, key, iv);
          let decrypted = decipher.update(encrypted, 'hex', 'utf8');
          decrypted += decipher.final('utf8');
          return decrypted;
        }
      }
      
      // 旧格式或格式错误，尝试旧方式解密（向后兼容）
      // 注意：在新版本Node.js中这将失败，但我们会捕获错误
      try {
        const decipher = crypto.createDecipher('aes-256-cbc', config.security.encryptionKey);
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      } catch (oldError) {
        // 如果旧方式也失败，返回原数据
        logger.warn('⚠️ Could not decrypt data, returning as-is:', oldError.message);
        return encryptedData;
      }
    } catch (error) {
      logger.error('❌ Decryption error:', error);
      return encryptedData;
    }
  }

  // 🔑 生成加密密钥（辅助方法）
  _generateEncryptionKey() {
    return crypto.scryptSync(config.security.encryptionKey, this.ENCRYPTION_SALT, 32);
  }

  // 🎭 掩码邮箱地址
  _maskEmail(email) {
    if (!email || !email.includes('@')) return email;
    
    const [username, domain] = email.split('@');
    const maskedUsername = username.length > 2 
      ? `${username.slice(0, 2)}***${username.slice(-1)}`
      : `${username.slice(0, 1)}***`;
    
    return `${maskedUsername}@${domain}`;
  }

  // 🧹 清理错误账户
  async cleanupErrorAccounts() {
    try {
      const accounts = await redis.getAllClaudeAccounts();
      let cleanedCount = 0;

      for (const account of accounts) {
        if (account.status === 'error' && account.lastRefreshAt) {
          const lastRefresh = new Date(account.lastRefreshAt);
          const now = new Date();
          const hoursSinceLastRefresh = (now - lastRefresh) / (1000 * 60 * 60);

          // 如果错误状态超过24小时，尝试重新激活
          if (hoursSinceLastRefresh > 24) {
            account.status = 'created';
            account.errorMessage = '';
            await redis.setClaudeAccount(account.id, account);
            cleanedCount++;
          }
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Reset ${cleanedCount} error accounts`);
      }

      return cleanedCount;
    } catch (error) {
      logger.error('❌ Failed to cleanup error accounts:', error);
      return 0;
    }
  }

  // 🚫 标记账号为限流状态
  async markAccountRateLimited(accountId, sessionHash = null) {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      // 设置限流状态和时间
      accountData.rateLimitedAt = new Date().toISOString();
      accountData.rateLimitStatus = 'limited';
      await redis.setClaudeAccount(accountId, accountData);

      // 如果有会话哈希，删除粘性会话映射
      if (sessionHash) {
        await redis.deleteSessionAccountMapping(sessionHash);
        logger.info(`🗑️ Deleted sticky session mapping for rate limited account: ${accountId}`);
      }

      logger.warn(`🚫 Account marked as rate limited: ${accountData.name} (${accountId})`);
      return { success: true };
    } catch (error) {
      logger.error(`❌ Failed to mark account as rate limited: ${accountId}`, error);
      throw error;
    }
  }

  // ✅ 移除账号的限流状态
  async removeAccountRateLimit(accountId) {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      // 清除限流状态
      delete accountData.rateLimitedAt;
      delete accountData.rateLimitStatus;
      await redis.setClaudeAccount(accountId, accountData);

      logger.success(`✅ Rate limit removed for account: ${accountData.name} (${accountId})`);
      return { success: true };
    } catch (error) {
      logger.error(`❌ Failed to remove rate limit for account: ${accountId}`, error);
      throw error;
    }
  }

  // 🔍 检查账号是否处于限流状态
  async isAccountRateLimited(accountId) {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        return false;
      }

      // 检查是否有限流状态
      if (accountData.rateLimitStatus === 'limited' && accountData.rateLimitedAt) {
        const rateLimitedAt = new Date(accountData.rateLimitedAt);
        const now = new Date();
        const hoursSinceRateLimit = (now - rateLimitedAt) / (1000 * 60 * 60);

        // 如果限流超过1小时，自动解除
        if (hoursSinceRateLimit >= 1) {
          await this.removeAccountRateLimit(accountId);
          return false;
        }

        return true;
      }

      return false;
    } catch (error) {
      logger.error(`❌ Failed to check rate limit status for account: ${accountId}`, error);
      return false;
    }
  }

  // 📊 获取账号的限流信息
  async getAccountRateLimitInfo(accountId) {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        return null;
      }

      if (accountData.rateLimitStatus === 'limited' && accountData.rateLimitedAt) {
        const rateLimitedAt = new Date(accountData.rateLimitedAt);
        const now = new Date();
        const minutesSinceRateLimit = Math.floor((now - rateLimitedAt) / (1000 * 60));
        const minutesRemaining = Math.max(0, 60 - minutesSinceRateLimit);

        return {
          isRateLimited: minutesRemaining > 0,
          rateLimitedAt: accountData.rateLimitedAt,
          minutesSinceRateLimit,
          minutesRemaining
        };
      }

      return {
        isRateLimited: false,
        rateLimitedAt: null,
        minutesSinceRateLimit: 0,
        minutesRemaining: 0
      };
    } catch (error) {
      logger.error(`❌ Failed to get rate limit info for account: ${accountId}`, error);
      return null;
    }
  }

  // 🔍 获取账户原始数据（内部使用）
  async _getAccountData(accountId) {
    try {
      return await redis.getClaudeAccount(accountId);
    } catch (error) {
      logger.error(`❌ Failed to get account data: ${accountId}`, error);
      return null;
    }
  }

  // 📝 更新账户原始数据（内部使用）
  async _updateAccountData(accountId, accountData) {
    try {
      await redis.setClaudeAccount(accountId, accountData);
      return true;
    } catch (error) {
      logger.error(`❌ Failed to update account data: ${accountId}`, error);
      return false;
    }
  }

  // 🚫 标记账号为不活跃
  async markAccountInactive(accountId, reason = '') {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      // 设置账号为不活跃状态
      accountData.isActive = 'false';
      accountData.status = 'error';
      accountData.errorMessage = reason || 'Account marked as inactive';
      accountData.deactivatedAt = new Date().toISOString();
      
      await redis.setClaudeAccount(accountId, accountData);

      // 删除所有相关的会话映射
      const client = redis.getClient();
      const sessionKeys = await client.keys('session_account_mapping:*');
      
      for (const key of sessionKeys) {
        const mappedAccountId = await client.get(key);
        if (mappedAccountId === accountId) {
          await client.del(key);
        }
      }

      logger.warn(`🚫 Account marked as inactive: ${accountData.name} (${accountId}) - Reason: ${reason}`);
      return { success: true };
    } catch (error) {
      logger.error(`❌ Failed to mark account as inactive: ${accountId}`, error);
      throw error;
    }
  }

  // 🔐 标记账号为OAuth被撤销
  async markAccountOAuthRevoked(accountId, reason = 'OAuth token revoked') {
    try {
      const accountData = await redis.getClaudeAccount(accountId);
      if (!accountData || Object.keys(accountData).length === 0) {
        throw new Error('Account not found');
      }

      // 设置账号为OAuth被撤销状态
      accountData.isActive = 'false';
      accountData.status = 'oauth_revoked';
      accountData.errorMessage = reason;
      accountData.oauthRevokedAt = new Date().toISOString();
      
      // 清除敏感的OAuth数据
      accountData.accessToken = '';
      accountData.refreshToken = '';
      accountData.claudeAiOauth = '';
      
      await redis.setClaudeAccount(accountId, accountData);

      // 删除所有相关的会话映射
      const client = redis.getClient();
      const sessionKeys = await client.keys('session_account_mapping:*');
      
      for (const key of sessionKeys) {
        const mappedAccountId = await client.get(key);
        if (mappedAccountId === accountId) {
          await client.del(key);
        }
      }

      logger.warn(`🔐 Account OAuth revoked: ${accountData.name} (${accountId}) - Reason: ${reason}`);
      
      return { success: true };
    } catch (error) {
      logger.error(`❌ Failed to mark account as OAuth revoked: ${accountId}`, error);
      throw error;
    }
  }
}

module.exports = new ClaudeAccountService();