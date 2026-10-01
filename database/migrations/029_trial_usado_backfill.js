'use strict';
/* ============================================================
   Corte Comigo – 029_trial_usado_backfill.js

   provisionarSalao não gravava trial_usado, e a coluna tem
   DEFAULT FALSE (008_plan_tiers.js). Toda loja criada por lá ficou
   com trial_usado=false mesmo tendo recebido os 10 dias.

   Como assinarComTrial só olha essa flag, o dono de uma dessas lojas
   podia renová-la quantas vezes quisesse: testar 10 dias, esperar
   expirar, pedir outro trial, repetir. Lojas que pagaram também
   tinham a flag falsa e ainda podiam herdá-la depois de um estorno.

   Este backfill sela as lojas que realmente já usaram o trial.
   O que ainda está dentro do período continua legível, mas não
   renovável.
   ============================================================ */

exports.up = async function (knex) {
  /* Marca como usado tudo que já passou por um trial — ativo ou
     encerrado. A única exceção seria uma loja que nunca usou. */
  await knex('subscriptions')
    .where('trial_usado', false)
    .whereNotNull('trial_ends_at')
    .update({ trial_usado: true });

  /* Regressão: loja que pagou e recebeu plano pago tem trial_usado
     zerado, mas o plano_id já não é o Free nem o de prova. Sela também. */
  await knex.raw(`
    UPDATE subscriptions s
       SET trial_usado = TRUE
     WHERE s.trial_usado = FALSE
       AND s.status = 'ativa'
       AND s.current_period_end IS NOT NULL
       AND s.current_period_end <= NOW();
  `);
};

exports.down = async function (knex) {
  /* Irreversível por desenho: reabrir o trial para lojas que já o
     consumiram devolveria dinheiro. O down é intencionalmente no-op. */
};
