'use strict';
/* ============================================================
   Prepara um cenário REAL para o teste de navegador:
     · pagamento pago HOJE (barbeiro dentro do prazo de 7 dias)
     · pagamento pago HÁ 10 DIAS (cenário de prazo expirado)
     · loja sem nenhum pagamento (fail-closed)
   Também imprime os ids para o script de navegador usar.
   ============================================================ */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const boot = require('../backend/boot');
const ARQ = path.join(__dirname, '.navegador.json');

(async () => {
  await boot.init();
  const { Auth, DB } = boot;
  const db = DB._d();

  const lojas = (db.barbershops || []).filter(b => b && b.id);
  if (!lojas.length) { console.error('Nenhuma loja no banco.'); process.exit(1); }

  const markers = '__NAV_REEMB_';
  /* limpa artefatos de execuções anteriores */
  db.payments = (db.payments || []).filter(p => !String(p.abacate_id || '').startsWith(markers));
  const comPagamento = [];
  const semPagamento = [];

  lojas.forEach((loja, i) => {
    const dono = (db.users || []).find(u => Auth.salaoDoUsuario(u) === loja)
      || (db.users || []).find(u => u.role === 'dono');
    if (i === 0) {
      /* no prazo: pago hoje */
      comPagamento.push(loja);
      db.payments.push({
        id: crypto.randomUUID(), barbershop_id: loja.id, plan_id: null,
        amount_cents: 1990, status: 'paid', provider: 'demo',
        abacate_id: markers + 'ok', br_code: null, qr_base64: null, dev_mode: true,
        refunded_at: null, refund_reason: null, refund_id: null,
        created_at: new Date().toISOString(), expires_at: null,
        paid_at: new Date().toISOString()
      });
    } else if (i === 1) {
      /* prazo estourado: pago há 10 dias */
      comPagamento.push(loja);
      const pago = new Date(Date.now() - 10 * 24 * 3600e3).toISOString();
      db.payments.push({
        id: crypto.randomUUID(), barbershop_id: loja.id, plan_id: null,
        amount_cents: 1990, status: 'paid', provider: 'demo',
        abacate_id: markers + 'velho', br_code: null, qr_base64: null, dev_mode: true,
        refunded_at: null, refund_reason: null, refund_id: null,
        created_at: pago, expires_at: null, paid_at: pago
      });
    } else {
      semPagamento.push(loja);
    }
  });

  /* garante que a loja "no prazo" tem assinatura para o Auth resolver o salão */
  DB.salvar();

  /* cria sessões REAIS no banco: o servidor carrega `sessions` na memória
     no boot, então precisam existir ANTES de subir o server.js. É assim que
     o navegador vai "logar" sem passar por SMS/e-mail. */
  const MARCA = '__NAV_SESS_';
  db.sessions = (db.sessions || []).filter(s => !String(s.token || '').startsWith(MARCA));
  const agora = new Date(Date.now() + 12 * 3600e3).toISOString();
  function criarSessao(userId) {
    /* `sessions.id` é uuid no PostgreSQL; o token é texto livre */
    const token = MARCA + require('crypto').randomBytes(6).toString('hex');
    db.sessions.push({ id: require('crypto').randomUUID(), user_id: userId, token: token, expires_at: agora });
    return token;
  }

  await new Promise(r => setTimeout(r, 3000));

  const porLoja = {};
  for (const l of lojas) {
    const dono = (db.users || []).find(u => Auth.salaoDoUsuario(u) === l);
    porLoja[l.id] = dono ? dono.id : null;
  }

  const dentro = comPagamento[0];
  const fora = comPagamento[1] || null;
  const semPag = semPagamento[0] || null;

  const out = {};
  for (const [k, l] of Object.entries({
    dentro_prazo: dentro, fora_prazo: fora, sem_pagamento: semPag
  })) {
    if (!l) { out[k] = null; continue; }
    const u = (db.users || []).find(x => x.id === porLoja[l.id]);
    out[k] = {
      loja: l.id, loja_nome: l.name,
      user_id: porLoja[l.id],
      user_nome: u ? u.name : '',
      token: criarSessao(porLoja[l.id])
    };
  }
  DB.salvar();
  await new Promise(r => setTimeout(r, 3000));

  fs.writeFileSync(ARQ, JSON.stringify(out, null, 2), 'utf8');
  console.log('Cenário pronto:');
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
})().catch(e => { console.error('ERRO:', e && e.stack || e); process.exit(1); });
