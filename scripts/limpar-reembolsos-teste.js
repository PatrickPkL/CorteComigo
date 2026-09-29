'use strict';
/* ============================================================================
 *  ATENÇÃO — SCRIPT DESTRUTIVO. NÃO RODE EM PRODUÇÃO.
 *
 *  Este arquivo apaga TODOS os pedidos de reembolso da tabela, sem nenhum
 *  filtro: `trx('reembolsos').del()`. Isso inclui pedidos reais de salões,
 *  não só os de teste. Em produção isso é perda de dado sem volta.
 *
 *  COMO USAR
 *    Simulação (padrão, não apaga nada):
 *      node scripts/limpar-reembolsos-teste.js
 *    Executar de verdade:
 *      node scripts/limpar-reembolsos-teste.js --executar
 *
 *  A simulação lista o que seria apagado e sai com código 0. Só a flag
 *  --executar habilita a remoção — rodar sem ela não causa nenhum dano.
 * ========================================================================== */
const pg = require('../backend/pool');

const EXECUTAR = process.argv.includes('--executar');

(async () => {
  if (!EXECUTAR) {
    console.log('*** MODO SIMULAÇÃO — nada será apagado. ***');
    console.log('Para apagar de verdade, rode com --executar.\n');
  }

  const antes = await pg.asAdmin(t => t('reembolsos').select('id', 'status', 'visible_to_admin'));
  console.log('Pedidos encontrados: ' + antes.length);
  antes.forEach(r => console.log('  ' + r.status + ' | visivel=' + r.visible_to_admin + ' | ' + r.id));

  const notif = await pg.asAdmin(t => t('notifications').where('type', 'reembolso').count('* as total').first());
  const saTest = await pg.asAdmin(t => t('superadmin_sessions').where('token', 'like', 'sa-%teste-%').orWhere('token', 'like', 'sa-nav-%').count('* as total').first());
  const payFx = await pg.asAdmin(t => t('payments').where('abacate_id', 'like', '__NAV_REEMB_%').count('* as total').first());
  const sessNav = await pg.asAdmin(t => t('sessions').where('token', 'like', '__NAV_SESS_%').orWhere('token', 'like', 'teste-%').count('* as total').first());

  console.log('\nResumo do que seria removido:');
  console.log('  pedidos de reembolso ..... ' + antes.length + '  (TODOS, sem filtro)');
  console.log('  notificações reembolso ... ' + Number(notif.total));
  console.log('  sessões SA de teste ...... ' + Number(saTest.total));
  console.log('  pagamentos de fixture .... ' + Number(payFx.total));
  console.log('  sessões de teste ......... ' + Number(sessNav.total));

  if (!EXECUTAR) {
    console.log('\nSimulação concluída. Nada foi apagado.');
    process.exit(0);
  }

  console.log('\n--- EXECUTANDO REMOÇÃO ---');
  if (antes.length) {
    await pg.asAdmin(t => t('reembolsos').del());
    console.log('>> ' + antes.length + ' pedido(s) removido(s).');
  }
  const n = await pg.asAdmin(t => t('notifications').where('type', 'reembolso').del());
  console.log('Notificações de reembolso removidas: ' + n);
  const s = await pg.asAdmin(t => t('superadmin_sessions').where('token', 'like', 'sa-http-teste-%').del());
  console.log('Sessões SA de teste removidas: ' + s);
  const sn = await pg.asAdmin(t => t('superadmin_sessions').where('token', 'like', 'sa-nav-%').del());
  console.log('Sessões SA de navegador removidas: ' + sn);

  /* Pagamentos de fixture dos testes. Sem isto, um pagamento pago "hoje" do
     teste de navegador mantém a loja dentro da janela de 7 dias e faz o
     suite de prazo (seção 10/11) falhar mesmo com o código correto. */
  const pay = await pg.asAdmin(t => t('payments').where('abacate_id', 'like', '__NAV_REEMB_%').del());
  console.log('Pagamentos de fixture (browser) removidos: ' + pay);
  const sess = await pg.asAdmin(t => t('sessions').where('token', 'like', '__NAV_SESS_%').del());
  console.log('Sessões de navegador removidas: ' + sess);
  const tst = await pg.asAdmin(t => t('sessions').where('token', 'like', 'teste-%').del());
  console.log('Sessões de teste (teste-%) removidas: ' + tst);

  const resto = await pg.asAdmin(t => t('reembolsos').select('id'));
  console.log('Restaram (reembolsos): ' + resto.length);
  const restoPay = await pg.asAdmin(t => t('payments').where('abacate_id', 'like', '__NAV_REEMB_%').select('id'));
  console.log('Restaram (pagamentos de fixture): ' + restoPay.length);
  process.exit(0);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
