'use strict';
/* ============================================================
   Corte Comigo – 031_mercadopago.js

   Migração do gateway de pagamentos: AbacatePay → Mercado Pago.

   A coluna `payments.abacate_id` guardava o id da cobrança no
   AbacatePay. Passa a se chamar `provider_id` (o id do pagamento
   pode vir do Mercado Pago). É um RENAME: os valores já gravados
   são preservados.

   Idempotente: só renomeia se a coluna antiga existir e a nova
   ainda não existir.
   ============================================================ */

exports.up = async function (knex) {
  const temAntiga = await knex.schema.hasColumn('payments', 'abacate_id');
  const temNova = await knex.schema.hasColumn('payments', 'provider_id');
  if (temAntiga && !temNova) {
    await knex.schema.alterTable('payments', function (table) {
      table.renameColumn('abacate_id', 'provider_id');
    });
  } else if (!temAntiga && !temNova) {
    await knex.schema.alterTable('payments', function (table) {
      table.string('provider_id', 100).nullable();
    });
  }
};

exports.down = async function (knex) {
  const temNova = await knex.schema.hasColumn('payments', 'provider_id');
  const temAntiga = await knex.schema.hasColumn('payments', 'abacate_id');
  if (temNova && !temAntiga) {
    await knex.schema.alterTable('payments', function (table) {
      table.renameColumn('provider_id', 'abacate_id');
    });
  }
};
