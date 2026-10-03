const { Worker } = require('bullmq');
const { redis } = require('./queue');
const { addEmailJob } = require('./queue');

const worker = new Worker('reminders', async (job) => {
  const { appointmentId, clientEmail, clientName, serviceName, appointmentDate, appointmentTime, reminderType } = job.data;

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
    '24h': Lembrete: Seu agendamento de  e amanha,
    '1h': Lembrete: Seu agendamento de  comeca em 1 hora,
    'cancelled': Seu agendamento de  foi cancelado,
    'rescheduled': Seu agendamento de  foi reagendado,
  };
  return subjects[type] || Lembrete: ;
}

function getTemplate(type, data) {
  const templates = {
    '24h': 
      <h2>Ola, !</h2>
      <p>Lembramos que seu agendamento de <strong></strong> e amanha, dia  as .</p>
      <p>Por favor, chegue com 10 minutos de antecedencia.</p>
    ,
    '1h': 
      <h2>Ola, !</h2>
      <p>Seu agendamento de <strong></strong> comeca em 1 hora ( as ).</p>
      <p>Estamos te esperando!</p>
    ,
    'cancelled': 
      <h2>Ola, !</h2>
      <p>Seu agendamento de <strong></strong> ( as ) foi cancelado.</p>
      <p>Entre em contato para reagendar.</p>
    ,
    'rescheduled': 
      <h2>Ola, !</h2>
      <p>Seu agendamento de <strong></strong> foi reagendado para  as .</p>
    ,
  };
  return templates[type] || <p>Lembrete sobre </p>;
}

worker.on('completed', (job) => {
  console.log([Reminder] Job  sent ());
});

worker.on('failed', (job, err) => {
  console.error([Reminder] Job  failed:, err.message);
});

worker.on('error', (err) => {
  console.error('[Reminder] Worker error:', err.message);
});

module.exports = worker;
