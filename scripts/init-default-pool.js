// 初始化默认共享池脚本
const redis = require('../src/models/redis');
const sharedPoolService = require('../src/services/sharedPoolService');
const logger = require('../src/utils/logger');

async function initDefaultPool() {
  try {
    // 连接 Redis
    await redis.connect();
    console.log('✅ Redis 连接成功\n');
    
    // 获取或创建默认池
    console.log('🏊 初始化默认共享池...');
    const defaultPool = await sharedPoolService.getOrCreateDefaultPool();
    
    if (defaultPool) {
      console.log(`✅ 默认共享池已就绪`);
      console.log(`   - ID: ${defaultPool.id}`);
      console.log(`   - 名称: ${defaultPool.name}`);
      console.log(`   - 账户数量: ${defaultPool.accountIds ? defaultPool.accountIds.length : 0}`);
      console.log(`   - 选择策略: ${defaultPool.accountSelectionStrategy}`);
    }
    
    // 找出未分配到任何共享池的共享账户
    const client = redis.getClient();
    const accounts = await redis.getAllClaudeAccounts();
    const sharedAccounts = accounts.filter(account => 
      account.accountType === 'shared' && account.isActive === 'true'
    );
    
    if (sharedAccounts.length > 0) {
      console.log(`\n📊 找到 ${sharedAccounts.length} 个共享账户`);
      
      // 获取所有共享池
      const allPools = await sharedPoolService.getAllPools();
      const nonDefaultPools = allPools.filter(pool => pool.id !== sharedPoolService.DEFAULT_POOL_ID);
      
      // 收集所有已分配到其他池的账户ID
      const assignedAccountIds = new Set();
      for (const pool of nonDefaultPools) {
        const poolAccountsKey = `shared_pool_accounts:${pool.id}`;
        const accountIds = await client.smembers(poolAccountsKey);
        accountIds.forEach(id => assignedAccountIds.add(id));
      }
      
      // 找出未分配的账户
      const unassignedAccounts = sharedAccounts.filter(account => 
        !assignedAccountIds.has(account.id)
      );
      
      console.log(`   - 已分配到其他池: ${assignedAccountIds.size} 个`);
      console.log(`   - 未分配到任何池: ${unassignedAccounts.length} 个`);
      
      // 将未分配的账户添加到默认池
      if (unassignedAccounts.length > 0) {
        const poolAccountsKey = `shared_pool_accounts:${sharedPoolService.DEFAULT_POOL_ID}`;
        const accountIdsToAdd = unassignedAccounts.map(acc => acc.id);
        await client.sadd(poolAccountsKey, ...accountIdsToAdd);
        
        console.log(`✅ 添加了 ${unassignedAccounts.length} 个未分配的共享账户到默认池`);
        unassignedAccounts.forEach(acc => {
          console.log(`   - ${acc.name} (${acc.id})`);
        });
      } else {
        console.log(`ℹ️  没有未分配的共享账户需要添加到默认池`);
      }
    } else {
      console.log(`ℹ️  系统中没有共享账户`);
    }
    
    console.log('\n✅ 默认共享池初始化完成！');
    
  } catch (error) {
    console.error('\n❌ 初始化失败:', error);
    logger.error('初始化默认池失败:', error);
  } finally {
    await redis.disconnect();
    console.log('\n👋 Redis 连接已断开');
  }
}

// 运行初始化
initDefaultPool();