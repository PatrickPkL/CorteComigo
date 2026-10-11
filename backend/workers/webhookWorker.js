const { Worker } = require('bullmq');
const { redis } = require('./queue');
const crypto = require('crypto');

/* Worker de webhooks (BullMQ). Só roda se houver Redis: a hospedagem
   compartilhada não tem Redis gerenciado e nada no boot carrega este
   arquivo — o webhook de PIX do Mercado Pago é tratado direto por
   server.js (que valida o header x-signature). */

const SEGREDO = () => String(process.env.MERCADOPAGO_WEBHOOK_SECRET || '');

/* Comparação em tempo constante: `!` simples vaza informação por
   timing e rejeitava assinatura válida por erro de codificação. */
function assinaturaValida(recebido, timestamp, payload) {
  const segredo = SEGREDO();
  if (!segredo || !recebido) return false;
  const esperada = crypto
    .createHmac('sha256', segredo)
    .update(`${timestamp}.${JSON.stringify(payload)}`)
    .digest('hex');
  const a = Buffer.from(String(recebido), 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

const worker = new Worker('webhooks', async (job) => {
  const { payload, signature, timestamp } = job.data;

  if (!assinaturaValida(signature, timestamp, payload)) {
    throw new Error('Assinatura de webhook inválida');
  }

  switch (payload.type || payload.event) {
    case 'payment':
      await handlePayment(payload.data);
      break;
    default:
      console.warn('[Webhook] Evento não tratado:', payload && (payload.type || payload.event));
  }

  return { processed: true, event: payload.type || payload.event };
}, {
  connection: redis,
  concurrency: 5,
  limiter: {
    max: 100,
    duration: 60000,
  },
});

async function handlePayment(data) {
  console.log('[Webhook] Pagamento recebido:', data && data.id);
}

worker.on('completed', (job) => {
  console.log('[Webhook] Job concluído:', job && job.id);
});

worker.on('failed', (job, err) => {
  console.error('[Webhook] Job falhou:', err && err.message);
});

worker.on('error', (err) => {
  console.error('[Webhook] Erro no worker:', err && err.message);
});

module.exports = worker;