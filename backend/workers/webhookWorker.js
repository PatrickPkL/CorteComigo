const { Worker } = require('bullmq');
const { redis } = require('./queue');
const crypto = require('crypto');

const worker = new Worker('webhooks', async (job) => {
  const { payload, signature, timestamp } = job.data;

  const secret = process.env.ABACATEPAY_WEBHOOK_SECRET;
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(${timestamp}.)
    .digest('hex');

  if (signature !== expectedSignature) {
    throw new Error('Invalid webhook signature');
  }

  switch (payload.event) {
    case 'pix.payment.received':
      await handlePixPaymentReceived(payload.data);
      break;
    case 'pix.payment.expired':
      await handlePixPaymentExpired(payload.data);
      break;
    case 'billing.subscription.created':
      await handleSubscriptionCreated(payload.data);
      break;
    case 'billing.subscription.cancelled':
      await handleSubscriptionCancelled(payload.data);
      break;
    default:
      console.warn([Webhook] Unhandled event: );
  }

  return { processed: true, event: payload.event };
}, {
  connection: redis,
  concurrency: 5,
  limiter: {
    max: 100,
    duration: 60000,
  },
});

async function handlePixPaymentReceived(data) {
  console.log('[Webhook] PIX payment received:', data.id);
}

async function handlePixPaymentExpired(data) {
  console.log('[Webhook] PIX payment expired:', data.id);
}

async function handleSubscriptionCreated(data) {
  console.log('[Webhook] Subscription created:', data.id);
}

async function handleSubscriptionCancelled(data) {
  console.log('[Webhook] Subscription cancelled:', data.id);
}

worker.on('completed', (job) => {
  console.log([Webhook] Job  completed);
});

worker.on('failed', (job, err) => {
  console.error([Webhook] Job  failed:, err.message);
});

worker.on('error', (err) => {
  console.error('[Webhook] Worker error:', err.message);
});

module.exports = worker;
