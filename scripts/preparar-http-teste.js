'use strict';
/* ============================================================
   Prepara o ambiente para o teste HTTP do módulo de Reembolso.
   Grava TUDO direto no PostgreSQL, porque o servidor carrega os
   dados em memória no boot e não re-lê o banco depois.

   Uso:  node scripts/preparar-http-teste.js
         (iniciar o server.js)
         node scripts/testar-reembolso-http.js
   ============================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const boot = require('../backend/boot');

const ARQ = path.join(__dirname, '.http-teste.json');

(async () => {
  await boot.init();
  const { Auth, DB } = boot;
  const db = DB._d();

  /* 1. sessão de super-admin (superAdminHash é bcrypt; não há senha
        em texto no .env, então criamos a sessão como o login faria) */
  const saToken = 'sa-http-teste-' + crypto.randomBytes(6).toString('hex');
  const saEmail = (process.env.SUPER_ADMIN_EMAIL || 'admin@cortecomigo.com').toLowerCase();
  db.superadmin_sessions = (db.superadmin_sessions || []).filter(s => s.token !== saToken);
  db.superadmin_sessions.push({
    id: crypto.randomUUID(), token: saToken, email: saEmail,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 6 * 3600e3).toISOString()
  });

  /* 2. um barbeiro com loja + pagamento pago hoje (pra estar no prazo) */
  const dono = db.users.find(u => Auth.salaoDoUsuario(u));
  if (!dono) { console.error('Nenhum dono com loja encontrado.'); process.exit(1); }
  const loja = Auth.salaoDoUsuario(dono);

  const pedido = {
    id: crypto.randomUUID(),
    user_id: dono.id,
    barbershop_id: loja.id,
    temporary_pix_key: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    reason: 'Teste HTTP: solicitei reembolso por engano e paguei sem querer.',
    status: 'EM_ANALISE',
    visible_to_admin: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.reembolsos.push(pedido);

  /* 3. pedido PENDENTE_GMAIL — NÃO pode aparecer para o super-admin */
  const pendente = {
    id: crypto.randomUUID(),
    user_id: dono.id,
    barbershop_id: loja.id,
    temporary_pix_key: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    reason: 'Pedido que o barbeiro ainda nao confirmou o envio do e-mail.',
    status: 'PENDENTE_GMAIL',
    visible_to_admin: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.reembolsos.push(pendente);

  DB.salvar();
  await new Promise(r => setTimeout(r, 3000));

  const pg = require('../backend/pool');
  const noBanco = await pg.asAdmin(trx => trx('reembolsos')
    .whereIn('id', [pedido.id, pendente.id]).select('id', 'status'));
  if (noBanco.length !== 2) {
    console.error('Falha ao gravar os pedidos no banco: ' + JSON.stringify(noBanco));
    process.exit(1);
  }

  fs.writeFileSync(ARQ, JSON.stringify({
    sa_token: saToken, pedido_id: pedido.id, pendente_id: pendente.id,
    user_id: dono.id, loja_nome: loja.name
  }, null, 2), 'utf8');

  console.log('Ambiente pronto.');
  console.log('  super-admin token : ' + saToken);
  console.log('  pedido EM_ANALISE : ' + pedido.id);
  console.log('  pedido PENDENTE   : ' + pendente.id);
  console.log('  barbeiro          : ' + dono.name + ' / ' + loja.name);
  console.log('  arquivo           : ' + ARQ);
  console.log('\n  Agora inicie o server.js e rode scripts/testar-reembolso-http.js');
  process.exit(0);
})().catch(e => { console.error('ERRO:', e && e.stack || e); process.exit(1); });
