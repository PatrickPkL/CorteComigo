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

const TTL = {
  CATALOG: 5 * 60 * 1000,
  PLANS: 10 * 60 * 1000,
  AVAILABILITY: 30 * 1000,
  SEARCH: 2 * 60 * 1000,
  DEFAULT: 60 * 1000
};

async function get(key) {
  const c = await getClient();
  const data = await c.get(key);
  return data ? JSON.parse(data) : null;
}

async function set(key, value, ttlMs = TTL.DEFAULT) {
  const c = await getClient();
  await c.set(key, JSON.stringify(value), { EX: Math.ceil(ttlMs / 1000) });
}

async function del(key) {
  const c = await getClient();
  await c.del(key);
}

async function deletePattern(pattern) {
  const c = await getClient();
  let cursor = 0;
  do {
    const { cursor: newCursor, keys } = await c.scan(cursor, { MATCH: pattern, COUNT: 100 });
    cursor = newCursor;
    if (keys.length > 0) {
      await c.del(keys);
    }
  } while (cursor !== '0');
}

async function getOrSet(key, fetcher, ttlMs = TTL.DEFAULT) {
  const cached = await get(key);
  if (cached !== null) return cached;
  const fresh = await fetcher();
  await set(key, fresh, ttlMs);
  return fresh;
}

module.exports = { get, set, del, deletePattern, getOrSet, TTL };
