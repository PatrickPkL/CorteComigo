const { Queue } = require('bullmq');
const { Redis } = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 100, 3000),
});

const defaultJobOptions = {
  removeOnComplete: 100,
  removeOnFail: 500,
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,
  },
};

const webhooksQueue = new Queue('webhooks', { connection: redis, defaultJobOptions });
const emailsQueue = new Queue('emails', { connection: redis, defaultJobOptions });
const reportsQueue = new Queue('reports', { connection: redis, defaultJobOptions });
const remindersQueue = new Queue('reminders', { connection: redis, defaultJobOptions });

async function addWebhookJob(data, options = {}) {
  return webhooksQueue.add('process-webhook', data, {
    ...defaultJobOptions,
    ...options,
  });
}

async function addEmailJob(data, options = {}) {
  return emailsQueue.add('send-email', data, {
    ...defaultJobOptions,
    ...options,
  });
}

async function addReportJob(data, options = {}) {
  return reportsQueue.add('generate-report', data, {
    ...defaultJobOptions,
    ...options,
  });
}

async function addReminderJob(data, options = {}) {
  return remindersQueue.add('send-reminder', data, {
    ...defaultJobOptions,
    ...options,
  });
}

async function closeQueues() {
  await Promise.all([
    webhooksQueue.close(),
    emailsQueue.close(),
    reportsQueue.close(),
    remindersQueue.close(),
    redis.quit(),
  ]);
}

module.exports = {
  redis,
  webhooksQueue,
  emailsQueue,
  reportsQueue,
  remindersQueue,
  addWebhookJob,
  addEmailJob,
  addReportJob,
  addReminderJob,
  closeQueues,
};
