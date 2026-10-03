'use strict';
const { Queue, QueueScheduler } = require('bullmq');
const { client } = require('./redis');

const connection = {
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: 3,
};

const webhookQueue = new Queue('webhooks', { connection });
const emailQueue = new Queue('emails', { connection });
const reportQueue = new Queue('reports', { connection });
const reminderQueue = new Queue('reminders', { connection });

const scheduler = new QueueScheduler('webhooks', { connection });
const emailScheduler = new QueueScheduler('emails', { connection });
const reportScheduler = new QueueScheduler('reports', { connection });
const reminderScheduler = new QueueScheduler('reminders', { connection });

async function addWebhookJob(data) {
  await webhookQueue.add('process-webhook', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

async function addEmailJob(data) {
  await emailQueue.add('send-email', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
}

async function addReportJob(data) {
  await reportQueue.add('generate-report', data, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 50,
    removeOnFail: 25,
  });
}

async function addReminderJob(data) {
  await reminderQueue.add('send-reminder', data, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 200,
    removeOnFail: 100,
  });
}

module.exports = {
  webhookQueue,
  emailQueue,
  reportQueue,
  reminderQueue,
  addWebhookJob,
  addEmailJob,
  addReportJob,
  addReminderJob,
};
