const { Queue } = require('bullmq');

const webhookQueue = new Queue('webhooks', {
  connection: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  },
});

async function addWebhookJob(url, payload, options = {}) {
  return webhookQueue.add('webhook', { url, payload }, {
    attempts: options.attempts || 3,
    backoff: options.backoff || { type: 'exponential', delay: 1000 },
    removeOnComplete: options.removeOnComplete ?? true,
    removeOnFail: options.removeOnFail ?? false,
    ...options,
  });
}

module.exports = { webhookQueue, addWebhookJob };
