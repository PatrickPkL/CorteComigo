const Redis = require('ioredis');

const createRedisClient = (options = {}) => {
  const config = {
    host: options.host || process.env.REDIS_HOST || 'localhost',
    port: options.port || parseInt(process.env.REDIS_PORT) || 6379,
    password: options.password || process.env.REDIS_PASSWORD || undefined,
    db: options.db || parseInt(process.env.REDIS_DB) || 0,
    
    maxRetriesPerRequest: options.maxRetriesPerRequest ?? 3,
    retryStrategy: (times) => {
      const delay = Math.min(times * 50, 2000);
      return delay;
    },
    lazyConnect: options.lazyConnect ?? true,
    enableReadyCheck: options.enableReadyCheck ?? true,
    connectTimeout: options.connectTimeout ?? 10000,
    commandTimeout: options.commandTimeout ?? 5000,
    family: options.family ?? 4,
    keepAlive: options.keepAlive ?? 30000,
    tls: options.tls || undefined,
    maxmemoryPolicy: options.maxmemoryPolicy || 'allkeys-lru',
    connectionName: options.connectionName || `corte-certo-${process.env.NODE_ENV || 'development'}`,
    reconnectOnError: (err) => {
      const targetErrors = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENOTFOUND'];
      return targetErrors.some(target => err.message.includes(target));
    },
    
    ...options
  };

  const client = new Redis(config);

  client.on('connect', () => {
    console.log('[Redis] Connected');
  });

  client.on('ready', () => {
    console.log('[Redis] Ready');
  });

  client.on('error', (err) => {
    console.error('[Redis] Error:', err.message);
  });

  client.on('close', () => {
    console.log('[Redis] Connection closed');
  });

  client.on('reconnecting', () => {
    console.log('[Redis] Reconnecting...');
  });

  return client;
};

const redis = createRedisClient();

const connect = async () => {
  if (redis.status === 'wait') {
    await redis.connect();
  }
  return redis;
};

const disconnect = async () => {
  await redis.quit();
};

const healthCheck = async () => {
  try {
    const result = await redis.ping();
    return result === 'PONG';
  } catch (error) {
    console.error('[Redis] Health check failed:', error.message);
    return false;
  }
};

const getMemoryInfo = async () => {
  try {
    const info = await redis.info('memory');
    const usedMemory = info.match(/used_memory_human:(\S+)/);
    const usedMemoryPeak = info.match(/used_memory_peak_human:(\S+)/);
    const maxMemory = info.match(/maxmemory_human:(\S+)/);
    const memoryFragmentation = info.match(/mem_fragmentation_ratio:(\S+)/);
    
    return {
      used: usedMemory ? usedMemory[1] : 'unknown',
      peak: usedMemoryPeak ? usedMemoryPeak[1] : 'unknown',
      max: maxMemory ? maxMemory[1] : 'unlimited',
      fragmentationRatio: memoryFragmentation ? parseFloat(memoryFragmentation[1]) : 'unknown'
    };
  } catch (error) {
    console.error('[Redis] Failed to get memory info:', error.message);
    return null;
  }
};

module.exports = {
  redis,
  connect,
  disconnect,
  healthCheck,
  getMemoryInfo,
  createRedisClient
};
