const { Worker } = require('bullmq');
const { redis } = require('./queue');
const PDFDocument = require('pdfkit');
const fs = require('fs').promises;

/* Worker de relatórios em PDF (BullMQ + pdfkit). Só roda com Redis.
   O relatório diário do painel NÃO depende dele: server.js chama
   API.gerarDiariosParaData(), que grava o snapshot no PostgreSQL. */

const worker = new Worker('reports', async (job) => {
  const { type, data, outputPath } = job.data;

  let buffer;
  switch (type) {
    case 'appointments':
      buffer = await generateAppointmentsReport(data);
      break;
    case 'revenue':
      buffer = await generateRevenueReport(data);
      break;
    case 'clients':
      buffer = await generateClientsReport(data);
      break;
    default:
      throw new Error(`Unknown report type: ${type}`);
  }

  if (outputPath) {
    await fs.writeFile(outputPath, buffer);
  }

  return { size: buffer.length, path: outputPath };
}, {
  connection: redis,
  concurrency: 2,
});

function novoDoc() {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];
  doc.on('data', (chunk) => chunks.push(chunk));
  return { doc, fim: () => new Promise((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks)))) };
}

async function generateAppointmentsReport(data) {
  const { doc, fim } = novoDoc();
  const d = data || {};
  const lista = d.appointments || [];

  doc.fontSize(20).text('Relatorio de Agendamentos', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Periodo: ${d.periodo || ''} — total: ${lista.length}`);
  doc.moveDown();

  lista.forEach((apt, i) => {
    const quando = apt && (apt.starts_at || apt.appointmentDate);
    doc.text(`${i + 1}. ${(apt && apt.client_name) || ''} — ${(apt && apt.name) || ''} — ${quando || ''}`);
  });

  doc.end();
  return fim();
}

async function generateRevenueReport(data) {
  const { doc, fim } = novoDoc();
  const d = data || {};

  doc.fontSize(20).text('Relatorio Financeiro', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Periodo: ${d.periodo || ''}`);
  doc.moveDown();
  doc.text(`Receita Total: R$ ${Number(d.total || 0).toFixed(2)}`);
  doc.text(`Agendamentos: ${Number(d.count || 0)}`);
  doc.text(`Ticket Medio: R$ ${Number(d.ticket || 0).toFixed(2)}`);

  doc.end();
  return fim();
}

async function generateClientsReport(data) {
  const { doc, fim } = novoDoc();
  const lista = (data && data.clients) || [];

  doc.fontSize(20).text('Relatorio de Clientes', { align: 'center' });
  doc.moveDown();

  lista.forEach((client, i) => {
    doc.text(`${i + 1}. ${(client && client.name) || ''} — ${Number((client && client.total_visits) || 0)} agendamentos`);
  });

  doc.end();
  return fim();
}

worker.on('completed', (job) => {
  console.log('[Report] Job concluído:', job && job.id);
});

worker.on('failed', (job, err) => {
  console.error('[Report] Job falhou:', err && err.message);
});

worker.on('error', (err) => {
  console.error('[Report] Erro no worker:', err && err.message);
});

module.exports = worker;