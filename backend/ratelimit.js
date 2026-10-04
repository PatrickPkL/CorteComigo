const redis = require('redis');
const crypto = require('crypto');

/* Rate limit por janela deslizante (sorted set no Redis).
   ATENÇÃO: exige REDIS_URL alcançável. A hospedagem compartilhada não
   tem Redis gerenciado — o rate limit de produção do app NÃO usa este
   arquivo (ver o guard _failedAuth em server.js, que é em memória).
   Se algo chegar a Require isto sem Redis, a exceção é explícita. */

let client;

async function getClient() {
  if (!client) {
    client = redis.createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
    client.on('error', (err) => console.error('[ratelimit] Redis Client Error', err));
    await client.connect();
  }
  return client;
}

function chaveDe(key) {
  return `ratelimit:${key}`;
}

async function checkLimit(key, max, windowMs) {
  const c = await getClient();
  const now = Date.now();
  const windowStart = now - windowMs;
  const redisKey = chaveDe(key);

  const multi = c.multi();
  multi.zRemRangeByScore(redisKey, 0, windowStart);
  multi.zAdd(redisKey, { score: now, value: `${now}:${crypto.randomUUID()}` });
  multi.zCard(redisKey);
  multi.expire(redisKey, Math.ceil(windowMs / 1000));
  const results = await multi.exec();

  const count = Number(results && results[2]) || 0;
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
  await c.del(chaveDe(key));
}

module.exports = { checkLimit, resetLimit };