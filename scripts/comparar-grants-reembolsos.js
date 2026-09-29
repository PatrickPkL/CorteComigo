'use strict';
/* Confere se o perfil de grants de `reembolsos` é idêntico ao de uma
   tabela já existente (tickets) — evita ter criado um vazamento. */
const knex = require('knex')({
  client: 'pg',
  connection: require('../knexfile').development.connection
});

(async () => {
  const q = "SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs " +
    "FROM information_schema.table_privileges WHERE table_name IN ('tickets','reembolsos') " +
    "GROUP BY table_name, grantee ORDER BY table_name, grantee";
  const r = await knex.raw(q);
  const byTable = {};
  r.rows.forEach(x => { (byTable[x.table_name] = byTable[x.table_name] || {})[x.grantee] = x.privs; });
  const a = byTable.tickets || {};
  const b = byTable.reembolsos || {};
  Object.keys({ ...a, ...b }).forEach(g => {
    const igual = a[g] === b[g];
    console.log((igual ? 'OK  ' : 'DIF ') + g.padEnd(22) + ' tickets=' + a[g] + ' | reembolsos=' + b[g]);
  });
  await knex.destroy();
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
