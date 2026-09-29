'use strict';
/* ============================================================
   Corte Comigo – 028_reembolsos.js
   Módulo de Reembolso (CDC art. 49 — direito de arrependimento
   em até 7 dias corridos da contratação/pagamento).

   A tabela `reembolsos` registra o pedido do barbeiro e o seu ciclo:
     PENDENTE_GMAIL → criado no site, aguardando o envio do
                     relatório pelo Gmail. Fica OCULTO para o
                     Super Admin (não casa com o filtro
                     status = 'EM_ANALISE' da listagem).
     EM_ANALISE     → o barbeiro confirmou o envio do e-mail.
                     Torna o pedido visível ao Super Admin.
     REEMBOLSADO    → o Super Admin marcou como realizado e a
                     notificação de sucesso foi gerada.

   `visible_to_admin` é o soft delete de visualização: marcar
   "false" esconde o pedido das listas do Super Admin. A LINHA NUNCA
   é removida do banco (auditoria/LGPD).

   Chave Pix: aceita SOMENTE chave temporária/aleatória (EVP, formato
   UUID). CPF é rejeitado na API (ver validarChavePix em
   backend/api.js) e na interface.
   ============================================================ */

exports.up = async function (knex) {
  // ---- 1. tipo ENUM do ciclo de vida do pedido ----
  // Idempotente: `CREATE TYPE` puro (como em 001) quebra se a migração
  // for reexecutada, então o duplicate_object é absorvido aqui.
  await knex.raw(`
    DO $$ BEGIN
      CREATE TYPE reimb_status AS ENUM ('PENDENTE_GMAIL', 'EM_ANALISE', 'REEMBOLSADO');
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;`);

  // ---- 2. tabela de pedidos de reembolso ----
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS reembolsos (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      barbershop_id UUID REFERENCES barbershops(id) ON DELETE SET NULL,
      temporary_pix_key VARCHAR(255) NOT NULL,
      reason TEXT NOT NULL,
      status reimb_status NOT NULL DEFAULT 'PENDENTE_GMAIL',
      visible_to_admin BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT reembolsos_reason_min CHECK (char_length(btrim(reason)) >= 10)
    );
  `);

  // ---- 3. índices (listagem do barbeiro + listagem do super-admin) ----
  await knex.raw(`CREATE INDEX IF NOT EXISTS reembolsos_user_idx ON reembolsos (user_id, created_at DESC);`);
  await knex.raw(`CREATE INDEX IF NOT EXISTS reembolsos_status_idx ON reembolsos (status, visible_to_admin);`);

  // ---- 4. RLS: o barbeiro enxerga os próprios pedidos; super-admin, tudo ----
  const sid = `NULLIF(BTRIM(current_setting('app.barbershop_id', true)), '')`;
  const uid = `NULLIF(BTRIM(current_setting('app.user_id', true)), '')`;
  await knex.raw(`ALTER TABLE reembolsos ENABLE ROW LEVEL SECURITY;`);
  await knex.raw(`DROP POLICY IF EXISTS reembolsos_tenant ON reembolsos;`);
  await knex.raw(`CREATE POLICY reembolsos_tenant ON reembolsos
    USING (barbershop_id = ${sid}::uuid OR user_id = ${uid}::uuid)
    WITH CHECK (barbershop_id = ${sid}::uuid OR user_id = ${uid}::uuid);`);
  await knex.raw(`DROP POLICY IF EXISTS reembolsos_sa_all ON reembolsos;`);
  await knex.raw(`CREATE POLICY reembolsos_sa_all ON reembolsos
    TO cortecerto_admin
    USING (true) WITH CHECK (true);`);

  // ---- 5. grants (padrão 012/013/015 para tabelas criadas após 005) ----
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON reembolsos TO cortecerto_app;`);
  await knex.raw(`GRANT SELECT ON reembolsos TO cortecerto_readonly;`);
  await knex.raw(`GRANT SELECT, INSERT, UPDATE, DELETE ON reembolsos TO cortecerto_admin;`);

  // ---- 6. updated_at automático (função genérica criada em 004) ----
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_reembolsos_updated_at ON reembolsos;
    CREATE TRIGGER trg_reembolsos_updated_at
      BEFORE UPDATE ON reembolsos
      FOR EACH ROW EXECUTE FUNCTION atualizar_updated_at();`);
};

exports.down = async function (knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_reembolsos_updated_at ON reembolsos;`);
  await knex.raw(`DROP POLICY IF EXISTS reembolsos_sa_all ON reembolsos;`);
  await knex.raw(`DROP POLICY IF EXISTS reembolsos_tenant ON reembolsos;`);
  await knex.raw(`DROP TABLE IF EXISTS reembolsos;`);
  await knex.raw(`DROP TYPE IF EXISTS reimb_status;`);
};
