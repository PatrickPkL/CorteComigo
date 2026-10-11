'use strict';
/* ============================================================
   Corte Comigo – 026_estorno_arrependimento.js
   Direito de arrependimento (CDC art. 49): reembolso integral em
   até 7 dias corridos da contratação/pagamento.

   Colunas extra na tabela payments para registrar o estorno sem
   tocar no enum pay_status (que permanece 'paid' — o dinheiro foi
   devolvido, mas a cobrança original ainda existiu):
     • refunded_at    – quando o estorno foi processado
     • refund_reason  – motivo (ex.: arrependimento_cdc49)
     • refund_id      – id público do reembolso no Mercado Pago
   ============================================================ */

exports.up = async function (knex) {
  await knex.schema.alterTable('payments', function (table) {
    table.timestamp('refunded_at').nullable();
    table.string('refund_reason', 100).nullable();
    table.string('refund_id', 100).nullable();
  });
};

exports.down = async function (knex) {
  await knex.schema.alterTable('payments', function (table) {
    table.dropColumn('refunded_at');
    table.dropColumn('refund_reason');
    table.dropColumn('refund_id');
  });
};