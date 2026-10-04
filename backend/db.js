/* ============================================================
   Corte Comigo – db.js  (PRD v2 · Seção 5 / Seção 7)
   Persistência cuja FONTE DE VERDADE é o PostgreSQL.

   [SEGURANÇA] Dados sensíveis (email/telefone) são descriptografados no boot
   e ficam em memória. Em caso de memory dump, PII pode vazar.
   Mitigação futura: descriptografar sob demanda (lazy) no getter.

   Estratégia "espelho PG->memória":
     - init() carrega todas as tabelas do PostgreSQL para a memória
       (formato compatível com api.js/auth.js), descriptografando
       dados sensíveis.
     - A lógica de negócio continua SÍNCRONA lendo de _d().
     - Em cada salvar() as coleções alteradas são sincronizadas de
       volta ao PostgreSQL (upsert + delete) via fila assíncrona.

   Mantém a API pública original: _d / salvar / proximoId / reset /
   helpers de data / criptografar / descriptografar.
   ============================================================ */

window.DB = (function () {
  'use strict';

  const crypto = require('crypto');
  const { asAdmin } = require('./pool');
  const crypt = require('./crypt');
  const pg_map = require('./pg_map');

  const DB_VERSION = 7;

  var _loaded = false;
  var db = null;              // working copy (memória)
  var _orig = {};             // snapshot por coleção (detecção de mudanças)
  var _queue = Promise.resolve();
  var _syncPendente = false;  // agrupa vários salvar() num único syncAll
  var _versoes = {};          // versão por coleção (invalida índices de memória)

  /* ---------------- helpers de data (hora local, mata DT-11) ---------------- */

  function pad2(n) { return String(n).padStart(2, '0'); }

  function hojeISO() {
    const d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function agoraMinutos() {
    const d = new Date();
    return d.getHours() * 60 + d.getMinutes();
  }

  function addDiasISO(n, base) {
    const d = base ? parseISO(base) : new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function parseISO(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function diaSemana(iso) { return parseISO(iso).getDay(); }

  function hhmmToMin(hhmm) {
    if (!hhmm) return null;
    const [h, m] = String(hhmm).split(':').map(Number);
    return h * 60 + m;
  }

  function minToHHMM(t) { return pad2(Math.floor(t / 60)) + ':' + pad2(t % 60); }

  function fmtDataBR(iso) {
    if (!iso) return '';
    const [y, m, d] = String(iso).split('-');
    return d + '/' + m + '/' + y;
  }

  function fmtBRL(v) {
    return 'R$ ' + Number(v || 0).toFixed(2).replace('.', ',');
  }

  function iniciais(nome) {
    return (nome || '?').trim().split(/\s+/).slice(0, 2)
      .map(p => p[0].toUpperCase()).join('');
  }

  /* ---------------- criptografia ---------------- */

  function criptografar(texto) { return crypt.criptografar(texto); }
  function descriptografar(texto) { return crypt.descriptografar(texto); }

  /* ---------------- estado ---------------- */

  function nextId() {
    // ids agora são UUID (colunas UUID no PostgreSQL)
    return crypto.randomUUID();
  }

  function _deep(v) { return JSON.parse(JSON.stringify(v)); }

  function salvar() {
    if (!_loaded) return;
    _scheduleSync();
  }

  function _scheduleSync() {
    /* Várias chamadas a salvar() viram UM único syncAll. O diff é por estado
       (compara com _orig), não por evento, então agrupar não perde escrita
       nenhuma — antes cada chamada enfileirava uma varredura completa das 27
       coleções, e há 90 call-sites de DB.salvar() no projeto. */
    if (_syncPendente) return;
    _syncPendente = true;
    _queue = _queue.then(async () => {
      /* Libera a marca ANTES do sync: escritas que ocorrerem durante o sync
         agendam a próxima passada, em vez de ficarem pendentes sem fila. */
      _syncPendente = false;
      await syncAll();
    }).catch(e => {
      console.error('[db][sync]', e && e.stack ? e.stack : e);
    });
  }

  function _keyOf(m, row) {
    return _pkCols(m.pk).map(c => String(row[c] == null ? '' : row[c])).join('|');
  }

  /* Diff incremental por linha: devolve as linhas a dar upsert (novas ou
     alteradas) e as removidas, comparando a coleção em memória com o
     snapshot _orig. Evita reescrever a tabela inteira a cada salvar(). */
  function diffCol(m, prevRows, curRows) {
    const prevByKey = new Map();
    for (const r of (prevRows || [])) prevByKey.set(_keyOf(m, r), r);
    const curByKey = new Map();
    for (const r of (curRows || [])) curByKey.set(_keyOf(m, r), r);

    const upsert = [];
    for (const r of (curRows || [])) {
      const p = prevByKey.get(_keyOf(m, r));
      if (p === undefined || JSON.stringify(p) !== JSON.stringify(r)) upsert.push(r);
    }
    const removed = [];
    for (const r of (prevRows || [])) {
      if (!curByKey.has(_keyOf(m, r))) removed.push(r);
    }
    return { upsert, removed, prevByKey };
  }

  /* Novo snapshot de _orig: só as linhas alteradas são clonadas em profundidade.
     As demais reaproveitam o objeto do snapshot anterior, que já é uma cópia
     isolada de conteúdo idêntico. Equivale a _deep(cur), mas custa o que mudou
     em vez da coleção inteira. */
  function snapshotCol(m, curRows, prevByKey, upsert) {
    const mudou = new Set(upsert.map(r => _keyOf(m, r)));
    const out = new Array(curRows.length);
    for (let i = 0; i < curRows.length; i++) {
      const r = curRows[i];
      const k = _keyOf(m, r);
      out[i] = mudou.has(k) ? _deep(r) : (prevByKey.get(k) || _deep(r));
    }
    return out;
  }

  async function syncAll() {
    if (!_loaded) return;
    // [FIXBug6] Uma falha em UMA coleção (ex.: violação de constraint)
    // NÃO pode abortar o lote: senão pagamentos/assinaturas/agendamentos
    // escritos no mesmo ciclo se perdem para sempre (e o restart volta
    // ao estado antigo). Cada coleção é persistida isoladamente; a que
    // falhar fica pendente (não atualiza _orig) e retenta no próximo salvar.
    for (const m of pg_map.MAP) {
      const cur = db[m.colecao] || [];
      const prev = _orig[m.colecao] || [];

      try {
        /* O proprio diff e o detector de mudanca. A versao anterior gastava
           stringify(prev) + stringify(cur) + um _deep da colecao inteira e
           SO DEPOIS diffia — tres serializacoes para responder a mesma
           pergunta que diffCol ja responde. */
        const { upsert, removed, prevByKey } = diffCol(m, prev, cur);
        if (upsert.length || removed.length) {
          await writeCol(m, upsert, removed);
          _orig[m.colecao] = snapshotCol(m, cur, prevByKey, upsert);
          _versoes[m.colecao] = (_versoes[m.colecao] || 0) + 1;
        }
      } catch (e) {
        console.error('[db][sync] falha persistindo coleção "' + m.colecao + '":',
          (e && (e.message || e.code)) || e);
      }
    }
  }

  /* ---------------- escrita no PostgreSQL ---------------- */

  function _iso(v) {
    if (v == null) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? String(v) : d.toISOString();
  }

  function _val(colType, v) {
    if (v === null || v === undefined) return { sql: 'NULL', binds: [] };
    switch (colType) {
      case 'uuid': return { sql: '?::uuid', binds: [String(v)] };
      case 'jsonb': return { sql: '?::jsonb', binds: [typeof v === 'string' ? v : JSON.stringify(v)] };
      case 'jsonb[]': {
        const arr = v || [];
        if (!arr.length) return { sql: 'ARRAY[]::jsonb[]', binds: [] };
        return {
          sql: 'ARRAY[' + arr.map(() => '?::jsonb').join(',') + ']',
          binds: arr.map(x => (typeof x === 'string' ? x : JSON.stringify(x)))
        };
      }
      case 'text[]': return { sql: '?::text[]', binds: [v || []] };
      case 'time': return { sql: '?::time', binds: [String(v)] };
      case 'timestamptz': return { sql: '?::timestamptz', binds: [_iso(v)] };
      case 'inet': return { sql: '?::inet', binds: [String(v)] };
      case 'numeric':
      case 'int':
      case 'boolean':
      default: return { sql: '?', binds: [v] };
    }
  }

  function _pkWhere(pk, row) {
    if (Array.isArray(pk)) {
      return pk.map(c => `"${c}" = ?::uuid`).join(' AND ');
    }
    return `"${pk}" = ?::uuid`;
  }
  function _pkBinds(pk, row) {
    return Array.isArray(pk) ? pk.map(c => String(row[c])) : [String(row[pk])];
  }
  function _pkCols(pk) {
    return Array.isArray(pk) ? pk : [pk];
  }

  async function writeCol(m, rows, removedRows) {
    // rmRows/rows já vêm do diff incremental (writeCol só escreve o que mudou)
    const removed = removedRows || [];

    await asAdmin(async trx => {
      if (removed.length) {
        const pkCols = _pkCols(m.pk);
        const casts = (pg_map.CASTS[m.tabela] || {});
        // escolhe o cast do elemento para o array de pk (padrão uuid;
        // pk de texto — ex.: platform_settings.chave — sem cast)
        const elemTipo = c => (casts[c] === 'text' ? 'text' : 'uuid');
        let sql, binds;
        if (pkCols.length === 1) {
          sql = `DELETE FROM "${m.tabela}" WHERE "${pkCols[0]}" = ANY(?::${elemTipo(pkCols[0])}[])`;
          binds = [removed.map(r => String(r[pkCols[0]]))];
        } else {
          const tpl = pkCols.map(c => '?::' + elemTipo(c)).join(', ');
          sql = `DELETE FROM "${m.tabela}" WHERE ("${pkCols.join('", "')}") IN (${removed.map(() => '(' + tpl + ')').join(', ')})`;
          binds = removed.flatMap(r => pkCols.map(c => String(r[c])));
        }
        await trx.raw(sql, binds);
      }

      if (!rows.length) return;

      // monta INSERT multirow com upsert
      const cols = Object.keys(m.toPg(rows[0]));
      const conflictTarget = _pkCols(m.pk).map(c => `"${c}"`).join(', ');
      const placeholders = rows.map((row, idx) => {
        const rowPg = m.toPg(row);
        const vals = cols.map(col => _val((pg_map.CASTS[m.tabela] || {})[col], rowPg[col]));
        return '(' + vals.map(v => v.sql).join(', ') + ')';
      }).join(', ');

      const allRowBinds = [];
      rows.forEach(row => {
        const rowPg = m.toPg(row);
        cols.forEach(col => {
          const v = _val((pg_map.CASTS[m.tabela] || {})[col], rowPg[col]);
          allRowBinds.push(...v.binds);
        });
      });

      const updateSet = cols.filter(c => !_pkCols(m.pk).includes(c))
        .map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');

      const sql = `INSERT INTO "${m.tabela}" ("${cols.join('", "')}")
        VALUES ${placeholders}
        ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSet}`;
      await trx.raw(sql, allRowBinds);
    });
  }

  /* ---------------- carga do PostgreSQL ---------------- */

  async function init() {
    if (_loaded) return;
    const obj = { v: DB_VERSION, meta: { seq: 2000 } };
    pg_map.BY_COLECAO.favorites = null;

    for (const m of pg_map.MAP) {
      const rows = await asAdmin(trx => trx(m.tabela).select('*'));
      obj[m.colecao] = rows.map(r => m.toMem(r));
    }

    // coleções presentes no modelo antigo mas sem tabela própria
    obj.favorites = [];
    obj.sessions = obj.sessions || [];
    obj.sms_codes = obj.sms_codes || [];

    // normaliza coleções ausentes (seed vazio)
    pg_map.MAP.forEach(m => { obj[m.colecao] = obj[m.colecao] || []; });

    db = obj;
    _orig = {};
    pg_map.MAP.forEach(m => { _orig[m.colecao] = _deep(db[m.colecao]); });
    _orig.favorites = [];

    // purge de sessões/códigos expirados
    await purgePersistidos();

    _loaded = true;
  }

  async function purgePersistidos() {
    const now = new Date();
    await asAdmin(async trx => {
      await trx('sessions').where('expires_at', '<=', now).del();
      await trx('sms_codes').where('used', true).orWhere('expires_at', '<=', now).del();
      await trx('magic_tokens').where('used', true).orWhere('expires_at', '<=', now).del();
      await trx('superadmin_sessions').where('expires_at', '<=', now).del();
    });
  }

  /* reset: esvazia tudo (dev/tests) */
  async function reset() {
    if (!_loaded) { await init(); }
    await asAdmin(async trx => {
      const tabelas = [
        'reembolsos',
        'relatorios_diarios',
        'blocked_clients', 'reports', 'superadmin_sessions', 'audit_log', 'tickets', 'gallery_images', 'reviews',
        'notifications', 'magic_tokens', 'sms_codes', 'sessions', 'appointment_services',
        'appointments', 'payments', 'subscriptions', 'plans', 'clients',
        'schedule_exceptions', 'working_hours', 'professional_services', 'professionals',
        'services', 'barbershops', 'users'
      ];
      for (const t of tabelas) await trx.raw(`TRUNCATE TABLE "${t}" CASCADE;`);
    });
    db = { v: DB_VERSION, meta: { seq: 1 } };
    pg_map.MAP.forEach(m => { db[m.colecao] = []; });
    db.favorites = [];
    _orig = {};
    pg_map.MAP.forEach(m => { _orig[m.colecao] = [] });
    _orig.favorites = [];
  }

  /* ---------------- API pública ---------------- */

  return {
    init,
    _d: () => db,
    salvar,
    proximoId: nextId,
    reset,
    versao: colecao => (_versoes[colecao] || 0),

    // datas/horas
    hojeISO, addDiasISO, parseISO, diaSemana, agoraMinutos,
    hhmmToMin, minToHHMM, pad2,
    fmtDataBR, fmtBRL, iniciais,

    // criptografia
    criptografar, descriptografar
  };
})();
