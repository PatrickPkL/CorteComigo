const Redis = require('ioredis');
const crypto = require('crypto');

class AuthService {
  constructor(options = {}) {
    this.redis = new Redis(options.redisUrl || process.env.REDIS_URL || 'redis://localhost:6379');
    this.sessionPrefix = 'session:';
    this.rateLimitPrefix = 'ratelimit:';
    this.defaultSessionTTL = options.sessionTTL || 86400;
    this.defaultRateLimitTTL = options.rateLimitTTL || 3600;
    this.maxRequests = options.maxRequests || 100;
  }

  async createSession(userId, data = {}) {
    const sessionId = crypto.randomBytes(32).toString('hex');
    const sessionData = {
      userId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      ...data
    };
    
    await this.redis.setex(
      this.sessionPrefix + sessionId,
      this.defaultSessionTTL,
      JSON.stringify(sessionData)
    );
    
    return sessionId;
  }

  async getSession(sessionId) {
    const data = await this.redis.get(this.sessionPrefix + sessionId);
    if (!data) return null;
    
    const session = JSON.parse(data);
    session.lastActivity = Date.now();
    
    await this.redis.setex(
      this.sessionPrefix + sessionId,
      this.defaultSessionTTL,
      JSON.stringify(session)
    );
    
    return session;
  }

  async deleteSession(sessionId) {
    await this.redis.del(this.sessionPrefix + sessionId);
  }

  async validateSession(sessionId) {
    const session = await this.getSession(sessionId);
    return session ? session.userId : null;
  }

  async checkRateLimit(key, maxRequests = this.maxRequests, windowMs = this.defaultRateLimitTTL * 1000) {
    const redisKey = this.rateLimitPrefix + key;
    const current = await this.redis.incr(redisKey);
    
    if (current === 1) {
      await this.redis.pexpire(redisKey, windowMs);
    }
    
    const ttl = await this.redis.pttl(redisKey);
    
    return {
      allowed: current <= maxRequests,
      remaining: Math.max(0, maxRequests - current),
      resetTime: Date.now() + ttl,
      total: current
    };
  }

  async resetRateLimit(key) {
    await this.redis.del(this.rateLimitPrefix + key);
  }

  async getRateLimitInfo(key) {
    const redisKey = this.rateLimitPrefix + key;
    const current = await this.redis.get(redisKey);
    const ttl = await this.redis.pttl(redisKey);
    
    return {
      used: parseInt(current) || 0,
      remaining: Math.max(0, this.maxRequests - (parseInt(current) || 0)),
      resetTime: Date.now() + (ttl > 0 ? ttl : 0)
    };
  }

  async close() {
    await this.redis.quit();
  }
}

module.exports = AuthService;
