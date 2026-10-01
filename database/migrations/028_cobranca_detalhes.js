'use strict';
/* ============================================================
   Corte Comigo – 028_cobranca_detalhes.js

   O código de cobrança já lia e gravava billing_period, installments
   e metodo, mas a tabela payments nunca teve essas colunas. No
   PostgreSQL elas sumiam a cada leitura, então:

     • Number(p.billing_period || 30) caía sempre em 30 dias
       → um plano anual de 365 dias virava 30 ao reiniciar o servidor;
     • a busca de cobrança pendente reutilizável
       (payments.js montarCobranca) comparava 365 com undefined e
       nunca encontrava a cobrança, gerando duplicata a cada clique;
     • o parcelamento anual (12×) era perdido.

   Estas colunas fecham o ciclo. O backfill infere 30 dias (mensal)
   para as cobranças antigas, que são as únicas que já existiam.
   ============================================================ */

exports.up = async function (knex) {
  await knex.schema.alterTable('payments', function (table) {
    table.integer('billing_period').nullable().defaultTo(30);
    table.integer('installments').nullable().defaultTo(1);
    table.string('metodo', 20).nullable().defaultTo('pix');
  });

  /* Cobre o período anterior à migração com o padrão correto do código. */
  await knex('payments')
    .whereNull('billing_period')
    .update({ billing_period: 30 });
  await knex('payments')
    .whereNull('installments')
    .update({ installments: 1 });
  await knex('payments')
    .whereNull('metodo')
    .update({ metodo: 'pix' });

  /* Impede duas cobranças pendentes idênticas na mesma loja/plano/período.
    -mountarCobranca já filtra antes de criar; isto cobre concorrência. */
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS payments_pendente_unico
      ON payments (barbershop_id, plan_id, billing_period, installments, metodo)
      WHERE status = 'pending';
  `);
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS payments_pendente_unico;');
  await knex.schema.alterTable('payments', function (table) {
    table.dropColumn('billing_period');
    table.dropColumn('installments');
    table.dropColumn('metodo');
  });
};
