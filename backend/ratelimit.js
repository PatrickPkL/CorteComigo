const redis = require('redis');

let client;

async function getClient() {
  if (!client) {
    client = redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    client.on('error', (err) => console.error('Redis Client Error', err));
    await client.connect();
  }
  return client;
}

async function checkLimit(key, max, windowMs) {
  const c = await getClient();
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = atelimit:;

  const multi = c.multi();
  multi.zRemRangeByScore(redisKey, 0, windowStart);
  multi.zAdd(redisKey, { score: now, value: ${now}: });
  multi.zCard(redisKey);
  multi.expire(redisKey, Math.ceil(windowMs / 1000));
  const results = await multi.exec();

  const count = results[2];
  const remaining = Math.max(0, max - count);
  const resetTime = now + windowMs;

  return {
    allowed: count <= max,
    count,
    remaining,
    resetTime,
    max,
    windowMs
  };
}

async function resetLimit(key) {
  const c = await getClient();
  const redisKey = atelimit:;
  await c.del(redisKey);
}

module.exports = { checkLimit, resetLimit };
