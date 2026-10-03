const { Worker } = require('bullmq');
const { redis } = require('./queue');
const PDFDocument = require('pdfkit');
const fs = require('fs').promises;
const path = require('path');

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
      throw new Error(Unknown report type: );
  }

  if (outputPath) {
    await fs.writeFile(outputPath, buffer);
  }

  return { size: buffer.length, path: outputPath };
}, {
  connection: redis,
  concurrency: 2,
});

async function generateAppointmentsReport(data) {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  doc.fontSize(20).text('Relatorio de Agendamentos', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(Periodo:  a );
  doc.moveDown();

  data.appointments.forEach((apt, i) => {
    doc.text(${i + 1}.  -  -   - );
  });

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function generateRevenueReport(data) {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  doc.fontSize(20).text('Relatorio Financeiro', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(Periodo:  a );
  doc.moveDown();
  doc.text(Receita Total: R$ );
  doc.text(Agendamentos: );
  doc.text(Ticket Medio: R$ );

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function generateClientsReport(data) {
  const doc = new PDFDocument({ margin: 50 });
  const chunks = [];

  doc.on('data', (chunk) => chunks.push(chunk));

  doc.fontSize(20).text('Relatorio de Clientes', { align: 'center' });
  doc.moveDown();

  data.clients.forEach((client, i) => {
    doc.text(${i + 1}.  -  -  agendamentos);
  });

  doc.end();

  return new Promise((resolve) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

worker.on('completed', (job) => {
  console.log([Report] Job  completed);
});

worker.on('failed', (job, err) => {
  console.error([Report] Job  failed:, err.message);
});

worker.on('error', (err) => {
  console.error('[Report] Worker error:', err.message);
});

module.exports = worker;
