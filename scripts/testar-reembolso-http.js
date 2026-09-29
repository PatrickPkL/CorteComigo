'use strict';
/* ============================================================
   Testa as ROTAS HTTP reais do Super Admin (não o API interno).
   Requer: node scripts/preparar-http-teste.js e o server.js no ar.
     · 401 sem token / com token inválido
     · GET com filtro de status
     · PENDENTE_GMAIL invisível
     · PUT marca REEMBOLSADO e dispara a notificação
     · DELETE faz SOFT delete (a linha continua no banco)
     · id inválido / inexistente não derruba o servidor
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:3000';
const ARQ = path.join(__dirname, '.http-teste.json');

let passou = 0, falhou = 0;
function ok(n, c, extra) {
  if (c) { passou++; console.log('  PASS  ' + n); }
  else { falhou++; console.log('  FAIL  ' + n + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function secao(t) { console.log('\n=== ' + t + ' ==='); }
function req(metodo, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const dados = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + urlPath, {
      method: metodo,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { 'x-super-admin-token': token } : {})
    }, res => {
      let s = '';
      res.on('data', d => s += d);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(s); } catch (e) { j = s; }
        resolve({ status: res.statusCode, body: j });
      });
    });
    r.on('error', reject);
    if (dados) r.write(dados);
    r.end();
  });
}
const data = r => (r.body && r.body.data) || [];

(async function () {
  if (!fs.existsSync(ARQ)) { console.error('Rode antes: node scripts/preparar-http-teste.js'); process.exit(1); }
  const ctx = JSON.parse(fs.readFileSync(ARQ, 'utf8'));
  const T = ctx.sa_token;
  const pg = require('../backend/pool');
  const T0 = new Date().toISOString();   /* marco temporal da execução (limpeza) */

  secao('1. Autenticação');
  const semTok = await req('GET', '/api/super-admin/reembolsos?status=todos', null);
  ok('sem token => 401', semTok.status === 401, { status: semTok.status, body: semTok.body });
  const tokRuim = await req('GET', '/api/super-admin/reembolsos?status=todos', 'token-invalido');
  ok('token inválido => 401', tokRuim.status === 401, tokRuim.status);

  secao('2. Listagem e filtro de status');
  const todos = await req('GET', '/api/super-admin/reembolsos?status=todos', T);
  ok('GET com token válido => 200', todos.status === 200, { status: todos.status, body: todos.body });
  ok('resposta é lista', Array.isArray(data(todos)), typeof data(todos));
  const emAnalise = await req('GET', '/api/super-admin/reembolsos?status=EM_ANALISE', T);
  ok('pedido EM_ANALISE aparece no filtro', data(emAnalise).some(r => r.id === ctx.pedido_id), data(emAnalise));
  ok('PENDENTE_GMAIL NÃO aparece com status=todos', !data(todos).some(r => r.id === ctx.pendente_id),
    data(todos).map(r => r.status));
  ok('PENDENTE_GMAIL NÃO aparece em EM_ANALISE', !data(emAnalise).some(r => r.id === ctx.pendente_id));
  const card = data(emAnalise).find(r => r.id === ctx.pedido_id);
  ok('card traz nome do barbeiro', !!card && !!card.usuario_nome, card && card.usuario_nome);
  ok('card traz chave Pix', !!card && card.temporary_pix_key === '3f2504e0-4f89-41d3-9a0c-0305e82c3301', card && card.temporary_pix_key);
  ok('card traz motivo', !!card && /Teste HTTP/.test(card.motivo || ''), card && card.motivo);
  ok('card traz nome da loja', !!card && card.loja_nome === ctx.loja_nome, card && card.loja_nome);
  ok('card NÃO expõe visible_to_admin', !!card && card.visible_to_admin === undefined);

  secao('3. PUT marca REEMBOLSADO + notificação');
  const antes = await pg.asAdmin(t => t('notifications')
    .where('user_id', ctx.user_id).where('type', 'reembolso').select('id'));
  const put = await req('PUT', '/api/super-admin/reembolso/' + ctx.pedido_id, T, {});
  ok('PUT => 200', put.status === 200, { status: put.status, body: put.body });
  ok('retorna status REEMBOLSADO', data(put).status === 'REEMBOLSADO', data(put));
  ok('sinaliza que a notificação disparou', data(put).notificacao === true, data(put));
  await new Promise(r => setTimeout(r, 2500));
  const depois = await pg.asAdmin(t => t('notifications')
    .where('user_id', ctx.user_id).where('type', 'reembolso').select('*'));
  ok('notificação gravada no banco', depois.length === antes.length + 1, { antes: antes.length, depois: depois.length });
  const notif = depois.find(n => String(n.data || '').indexOf(ctx.pedido_id) >= 0) || depois[depois.length - 1];
  ok('mensagem oficial correta',
    !!notif && notif.message === 'Seu reembolso foi realizado com sucesso! O valor foi transferido para a chave Pix cadastrada.',
    notif && notif.message);
  ok('notificação pertence ao barbeiro do pedido', !!notif && notif.user_id === ctx.user_id);
  const put2 = await req('PUT', '/api/super-admin/reembolso/' + ctx.pedido_id, T, {});
  ok('PUT repetido é idempotente (200, sem nova notificação)', put2.status === 200 && data(put2).notificacao === false, data(put2));
  const dep2 = await pg.asAdmin(t => t('notifications')
    .where('user_id', ctx.user_id).where('type', 'reembolso').select('id'));
  ok('nenhuma notificação duplicada', dep2.length === depois.length, { antes: depois.length, agora: dep2.length });

  secao('4. DELETE = soft delete');
  const del = await req('DELETE', '/api/super-admin/reembolso/' + ctx.pedido_id, T, null);
  ok('DELETE => 200', del.status === 200, { status: del.status, body: del.body });
  ok('devolve visible_to_admin=false', data(del).visible_to_admin === false, data(del));
  /* DB.salvar() é debounced: espera a sincronização chegar ao disco */
  await new Promise(r => setTimeout(r, 4000));
  const linha = await pg.asAdmin(t => t('reembolsos').where('id', ctx.pedido_id).select('*'));
  ok('A LINHA CONTINUA NO BANCO', linha.length === 1, linha.length);
  ok('visible_to_admin=false no disco', linha[0] && linha[0].visible_to_admin === false, linha[0] && linha[0].visible_to_admin);
  ok('status preservado (não regravado)', linha[0] && linha[0].status === 'REEMBOLSADO', linha[0] && linha[0].status);
  ok('chave Pix e motivo preservados', linha[0] && linha[0].temporary_pix_key === '3f2504e0-4f89-41d3-9a0c-0305e82c3301' && /Teste HTTP/.test(linha[0].reason || ''));
  const listar = await req('GET', '/api/super-admin/reembolsos?status=REEMBOLSADO', T);
  ok('não aparece mais na listagem', !data(listar).some(r => r.id === ctx.pedido_id), data(listar).map(r => r.id));
  const putOculto = await req('PUT', '/api/super-admin/reembolso/' + ctx.pedido_id, T, {});
  ok('pedido oculto não pode ser re-marcado => 404', putOculto.status === 404, putOculto.status);

  secao('5. Robustez da rota');
  const ruimPut = await req('PUT', '/api/super-admin/reembolso/nao-e-uuid', T, {});
  ok('PUT id inválido => 4xx (não 500)', ruimPut.status >= 400 && ruimPut.status < 500, ruimPut.status);
  const ruimDel = await req('DELETE', '/api/super-admin/reembolso/nao-e-uuid', T, null);
  ok('DELETE id inválido => 4xx (não 500)', ruimDel.status >= 400 && ruimDel.status < 500, ruimDel.status);
  const inexistente = await req('PUT', '/api/super-admin/reembolso/00000000-0000-4000-8000-000000000000', T, {});
  ok('PUT id válido inexistente => 404', inexistente.status === 404, inexistente.status);
  const vivo = await req('GET', '/api/super-admin/reembolsos?status=todos', T);
  ok('servidor continua respondendo após os erros', vivo.status === 200, vivo.status);
  const semBody = await req('PUT', '/api/super-admin/reembolso/' + ctx.pendente_id, T, {});
  ok('PUT em PENDENTE_GMAIL direto pela rota não é 500', semBody.status < 500, semBody.status);

  /* ---------- limpeza ----------
     O servidor segue rodando com os pedidos na memória; cada DB.salvar()
     dele pode ressuscitar a linha. Por isso a limpeza é repetida até
     estabilizar — o que resta ao final é lixo REAL do teste. */
  let resto = [];
  for (let i = 0; i < 4; i++) {
    await pg.asAdmin(t => t('reembolsos').whereIn('id', [ctx.pedido_id, ctx.pendente_id]).del());
    /* A tabela notifications não guarda o id do reembolso (o extra/data é
       só memória), então o escopo é por janela: mesmo usuário, tipo
       reembolso, criadas desde o início desta execução. Preserva o
       histórico real do dono. */
    await pg.asAdmin(t => t('notifications')
      .where('user_id', ctx.user_id).where('type', 'reembolso')
      .where('created_at', '>=', T0).del());
    await new Promise(r => setTimeout(r, 3000));
    resto = await pg.asAdmin(t => t('reembolsos').whereIn('id', [ctx.pedido_id, ctx.pendente_id]).select('id'));
    if (resto.length === 0) break;
  }
  await pg.asAdmin(t => t('superadmin_sessions').where('token', T).del());
  ok('limpeza: nada sobrou (linhas de teste removidas)', resto.length === 0, resto.map(r => r.id));

  console.log('\n==================================================');
  console.log('  PASSOU: ' + passou + '   FALHOU: ' + falhou);
  console.log('==================================================');
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('\nERRO NO TESTE HTTP:', e && e.stack || e); process.exit(1); });
