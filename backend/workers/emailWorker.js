const { Worker } = require('bullmq');
const { redis } = require('./queue');
const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const worker = new Worker('emails', async (job) => {
  const { to, subject, html, text, template, templateData } = job.data;

  let emailHtml = html;
  let emailText = text;

  if (template && templateData) {
    emailHtml = renderTemplate(template, templateData);
    emailText = stripHtml(emailHtml);
  }

  const info = await transporter.sendMail({
    from: process.env.EMAIL_FROM || 'noreply@cortecerto.com',
    to,
    subject,
    html: emailHtml,
    text: emailText,
  });

  return { messageId: info.messageId };
}, {
  connection: redis,
  concurrency: 3,
  limiter: {
    max: 50,
    duration: 60000,
  },
});

function renderTemplate(template, data) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] || '');
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

worker.on('completed', (job) => {
  console.log([Email] Job  sent to );
});

worker.on('failed', (job, err) => {
  console.error([Email] Job  failed:, err.message);
});

worker.on('error', (err) => {
  console.error('[Email] Worker error:', err.message);
});

module.exports = worker;
