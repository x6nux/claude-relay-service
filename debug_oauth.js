#!/usr/bin/env node

/**
 * OAuth 授权流程调试脚本
 * 用于诊断 invalid_grant 错误
 */

const axios = require('axios');
const crypto = require('crypto');

// OAuth 配置
const OAUTH_CONFIG = {
    AUTHORIZE_URL: 'https://claude.ai/oauth/authorize',
    TOKEN_URL: 'https://console.anthropic.com/v1/oauth/token',
    CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    REDIRECT_URI: 'https://console.anthropic.com/oauth/code/callback',
    SCOPES: 'org:create_api_key user:profile user:inference'
};

// 生成随机的 state 参数
function generateState() {
    return crypto.randomBytes(32).toString('hex');
}

// 生成随机的 code verifier（PKCE）
function generateCodeVerifier() {
    return crypto.randomBytes(32).toString('base64url');
}

// 生成 code challenge（PKCE）
function generateCodeChallenge(codeVerifier) {
    return crypto.createHash('sha256')
        .update(codeVerifier)
        .digest('base64url');
}

// 生成授权 URL
function generateAuthUrl(codeChallenge, state) {
    const params = new URLSearchParams({
        code: 'true',
        client_id: OAUTH_CONFIG.CLIENT_ID,
        response_type: 'code',
        redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
        scope: OAUTH_CONFIG.SCOPES,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state: state
    });

    return `${OAUTH_CONFIG.AUTHORIZE_URL}?${params.toString()}`;
}

// 主函数
async function debugOAuth() {
    console.log('🔍 OAuth 授权流程调试工具\n');
    
    // 步骤 1: 生成 PKCE 参数
    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    
    console.log('📋 生成的 OAuth 参数:');
    console.log(`   State: ${state}`);
    console.log(`   Code Verifier: ${codeVerifier}`);
    console.log(`   Code Challenge: ${codeChallenge}`);
    console.log(`   Code Verifier 长度: ${codeVerifier.length}`);
    console.log(`   Code Challenge 长度: ${codeChallenge.length}\n`);
    
    // 步骤 2: 生成授权 URL
    const authUrl = generateAuthUrl(codeChallenge, state);
    console.log('🔗 授权 URL:');
    console.log(`   ${authUrl}\n`);
    
    console.log('📝 请按照以下步骤操作:');
    console.log('1. 复制上面的授权 URL 到浏览器');
    console.log('2. 登录您的 Claude 账户并授权');
    console.log('3. 授权后，浏览器会跳转到一个 URL，复制整个 URL');
    console.log('4. 运行: node debug_oauth.js exchange <回调URL> <sessionId>');
    console.log('\n💾 保存以下信息用于交换令牌:');
    console.log(`SessionId: (从API获取)`);
    console.log(`State: ${state}`);
    console.log(`Code Verifier: ${codeVerifier}`);
}

// 交换授权码
async function exchangeCode(callbackUrl, sessionId, savedState, savedCodeVerifier) {
    console.log('🔄 尝试交换授权码...\n');
    
    // 从回调 URL 中提取授权码
    let authCode;
    try {
        const url = new URL(callbackUrl);
        authCode = url.searchParams.get('code');
        const returnedState = url.searchParams.get('state');
        
        console.log('📋 从回调 URL 中提取的信息:');
        console.log(`   授权码: ${authCode ? authCode.substring(0, 20) + '...' : '未找到'}`);
        console.log(`   授权码长度: ${authCode ? authCode.length : 0}`);
        console.log(`   返回的 State: ${returnedState ? returnedState.substring(0, 20) + '...' : '未找到'}`);
        console.log(`   State 是否匹配: ${returnedState === savedState ? '✅ 是' : '❌ 否'}\n`);
        
        if (!authCode) {
            console.error('❌ 错误: 回调 URL 中未找到授权码');
            return;
        }
    } catch (error) {
        console.error('❌ 错误: 无法解析回调 URL:', error.message);
        return;
    }
    
    // 准备交换参数
    const params = {
        grant_type: 'authorization_code',
        client_id: OAUTH_CONFIG.CLIENT_ID,
        code: authCode,
        redirect_uri: OAUTH_CONFIG.REDIRECT_URI,
        code_verifier: savedCodeVerifier,
        state: savedState
    };
    
    console.log('📤 发送 token 交换请求:');
    console.log(`   URL: ${OAUTH_CONFIG.TOKEN_URL}`);
    console.log(`   Client ID: ${params.client_id}`);
    console.log(`   Redirect URI: ${params.redirect_uri}`);
    console.log(`   Code 长度: ${params.code.length}`);
    console.log(`   Code Verifier 长度: ${params.code_verifier.length}`);
    console.log(`   State 长度: ${params.state.length}\n`);
    
    try {
        const response = await axios.post(OAUTH_CONFIG.TOKEN_URL, params, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'claude-cli/1.0.56 (external, cli)',
                'Accept': 'application/json, text/plain, */*'
            }
        });
        
        console.log('✅ 成功! 收到的 tokens:');
        console.log(JSON.stringify(response.data, null, 2));
    } catch (error) {
        console.error('❌ 交换失败:');
        if (error.response) {
            console.error(`   状态码: ${error.response.status}`);
            console.error(`   错误数据: ${JSON.stringify(error.response.data, null, 2)}`);
            
            // 分析具体错误
            if (error.response.data?.error === 'invalid_grant') {
                console.error('\n🔍 invalid_grant 错误分析:');
                console.error('   可能的原因:');
                console.error('   1. 授权码已使用过（授权码只能使用一次）');
                console.error('   2. 授权码已过期（通常10分钟内有效）');
                console.error('   3. Code Verifier 不匹配（PKCE 验证失败）');
                console.error('   4. State 参数不匹配');
                console.error('   5. Client ID 或 Redirect URI 不匹配');
            }
        } else {
            console.error('   网络错误:', error.message);
        }
    }
}

// 命令行处理
const command = process.argv[2];

if (command === 'exchange') {
    const callbackUrl = process.argv[3];
    const sessionId = process.argv[4];
    const state = process.argv[5];
    const codeVerifier = process.argv[6];
    
    if (!callbackUrl || !state || !codeVerifier) {
        console.error('用法: node debug_oauth.js exchange <回调URL> <sessionId> <state> <codeVerifier>');
        process.exit(1);
    }
    
    exchangeCode(callbackUrl, sessionId, state, codeVerifier);
} else {
    debugOAuth();
}