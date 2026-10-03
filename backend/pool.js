const knex = require('knex');

const poolConfig = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: {
    min: 2,
    max: 50,
    acquireTimeoutMillis: 30000,
    createTimeoutMillis: 30000,
    destroyTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
    propagateCreateError: () => new Error('Failed to create connection'),
  },
  acquireConnectionTimeout: 30000,
};

const db = knex(poolConfig);

db.on('query', (query) => {
  if (process.env.NODE_ENV === 'development') {
    console.log('[Knex] Query:', query.sql, query.bindings);
  }
});

db.on('query-error', (error, query) => {
  console.error('[Knex] Query Error:', error.message, query?.sql);
});

module.exports = db;
