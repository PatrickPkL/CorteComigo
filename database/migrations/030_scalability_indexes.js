'use strict';
/* ============================================================
   Corte Comigo – 030_scalability_indexes.js
   Índices para as consultas quentes (agenda do dia, lista da loja,
   sessões, relatórios). Todas as colunas aqui existem no schema real
   criado em 002_tables.js + 021/026/028.

   A versão anterior deste arquivo citava colunas que NUNCA existiram
   (appointments.scheduled_at, *.business_id, appointments.service_id,
   payments.appointment_id, payments.payment_method, users.is_active) e
   recriava idx_professionals_user, que já é criada em 003_indices.js.
   Resultado: a migração falhava com
   'column "scheduled_at" does not exist' e o boot do servidor morria
   em "Falha ao aplicar as migrações" (503).

   Usa CREATE INDEX IF NOT EXISTS: se uma execução anterior tiver
   criado parte dos índices, rodar de novo é seguro.
   ============================================================ */

const INDICES = [
  /* Agenda: o app filtra por loja e por profissional, sempre por data */
  ['appointments', ['professional_id', 'starts_at'], 'idx_appointments_professional_starts'],
  ['appointments', ['barbershop_id', 'starts_at'], 'idx_appointments_shop_starts'],
  ['appointments', ['status', 'starts_at'], 'idx_appointments_status_starts'],
  ['appointments', ['client_id', 'starts_at'], 'idx_appointments_client_starts'],
  ['appointments', ['user_id', 'starts_at'], 'idx_appointments_user_starts'],

  /* Catálogo da loja */
  ['services', ['barbershop_id', 'active'], 'idx_services_shop_active'],
  ['services', ['barbershop_id', 'sort_order'], 'idx_services_shop_order'],
  ['professionals', ['barbershop_id', 'is_active'], 'idx_professionals_shop_active'],

  /* Fila da loja / agenda do cliente */
  ['clients', ['barbershop_id', 'name'], 'idx_clients_shop_name'],
  ['clients', ['user_id'], 'idx_clients_user'],

  /* Itens do agendamento (snapshot de serviço) */
  ['appointment_services', ['appointment_id'], 'idx_appointment_services_appointment'],
  /* Busca inversa: quais profissionais oferecem um serviço */
  ['professional_services', ['service_id'], 'idx_professional_services_service'],

  /* Sessões: limpeza por expiração + listagem por usuário */
  ['sessions', ['user_id'], 'idx_sessions_user'],
  ['sessions', ['expires_at'], 'idx_sessions_expires'],

  /* Equipe (dependentes): filtrar por loja + papel */
  ['users', ['barbershop_id', 'role'], 'idx_users_shop_role'],
  /* Login por e-mail/telefone já é indexado pelos UNIQUE (email_hash,
     phone_hash) criados em 002_tables.js — os valores *_hash é que são
     consultáveis, porque email/phone são cifrados em repouso. */

  /* Financeiro */
  ['payments', ['barbershop_id', 'created_at'], 'idx_payments_shop_created'],
  ['payments', ['status', 'created_at'], 'idx_payments_status_created'],
  ['payments', ['barbershop_id', 'status'], 'idx_payments_shop_status'],
  ['subscriptions', ['barbershop_id', 'status'], 'idx_subscriptions_shop_status'],

  /* Avaliações e avisos */
  ['reviews', ['barbershop_id', 'created_at'], 'idx_reviews_shop_created'],
  ['notifications', ['user_id', 'created_at'], 'idx_notifications_user_created']
];

exports.up = async function (knex) {
  for (const [tabela, colunas, nome] of INDICES) {
    const cols = colunas.map((c) => '"' + c + '"').join(', ');
    await knex.raw('CREATE INDEX IF NOT EXISTS "' + nome + '" ON "' + tabela + '" (' + cols + ');');
  }
};

exports.down = async function (knex) {
  for (const [, , nome] of INDICES) {
    await knex.raw('DROP INDEX IF EXISTS "' + nome + '";');
  }
};