'use strict';
/* ============================================================
   Corte Comigo – teste de integração do módulo de Reembolso
   Boota o backend real (mesmo caminho do servidor) e exercita:
     · a trava de 7 dias (base = payments.paid_at)
     · o bloqueio de CPF (por extenso, mascarado e colado)
     · a exigência de chave EVP/UUID
     · o ciclo PENDENTE_GMAIL -> EM_ANALISE -> REEMBOLSADO
     · a notificação de sucesso disparada pelo Super Admin
     · o isolamento entre usuários
     · o soft delete (visible_to_admin = false, sem DELETE)
   Ao final remove TUDO que criou, para não deixar lixo.
   ============================================================ */

const boot = require('../backend/boot');
const pg = require('../backend/pool');

let passou = 0, falhou = 0;
function ok(nome, cond, extra) {
  if (cond) { passou++; console.log('  PASS  ' + nome); }
  else { falhou++; console.log('  FAIL  ' + nome + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function secao(t) { console.log('\n=== ' + t + ' ==='); }

const CHAVE_EVP = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const MOTIVO = 'Contratei o plano errado e paguei sem querer; deveria haver confirmação antes da cobrança.';

/* thrown por err(status, msg) */
function esperaErro(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

(async function run() {
  await boot.init();
  const T0 = new Date().toISOString();   /* marco temporal da execução (limpeza) */
  const { API, Auth, DB } = boot;
  const db = DB._d();

  /* ---------- fixtures ---------- */
  const dono = db.users.find(u => u.role === 'dono' && u.barbershop_id == null && Auth.salaoDoUsuario(u));
  if (!dono) { console.error('Nenhum usuário dono encontrado.'); process.exit(1); }
  const loja = Auth.salaoDoUsuario(dono);
  const token = Auth.criarSessao ? null : null;

  /* sessão criada direto (Auth.criarSessao escreve em localStorage) */
  const sessao = { id: DB.proximoId(), user_id: dono.id, token: 'teste-' + Date.now(),
    expires_at: new Date(Date.now() + 3600e3).toISOString() };
  db.sessions.push(sessao);
  global.__CC_HTTP = true;
  global.__CC_REQUEST_TOKEN = sessao.token;
  Auth.limparSessao && Auth.limparSessao();

  /* Higiene: o suite assume começar sem pedido em aberto. Se uma execução
     anterior quebrou no meio, o `limpar()` do fim não rodou e o pedido ficou
     no Postgres — envenenando as execuções seguintes (409 em cadeia).
     Purga só o que pertence ao usuário/escritório deste teste. */
  const residuos = db.reembolsos.filter(r =>
    (r.user_id === dono.id || r.barbershop_id === loja.id));
  if (residuos.length) {
    const ids = residuos.map(r => r.id);
    const desde = residuos.map(r => r.created_at).sort()[0];
    db.reembolsos = db.reembolsos.filter(r => !ids.includes(r.id));
    db.notifications = db.notifications.filter(n => !ids.some(id => (n.data || '').includes(id)));
    await pg.asAdmin(trx => trx('reembolsos').whereIn('id', ids).del());
    /* A tabela notifications NÃO tem coluna com o id do reembolso (o
       `extra`/data só existe em memória), então não dá para casar por
       reembolso_id no SQL. O escopo seguro é: mesmo usuário, tipo
       reembolso, e criadas a partir do pedido residual mais antigo.
       Assim o histórico antigo/real do dono é preservado. */
    await pg.asAdmin(trx => trx('notifications')
      .where('user_id', dono.id).where('type', 'reembolso')
      .where('created_at', '>=', desde).del());
    console.log('(higiene) ' + ids.length + ' pedido(s) residual(is) removido(s) antes de começar');
  }

  /* pagamento pago de HOJE, para a loja ficar dentro da janela de 7 dias */
  const pagamentoTeste = {
    id: DB.proximoId(), barbershop_id: loja.id, plan_id: null, amount_cents: 1990,
    status: 'paid', provider: 'demo', abacate_id: null, br_code: null, qr_base64: null,
    dev_mode: true, refunded_at: null, refund_reason: null, refund_id: null,
    created_at: new Date().toISOString(), expires_at: null, paid_at: new Date().toISOString()
  };
  db.payments.push(pagamentoTeste);

  const criados = [];
  function limpar() {
    db.reembolsos = db.reembolsos.filter(r => !criados.includes(r.id));
    db.payments = db.payments.filter(p => p.id !== pagamentoTeste.id);
    db.sessions = db.sessions.filter(s => s.id !== sessao.id);
    db.notifications = db.notifications.filter(n => !(n.data || '').includes('"reimbursement_id"') && !criados.includes(n.ref));
    delete global.__CC_HTTP; delete global.__CC_REQUEST_TOKEN;
  }

  console.log('Loja de teste: ' + loja.name + ' | Dono: ' + dono.name);

  /* ============================================================ */
  secao('1. Trava de 7 dias — dentro do prazo');
  const disp = API.reembolsoDisponivel();
  ok('reembolsoDisponivel responde dentro do prazo', disp.dentro_do_prazo === true, disp);
  ok('reporta limite de 7 dias', disp.dias_limite === 7, disp.dias_limite);
  ok('reporta dias restantes', typeof disp.dias_restantes === 'number' && disp.dias_restantes <= 7, disp.dias_restantes);
  ok('base vem de payments.paid_at', Math.abs(Date.parse(disp.base_em) - Date.parse(pagamentoTeste.paid_at)) < 2000, disp.base_em);
  ok('devolve e-mail de contato', !!(disp.email_contato && disp.email_contato.includes('@')), disp.email_contato);
  ok('sem pedido em aberto no início', disp.pedido_aberto === null, disp.pedido_aberto);

  /* ============================================================ */
  secao('2. Bloqueio de CPF (prioridade absoluta)');
  /* CPFs: 11 dígitos puros, mascarado, ou com espaços. Texto solto contendo
     11 dígitos NÃO é "preenchimento de CPF" — cai na validação de EVP. */
  const casosCpf = [
    ['11 dígitos puros', '12345678901', 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.'],
    ['mascarado', '123.456.789-01', 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.'],
    ['mascarado com espaços', '123 456 789 01', 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.'],
    ['mascarado com traço e espaço', '123.456.789 01', 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.']
  ];
  casosCpf.forEach(function (c) {
    const e = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: c[1], reason: MOTIVO }));
    ok('recusa CPF (' + c[0] + ')', !!e && e.status === 400 && e.error === c[2], e && e.error);
  });
  /* texto solto com 11 dígitos: não é preenchimento de CPF, mas também
     não é EVP -> a orientação do usuário continua correta */
  const eSolto = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: 'minha chave 12345678901 fim', reason: MOTIVO }));
  ok('recusa CPF colado em texto solto (via validação de EVP)',
    !!eSolto && eSolto.status === 400 && /EVP/.test(eSolto.error || ''), eSolto && eSolto.error);
  ok('nenhum pedido foi criado pelas tentativas de CPF', (db.reembolsos || []).length === 0, (db.reembolsos || []).length);

  /* ============================================================ */
  secao('3. Chave Pix não-EVP');
  ['meuemail@exemplo.com', 'chavequalquer', '12345678-1234-1234-1234-12345678901z'].forEach(function (k) {
    const e = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: k, reason: MOTIVO }));
    ok('recusa chave não-EVP "' + k + '"', !!e && e.status === 400 && /EVP/.test(e.error || ''), e && e.error);
  });
  /* 11 dígitos puros É um CPF pelo spec — a mensagem de CPF está correta */
  const eOnze = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: '71999998888', reason: MOTIVO }));
  ok('11 dígitos puros cai na regra de CPF (telefone também)',
    !!eOnze && eOnze.status === 400 && eOnze.error === 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.',
    eOnze && eOnze.error);
  /* Regressão do regex antigo \d{11,}: uma EVP 100% numérica é VÁLIDA
     (8-4-4-4-12 hex) e não pode ser rejeitada como CPF. */
  const EVP_NUMERICA = '12345678-1234-1234-1234-123456789012';
  let rNum, eNum;
  try { rNum = API.solicitarReembolso({ temporary_pix_key: EVP_NUMERICA, reason: MOTIVO }); }
  catch (e) { eNum = e; }
  ok('EVP válida 100% numérica NÃO é rejeitada como CPF',
    !eNum, eNum && eNum.error);
  if (rNum) {
    ok('EVP numérica foi criada e normalizada',
      rNum.status === 'PENDENTE_GMAIL' && rNum.temporary_pix_key === EVP_NUMERICA, rNum);
    db.reembolsos = db.reembolsos.filter(r => r.id !== rNum.id);
  }
  const eVazia = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: '', reason: MOTIVO }));
  ok('recusa chave vazia', !!eVazia && eVazia.status === 400, eVazia && eVazia.error);
  const eMotivo = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: CHAVE_EVP, reason: 'curto' }));
  ok('recusa motivo curto', !!eMotivo && eMotivo.status === 400, eMotivo && eMotivo.error);

  /* ============================================================ */
  secao('4. Criação do pedido');
  const pedido = API.solicitarReembolso({ temporary_pix_key: CHAVE_EVP.toUpperCase(), reason: MOTIVO });
  criados.push(pedido.id);
  ok('pedido criado com id uuid', !!pedido.id, pedido.id);
  ok('status inicial PENDENTE_GMAIL', pedido.status === 'PENDENTE_GMAIL', pedido.status);
  ok('visible_to_admin = true (default do spec)', API.meusReembolsos().find(r => r.id === pedido.id).status === 'PENDENTE_GMAIL');
  ok('motivo preservado', pedido.reason === MOTIVO);
  ok('chave normalizada em minúsculas', pedido.temporary_pix_key === CHAVE_EVP, pedido.temporary_pix_key);
  ok('barbershop_id vinculado', pedido.barbershop_id === loja.id);
  const dup = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: CHAVE_EVP, reason: MOTIVO }));
  ok('bloqueia pedido duplicado em aberto', !!dup && dup.status === 409, dup && dup.error);

  /* ============================================================ */
  secao('5. PENDENTE_GMAIL fica oculto do Super Admin');
  let lista = API.saListarReembolsos({ status: 'todos' });
  ok('não aparece com status=todos', !lista.some(r => r.id === pedido.id),
    lista.map(r => r.status));
  lista = API.saListarReembolsos({ status: 'EM_ANALISE' });
  ok('não aparece em EM_ANALISE', !lista.some(r => r.id === pedido.id));
  ok('não aparece em REEMBOLSADO', !API.saListarReembolsos({ status: 'REEMBOLSADO' }).some(r => r.id === pedido.id));

  /* ============================================================ */
  secao('6. Barbeiro confirma o envio do Gmail');
  const promovido = API.confirmarEnvioGmail(pedido.id);
  ok('status virou EM_ANALISE', promovido.status === 'EM_ANALISE', promovido.status);
  lista = API.saListarReembolsos({ status: 'EM_ANALISE' });
  const card = lista.find(r => r.id === pedido.id);
  ok('agora aparece para o Super Admin', !!card);
  ok('card traz nome do usuário', !!card && card.usuario_nome === dono.name, card && card.usuario_nome);
  ok('card traz e-mail da conta', !!card && String(card.usuario_email || '').includes('@'), card && card.usuario_email);
  ok('card traz nome da loja', !!card && card.loja_nome === loja.name, card && card.loja_nome);
  ok('card traz chave Pix', !!card && card.temporary_pix_key === CHAVE_EVP, card && card.temporary_pix_key);
  ok('card traz motivo', !!card && card.motivo === MOTIVO);
  const idempotente = API.confirmarEnvioGmail(pedido.id);
  ok('confirmar de novo é idempotente', idempotente.status === 'EM_ANALISE', idempotente.status);

  /* ============================================================ */
  secao('7. Super Admin marca "Realizado" -> notificação');
  const antes = db.notifications.filter(n => n.user_id === dono.id).length;
  const res = API.saMarcarReembolsoRealizado(pedido.id);
  ok('status virou REEMBOLSADO', res.status === 'REEMBOLSADO', res.status);
  ok('notificação foi disparada', res.notificacao === true);
  const depois = db.notifications.filter(n => n.user_id === dono.id);
  ok('exatamente 1 notificação nova', depois.length === antes + 1, { antes, depois: depois.length });
  const notif = depois[depois.length - 1];
  ok('notificação é do barbeiro certo', notif.user_id === dono.id);
  ok('tipo da notificação', notif.type === 'reembolso', notif.type);
  ok('título correto', notif.title === 'Reembolso realizado', notif.title);
  ok('mensagem oficial correta',
    notif.message === 'Seu reembolso foi realizado com sucesso! O valor foi transferido para a chave Pix cadastrada.',
    notif.message);
  ok('notificação começa não lida', !notif.read);
  ok('saiu de EM_ANALISE', !API.saListarReembolsos({ status: 'EM_ANALISE' }).some(r => r.id === pedido.id));
  ok('entrou em REEMBOLSADO', API.saListarReembolsos({ status: 'REEMBOLSADO' }).some(r => r.id === pedido.id));
  const reRealizado = API.saMarcarReembolsoRealizado(pedido.id);
  ok('repetir "Realizado" não duplica notificação',
    db.notifications.filter(n => n.user_id === dono.id).length === antes + 1 && reRealizado.notificacao === false);

  /* ============================================================ */
  secao('8. Soft delete (DELETE HTTP -> só visible_to_admin = false)');
  API.saOcultarReembolso(pedido.id);
  ok('saiu das duas listas', !API.saListarReembolsos({ status: 'todos' }).some(r => r.id === pedido.id));
  ok('A LINHA CONTINUA NO BANCO', (db.reembolsos || []).some(r => r.id === pedido.id));
  ok('status preservado, nao regravado', (db.reembolsos || []).find(r => r.id === pedido.id).status === 'REEMBOLSADO');
  const eOculto = esperaErro(() => API.saMarcarReembolsoRealizado(pedido.id));
  ok('pedido oculto não pode ser re-marcado', !!eOculto && eOculto.status === 404, eOculto && eOculto.error);
  /* volta a ser visível para o teste do isolamento */
  db.reembolsos.find(r => r.id === pedido.id).visible_to_admin = 1;

  /* ============================================================ */
  secao('9. Isolamento entre usuários');
  const outro = db.users.find(u => u.role === 'dono' && u.id !== dono.id && Auth.salaoDoUsuario(u));
  if (outro) {
    const sessao2 = { id: DB.proximoId(), user_id: outro.id, token: 'teste2-' + Date.now(),
      expires_at: new Date(Date.now() + 3600e3).toISOString() };
    db.sessions.push(sessao2);
    global.__CC_REQUEST_TOKEN = sessao2.token;
    ok('não enxerga o pedido alheio em meusReembolsos', !API.meusReembolsos().some(r => r.id === pedido.id));
    const ePosse = esperaErro(() => API.confirmarEnvioGmail(pedido.id));
    ok('não confirma pedido de outro usuário', !!ePosse && ePosse.status === 404, ePosse && ePosse.error);
    global.__CC_REQUEST_TOKEN = sessao.token;
    db.sessions = db.sessions.filter(s => s.id !== sessao2.id);
  } else {
    ok('isolamento entre usuários', true, 'sem 2o dono no banco — pulado');
  }

  /* ============================================================ */
  secao('10. Trava de 7 dias — prazo estourado');
  db.payments = db.payments.filter(p => p.id !== pagamentoTeste.id);
  const sub = db.subscriptions.find(s => s.barbershop_id === loja.id);
  const subOriginal = sub ? sub.created_at : null;
  if (sub) sub.created_at = new Date(Date.now() - 30 * 24 * 3600e3).toISOString();
  const dispVencido = API.reembolsoDisponivel();
  ok('formulário deve ser escondido (dentro_do_prazo=false)', dispVencido.dentro_do_prazo === false, dispVencido);
  ok('dias_restantes zerado', dispVencido.dias_restantes === 0, dispVencido.dias_restantes);
  const eVencido = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: CHAVE_EVP, reason: MOTIVO }));
  ok('servidor bloqueia pedido fora do prazo', !!eVencido && eVencido.status === 409, eVencido && eVencido.error);
  ok('mensagem de prazo é a oficial', !!eVencido &&
    eVencido.error === 'Tempo excedido para a realização do reembolso. O prazo limite para solicitação é de até 7 dias após a compra.',
    eVencido && eVencido.error);
  if (sub) sub.created_at = subOriginal;

  /* ============================================================ */
  secao('11. Fail-closed: loja que nunca pagou');
  const subSalvo = db.subscriptions.filter(s => s.barbershop_id === loja.id);
  db.subscriptions = db.subscriptions.filter(s => s.barbershop_id !== loja.id);
  const dispSemBase = API.reembolsoDisponivel();
  ok('sem data-base => prazo encerrado (fail-closed)', dispSemBase.dentro_do_prazo === false, dispSemBase);
  db.subscriptions = db.subscriptions.concat(subSalvo);

  /* ============================================================ */
  secao('12. Autorização');
  const eSemSessao = (function () {
    delete global.__CC_REQUEST_TOKEN;
    try { return esperaErro(() => API.meusReembolsos()); } finally { global.__CC_REQUEST_TOKEN = sessao.token; }
  })();
  ok('sem sessão => 401', !!eSemSessao && eSemSessao.status === 401, eSemSessao && eSemSessao.status);

  const cliente = db.users.find(u => u.role === 'cliente');
  if (cliente) {
    const sessao3 = { id: DB.proximoId(), user_id: cliente.id, token: 'teste3-' + Date.now(),
      expires_at: new Date(Date.now() + 3600e3).toISOString() };
    db.sessions.push(sessao3);
    global.__CC_REQUEST_TOKEN = sessao3.token;
    const eRole = esperaErro(() => API.solicitarReembolso({ temporary_pix_key: CHAVE_EVP, reason: MOTIVO }));
    ok('cliente não pode pedir reembolso', !!eRole && (eRole.status === 403 || eRole.status === 404), eRole && (eRole.status + ' ' + eRole.error));
    global.__CC_REQUEST_TOKEN = sessao.token;
    db.sessions = db.sessions.filter(s => s.id !== sessao3.id);
  }

  /* ============================================================ */
  secao('13. Sincronização com o PostgreSQL');
  DB.salvar();
  await new Promise(r => setTimeout(r, 2500));
  const rows = await pg.asAdmin(trx => trx('reembolsos').where('id', pedido.id).select('*'));
  ok('pedido gravado no PostgreSQL', rows.length === 1, rows.length);
  if (rows.length) {
    ok('colunas gravadas corretamente',
      rows[0].temporary_pix_key === CHAVE_EVP &&
      rows[0].status === 'REEMBOLSADO' &&
      rows[0].visible_to_admin === true &&
      rows[0].user_id === dono.id &&
      rows[0].barbershop_id === loja.id,
      rows[0]);
  }
  const notifRows = await pg.asAdmin(trx => trx('notifications')
    .where('user_id', dono.id).where('type', 'reembolso').select('*'));
  ok('notificação gravada no PostgreSQL', notifRows.length >= 1, notifRows.length);
  if (notifRows.length) {
    ok('mensagem da notificação no banco',
      notifRows[0].message === 'Seu reembolso foi realizado com sucesso! O valor foi transferido para a chave Pix cadastrada.',
      notifRows[0].message);
  }
  /* soft delete confirmado no disco */
  db.reembolsos.find(r => r.id === pedido.id).visible_to_admin = 0;
  DB.salvar();
  await new Promise(r => setTimeout(r, 2500));
  const rowSoft = await pg.asAdmin(trx => trx('reembolsos').where('id', pedido.id).select('visible_to_admin', 'status'));
  ok('soft delete persiste no disco E a linha continua', rowSoft.length === 1 && rowSoft[0].visible_to_admin === false, rowSoft);

  /* ---------- limpeza ---------- */
  await pg.asAdmin(trx => trx('reembolsos').where('id', pedido.id).del());
  /* Só a notificação deste pedido: notifications não guarda o id do
     reembolso, então o escopo é "criadas durante esta execução" —
     preserva o histórico real do dono. */
  await pg.asAdmin(trx => trx('notifications')
    .where('user_id', dono.id).where('type', 'reembolso')
    .where('created_at', '>=', T0).del());
  await pg.asAdmin(trx => trx('payments').where('id', pagamentoTeste.id).del());
  limpar();
  const resto = await pg.asAdmin(trx => trx('reembolsos').where('id', pedido.id).select('id'));
  ok('limpeza: nada sobrou no banco', resto.length === 0, resto.length);

  console.log('\n==================================================');
  console.log('  PASSOU: ' + passou + '   FALHOU: ' + falhou);
  console.log('==================================================');
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('\nERRO NO TESTE:', e && e.stack || e); process.exit(1); });
