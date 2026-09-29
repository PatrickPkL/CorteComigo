'use strict';
/* Cria a sessão de super-admin usada pelo teste de navegador e salva em
   scripts/.sa-nav.json. Precisa rodar ANTES de o server.js subir. */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const boot = require('../backend/boot');

(async () => {
  await boot.init();
  const { DB } = boot;
  const db = DB._d();
  const token = 'sa-nav-' + crypto.randomBytes(6).toString('hex');
  const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@cortecomigo.com').toLowerCase();
  db.superadmin_sessions = (db.superadmin_sessions || []).filter(s => s.token !== token);
  db.superadmin_sessions.push({
    id: crypto.randomUUID(), token: token, email: email,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 6 * 3600e3).toISOString()
  });
  DB.salvar();
  await new Promise(r => setTimeout(r, 3000));
  fs.writeFileSync(path.join(__dirname, '.sa-nav.json'), JSON.stringify({ token, email }, null, 2), 'utf8');
  console.log('Sessão SA de navegador criada: ' + token);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e && e.stack || e); process.exit(1); });
