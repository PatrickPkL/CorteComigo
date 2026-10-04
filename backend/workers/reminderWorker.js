const { Worker } = require('bullmq');
const { redis } = require('./queue');
const { addEmailJob } = require('./queue');

/* Worker de lembretes (BullMQ). Só roda com Redis disponível.
   Os lembretes de e-mail do dia-a-dia NÃO dependem deste worker:
   server.js chama API.gerarLembretesDe(), que usa o mailer direto. */

const worker = new Worker('reminders', async (job) => {
  const { clientEmail, clientName, serviceName, appointmentDate, appointmentTime, reminderType } = job.data;

  const subject = getSubject(reminderType, serviceName);
  const html = getTemplate(reminderType, { clientName, serviceName, appointmentDate, appointmentTime });

  await addEmailJob({
    to: clientEmail,
    subject,
    html,
  });

  return { sent: true, type: reminderType };
}, {
  connection: redis,
  concurrency: 10,
  limiter: {
    max: 200,
    duration: 60000,
  },
});

function getSubject(type, service) {
  const subjects = {
    '24h': `Lembrete: Seu agendamento de ${service || 'serviço'} é amanhã`,
    '1h': `Lembrete: Seu agendamento de ${service || 'serviço'} começa em 1 hora`,
    'cancelled': `Seu agendamento de ${service || 'serviço'} foi cancelado`,
    'rescheduled': `Seu agendamento de ${service || 'serviço'} foi reagendado`
  };
  return subjects[type] || 'Lembrete do seu agendamento';
}

function getTemplate(type, data) {
  const d = data || {};
  const hora = d.appointmentTime || '';
  const data_ = d.appointmentDate || '';
  const servico = d.serviceName || 'serviço';
  const templates = {
    '24h': `
      <h2>Olá, ${d.clientName || ''}!</h2>
      <p>Lembramos que seu agendamento de <strong>${servico}</strong> é amanhã, dia ${data_} às ${hora}.</p>
      <p>Por favor, chegue com 10 minutos de antecedência.</p>`,
    '1h': `
      <h2>Olá, ${d.clientName || ''}!</h2>
      <p>Seu agendamento de <strong>${servico}</strong> começa em 1 hora (${data_} às ${hora}).</p>
      <p>Estamos te esperando!</p>`,
    'cancelled': `
      <h2>Olá, ${d.clientName || ''}!</h2>
      <p>Seu agendamento de <strong>${servico}</strong> (${data_} às ${hora}) foi cancelado.</p>
      <p>Entre em contato para reagendar.</p>`,
    'rescheduled': `
      <h2>Olá, ${d.clientName || ''}!</h2>
      <p>Seu agendamento de <strong>${servico}</strong> foi reagendado para ${data_} às ${hora}.</p>`
  };
  return templates[type] || `<p>Lembrete sobre ${servico}.</p>`;
}

worker.on('completed', (job) => {
  console.log('[Reminder] Job enviado:', job && job.id);
});

worker.on('failed', (job, err) => {
  console.error('[Reminder] Job falhou:', err && err.message);
});

worker.on('error', (err) => {
  console.error('[Reminder] Erro no worker:', err && err.message);
});

module.exports = worker;