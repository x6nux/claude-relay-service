// 多共享池功能测试脚本
const redis = require('./src/models/redis');
const sharedPoolService = require('./src/services/sharedPoolService');
const apiKeyService = require('./src/services/apiKeyService');
const claudeAccountService = require('./src/services/claudeAccountService');
const logger = require('./src/utils/logger');

async function testSharedPools() {
  console.log('🧪 开始测试多共享池功能...\n');
  
  try {
    // 连接 Redis
    await redis.connect();
    console.log('✅ Redis 连接成功\n');
    
    // 1. 创建测试共享池
    console.log('📋 测试 1: 创建共享池');
    const pool1 = await sharedPoolService.createPool({
      name: '高优先级池',
      description: '用于重要的 API 请求',
      priority: 200,
      accountSelectionStrategy: 'least_used'
    });
    console.log(`✅ 创建共享池 1: ${pool1.name} (ID: ${pool1.id})`);
    
    const pool2 = await sharedPoolService.createPool({
      name: '普通池',
      description: '用于常规 API 请求',
      priority: 100,
      accountSelectionStrategy: 'round_robin'
    });
    console.log(`✅ 创建共享池 2: ${pool2.name} (ID: ${pool2.id})`);
    
    const pool3 = await sharedPoolService.createPool({
      name: '备用池',
      description: '低优先级备用池',
      priority: 50,
      accountSelectionStrategy: 'random'
    });
    console.log(`✅ 创建共享池 3: ${pool3.name} (ID: ${pool3.id})\n`);
    
    // 2. 获取所有共享池
    console.log('📋 测试 2: 获取所有共享池');
    const allPools = await sharedPoolService.getAllPools();
    console.log(`✅ 找到 ${allPools.length} 个共享池`);
    allPools.forEach(pool => {
      console.log(`   - ${pool.name} (优先级: ${pool.priority}, 策略: ${pool.accountSelectionStrategy})`);
    });
    console.log('');
    
    // 3. 更新共享池
    console.log('📋 测试 3: 更新共享池');
    await sharedPoolService.updatePool(pool2.id, {
      priority: 150,
      description: '更新后的描述'
    });
    console.log('✅ 共享池更新成功\n');
    
    // 4. 获取现有的 Claude 账户
    console.log('📋 测试 4: 获取 Claude 账户');
    const accounts = await claudeAccountService.getAllAccounts();
    console.log(`✅ 找到 ${accounts.length} 个 Claude 账户`);
    
    if (accounts.length >= 3) {
      // 5. 将账户添加到不同的共享池
      console.log('\n📋 测试 5: 将账户添加到共享池');
      
      // 添加前两个账户到高优先级池
      await sharedPoolService.addAccountToPool(pool1.id, accounts[0].id);
      await sharedPoolService.addAccountToPool(pool1.id, accounts[1].id);
      console.log(`✅ 添加 2 个账户到高优先级池`);
      
      // 添加中间的账户到普通池
      if (accounts.length >= 4) {
        await sharedPoolService.addAccountToPool(pool2.id, accounts[1].id); // 账户可以在多个池中
        await sharedPoolService.addAccountToPool(pool2.id, accounts[2].id);
        console.log(`✅ 添加 2 个账户到普通池（其中一个账户同时在两个池中）`);
      }
      
      // 添加最后的账户到备用池
      await sharedPoolService.addAccountToPool(pool3.id, accounts[accounts.length - 1].id);
      console.log(`✅ 添加 1 个账户到备用池`);
    } else {
      console.log('⚠️  账户数量不足，跳过账户分配测试');
    }
    
    // 6. 获取 API Keys
    console.log('\n📋 测试 6: 获取 API Keys');
    const apiKeys = await apiKeyService.getAllApiKeys();
    console.log(`✅ 找到 ${apiKeys.length} 个 API Keys`);
    
    if (apiKeys.length > 0) {
      // 7. 将 API Key 关联到多个共享池
      console.log('\n📋 测试 7: 将 API Key 关联到共享池');
      const testKey = apiKeys[0];
      
      await apiKeyService.addApiKeyToPool(testKey.id, pool1.id);
      await apiKeyService.addApiKeyToPool(testKey.id, pool2.id);
      console.log(`✅ API Key "${testKey.name}" 已关联到 2 个共享池`);
      
      // 8. 获取 API Key 的共享池
      console.log('\n📋 测试 8: 获取 API Key 的共享池');
      const keyPools = await apiKeyService.getApiKeyPools(testKey.id);
      console.log(`✅ API Key 关联了 ${keyPools.length} 个共享池:`);
      keyPools.forEach(pool => {
        console.log(`   - ${pool.name} (优先级: ${pool.priority})`);
      });
      
      // 9. 测试账户选择
      console.log('\n📋 测试 9: 测试从共享池选择账户');
      if (accounts.length >= 2) {
        try {
          const result = await sharedPoolService.selectAccountFromPools(testKey.id);
          console.log(`✅ 选择了账户: ${result.accountId}`);
          console.log(`   来自共享池: ${result.poolName} (${result.poolId})`);
        } catch (error) {
          console.log(`⚠️  账户选择失败: ${error.message}`);
        }
      }
    } else {
      console.log('⚠️  没有找到 API Keys，跳过关联测试');
    }
    
    // 10. 清理测试数据
    console.log('\n📋 测试 10: 清理测试数据');
    const { confirm } = await require('inquirer').prompt([{
      type: 'confirm',
      name: 'confirm',
      message: '是否删除测试创建的共享池？',
      default: false
    }]);
    
    if (confirm) {
      await sharedPoolService.deletePool(pool1.id);
      await sharedPoolService.deletePool(pool2.id);
      await sharedPoolService.deletePool(pool3.id);
      console.log('✅ 测试共享池已删除');
    } else {
      console.log('ℹ️  保留测试共享池');
    }
    
    console.log('\n✅ 多共享池功能测试完成！');
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error);
    logger.error('测试失败:', error);
  } finally {
    await redis.disconnect();
    console.log('\n👋 Redis 连接已断开');
  }
}

// 运行测试
testSharedPools();