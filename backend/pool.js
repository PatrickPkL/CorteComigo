const knex = require('knex');

/* ============================================================
   SSL do banco.

   O commit 4105be8 ("500+ scaling") sobrescreveu este arquivo e
   perdeu o parse da URL, Together with the `ssl` setting. Resultado:
   o pg interpretava "sslmode=require" na URL como verify-full,
   exigia certificado válido e o boot morria com

       self signed certificate in certificate chain

   É o que acontece com host gerenciado (Hostinger/Neon/Render), que
   usa certificado self-signed. Restaurado do commit 5ee6e4b.

   Parsear a URL aqui também evita depender da versão de
   pg-connection-string instalada no servidor.

   A conexão continua SEMPRE criptografada (TLS). O que não fazemos
   por padrão é validar a cadeia contra uma CA confiável, porque o
   certificado do host não é emitted por uma. Para exigir validação
   estrita, defina PGSSL_STRICT=1 e aponte para um CA confiável.
   ============================================================ */
const _url = process.env.DATABASE_URL;
const _temSsl = _url && /(ssl=true|sslmode)/i.test(_url);
let _conn = _url;
if (_temSsl) {
  const _p = new URL(_url);
  _conn = {
    host: _p.hostname,
    port: Number(_p.port || 5432),
    database: (_p.pathname || '').replace(/^\//, ''),
    user: decodeURIComponent(_p.username || ''),
    password: decodeURIComponent(_p.password || ''),
    ssl: { rejectUnauthorized: process.env.PGSSL_STRICT === '1' }
  };
}

const poolConfig = {
  client: 'pg',
  connection: _conn,
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
