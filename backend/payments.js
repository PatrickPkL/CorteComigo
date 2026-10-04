/* Fila de webhook (BullMQ + Redis).
   O Redis é OPCIONAL: hospedagem compartilhada (Hostinger) não tem Redis
   gerenciado, e exigir `require('bullmq')` no boot matava o processo
   inteiro — o app devolvia 503 sem chegar a carregar o backend.
   Sem Redis o app sobe normalmente e os webhooks ficam sem fila (nenhum
   chamador no runtime depende disso hoje; o webhook de PIX é tratado
   direto por server.js -> handleWebhookAbacate). */

let webhookQueue = null;
let motivoIndisponivel = null;

try {
  const { Queue } = require('bullmq');
  webhookQueue = new Queue('webhooks', {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: Number(process.env.REDIS_PORT || 6379),
    },
  });
} catch (e) {
  motivoIndisponivel = (e && (e.message || e.code)) || String(e);
  webhookQueue = null;
}

const disponivel = !!webhookQueue;

if (!disponivel) {
  console.warn('[fila] BullMQ/Redis indisponível (' + motivoIndisponivel +
    ') — webhooks sem fila. O app continua operando.');
}

async function addWebhookJob(url, payload, options = {}) {
  if (!webhookQueue) {
    return { ok: false, enfileirado: false, motivo: 'fila indisponível' };
  }
  return webhookQueue.add('webhook', { url, payload }, {
    attempts: options.attempts || 3,
    backoff: options.backoff || { type: 'exponential', delay: 1000 },
    removeOnComplete: options.removeOnComplete ?? true,
    removeOnFail: options.removeOnFail ?? false,
    ...options,
  });
}

module.exports = { webhookQueue, addWebhookJob, disponivel };
