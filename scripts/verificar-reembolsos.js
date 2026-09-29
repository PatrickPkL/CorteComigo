'use strict';
/* Verificação do schema de `reembolsos` após a migration 028. */
const knex = require('knex')({
  client: 'pg',
  connection: require('../knexfile').development.connection
});

(async () => {
  const cols = await knex.raw(
    "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns " +
    "WHERE table_name = 'reembolsos' ORDER BY ordinal_position");
  console.log('COLUNAS:');
  cols.rows.forEach(c => console.log('  -', c.column_name, '|', c.data_type, '| null:', c.is_nullable, '|', c.column_default || ''));

  const en = await knex.raw(
    "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_enum.enumtypid = pg_type.oid " +
    "WHERE typname = 'reimb_status' ORDER BY enumsortorder");
  console.log('ENUM reimb_status:', en.rows.map(r => r.enumlabel).join(', '));

  const pol = await knex.raw("SELECT policyname, cmd FROM pg_policies WHERE tablename = 'reembolsos'");
  console.log('POLICIES RLS:', pol.rows.map(r => r.policyname + '(' + r.cmd + ')').join(', '));

  const trg = await knex.raw(
    "SELECT tgname FROM pg_trigger WHERE tgrelid = 'reembolsos'::regclass AND NOT tgisinternal");
  console.log('TRIGGERS:', trg.rows.map(r => r.tgname).join(', '));

  const grants = await knex.raw(
    "SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs " +
    "FROM information_schema.table_privileges WHERE table_name = 'reembolsos' GROUP BY grantee");
  console.log('GRANTS:');
  grants.rows.forEach(g => console.log('  -', g.grantee, '=>', g.privs));

  const idx = await knex.raw("SELECT indexname FROM pg_indexes WHERE tablename = 'reembolsos'");
  console.log('INDICES:', idx.rows.map(r => r.indexname).join(', '));

  await knex.destroy();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
