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

/* Executa fn dentro de uma transação.
   Usado por db.js (carga inicial, diff de escrita, purge de sessões) e
   pelos scripts em scripts/*.js. Precisa existir porque db.js faz
   `const { asAdmin } = require('./pool')` — sem esta função o boot morria
   com "asAdmin is not a function" (503).
   Quando ADMIN_DB_ROLE está definida, escala para esse role dentro da
   transação (é o role com BYPASSRLS criado em 005_rls.js). Opcional de
   propósito: se o role não existir no banco, o boot continua funcionando
   com o usuário dono em vez de morrer. */
async function asAdmin(fn) {
  return db.transaction(async (trx) => {
    const role = String(process.env.ADMIN_DB_ROLE || '').trim();
    if (role) {
      await trx.raw('SET LOCAL ROLE ??', [role]);
    }
    return fn(trx);
  });
}

/* O módulo é usado de três formas no projeto — `require('./pool')` direto
   (instância do knex), `require('./pool').knex` (api.js, server.js) e
   `const { knex, asAdmin } = require('./pool')` (db.js, scripts).
   Exportar a instância com as duas propriedades anexadas satisfaz as três. */
db.knex = db;
db.asAdmin = asAdmin;

module.exports = db;
