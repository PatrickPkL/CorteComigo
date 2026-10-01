'use strict';
/* ============================================================
   Corte Comigo – db_pg.js
   Camada de acesso a dados ASSÍNCRONA sobre PostgreSQL (Knex).

   Fonte de verdade: banco `cortecerto` (schema em database/migrations).
   Operações de escopo global (login por identidade, catálogo
   público, busca, provisionamento) rodam num bloco com
   `SET ROLE cortecerto_admin` (BYPASSRLS). Operações do dono/equipe
   rodam com `app.barbershop_id`/`app.user_id` setados (RLS tenant).

   Alvos sensíveis cifrados: users.email/phone (AES-256-GCM) com
   *_hash (SHA-256) para lookup. Conversões cuidadas para manter o
   formato que o frontend já conhece.
   ============================================================ */

const crypto = require('crypto');
const { knex, asAdmin } = require('./pool');
const crypt = require('./crypt');

/* ---------------- utilidades de data (America/Sao_Paulo) ---------------- */

function pad2(n) { return String(n).padStart(2, '0'); }

/* Date (node-pg) ou ISO string -> "YYYY-MM-DDTHH:MM" no fuso local do servidor */
function fmtLocal(v) {
  if (!v) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
    'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function agoraISO() { return new Date().toISOString().slice(0, 16); }
function hojeISO() {
  const d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function addDiasISO(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

/* ---------------- identidade ---------------- */

function normalizarTelefone(v) { return String(v || '').replace(/\D/g, ''); }
function normalizarIdentidade(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s.toLowerCase();
  return s.replace(/\D/g, '');
}
function ehEmail(ident) { return String(ident || '').includes('@'); }

/* ---------------- conversões ---------------- */

function sic(u) {
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    name: u.name,
    email: u.email ? crypt.descriptografar(u.email) : '',
    phone: u.phone ? crypt.descriptografar(u.phone) : '',
    verified: !!u.verified,
    prefs: u.prefs || null,
    consentimentos: u.consentimentos && u.consentimentos.length ? u.consentimentos : [],
    created_at: fmtLocal(u.created_at)
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, role: u.role, name: u.name,
    email: u.email || '', phone: u.phone, verified: !!u.verified,
    prefs: u.prefs || null
  };
}

function lojaPublica(b) {
  if (!b) return null;
  return {
    id: b.id, owner_user_id: b.owner_user_id, name: b.name, description: b.description,
    slug: b.slug, phone: b.phone, whatsapp: b.whatsapp, email: b.email,
    instagram: b.instagram, address: b.address, city: b.city, uf: b.uf,
    lat: b.lat == null ? null : Number(b.lat), lng: b.lng == null ? null : Number(b.lng),
    logo_url: b.logo_url, cover_url: b.cover_url, tags: b.tags || [],
    rating_base: Number(b.rating_base || 0), rating_count_base: Number(b.rating_count_base || 0),
    slot_interval_min: Number(b.slot_interval_min || 15),
    horarios_configurados: b.horarios_configurados ? 1 : 0,
    created_at: fmtLocal(b.created_at), updated_at: fmtLocal(b.updated_at)
  };
}

/* ---------------- usuários (escopo global -> admin) ---------------- */

async function usuarioPorIdentidade(ident) {
  if (!ident) return null;
  const hash = crypt.hashSHA256(ident); // email já lower / phone só dígitos
  return asAdmin(trx =>
    trx('users')
      .where(ehEmail(ident) ? 'email_hash' : 'phone_hash', hash)
      .first()
      .then(sic)
  );
}

async function usuarioPorId(id) {
  if (!id) return null;
  return asAdmin(trx => trx('users').where('id', id).first().then(sic));
}

async function criarUsuario(u) {
  const id = u.id || crypto.randomUUID();
  const payload = {
    id,
    role: u.role || 'cliente',
    name: u.name || 'Usuário',
    email: u.email ? crypt.criptografar(u.email) : null,
    email_hash: u.email ? crypt.hashSHA256(String(u.email).toLowerCase()) : null,
    phone: u.phone ? crypt.criptografar(u.phone) : null,
    phone_hash: u.phone ? crypt.hashSHA256(u.phone) : null,
    verified: !!u.verified,
    prefs: u.prefs || { notif_email: 'sim', notif_sms: 'não', lembrete: '30' },
    consentimentos: knex.raw('ARRAY[?]::jsonb[]', [JSON.stringify(u.consentimentos || [])]),
    created_at: u.created_at ? new Date(u.created_at) : new Date()
  };
  // consentimentos como JSONB[]
  const cons = u.consentimentos || [];
  const created = u.created_at ? new Date(u.created_at) : new Date();
  await asAdmin(trx =>
    trx.raw(
      `INSERT INTO users (id, role, name, email, email_hash, phone, phone_hash, verified, prefs, consentimentos, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb[], ?)`,
      [id, payload.role, payload.name, payload.email, payload.email_hash,
       payload.phone, payload.phone_hash, payload.verified, JSON.stringify(payload.prefs),
       JSON.stringify(cons), created]
    )
  );
  return sic(await usuarioPorId(id));
}

/* ---------------- sessões (sem RLS) ---------------- */

async function sessoesPorUsuario(userId) {
  return knex('sessions').where('user_id', userId).orderBy('expires_at', 'asc');
}

async function criarSessao(userId, opts) {
  // limita a 5 sessões ativas por usuário
  const ativas = await sessoesPorUsuario(userId);
  if (ativas.length >= 5) {
    const desc = [...ativas].sort((a, b) => new Date(a.expires_at) - new Date(b.expires_at));
    await knex('sessions').where('id', desc[0].id).del();
  }
  const expira = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  await knex('sessions').insert({
    id, user_id: userId, token, expires_at: expira,
    ip_address: (opts && opts.ip) || null,
    user_agent: (opts && opts.userAgent) || null
  });
  return { id, user_id: userId, token, expires_at: expira.toISOString() };
}

/* Devolve o usuário da sessão válida (ou null) — escopo global */
async function usuarioDaSessao(token) {
  if (!token) return null;
  const s = await knex('sessions').where('token', token).first();
  if (!s) return null;
  if (new Date(s.expires_at) <= new Date()) {
    await knex('sessions').where('id', s.id).del();
    return null;
  }
  return usuarioPorId(s.user_id);
}

async function revogarSessao(token) {
  if (!token) return;
  await knex('sessions').where('token', token).del();
}

async function revogarSessoesUsuario(userId) {
  await knex('sessions').where('user_id', userId).del();
}

/* ---------------- códigos SMS (sem RLS) ---------------- */

async function codigoAtivo(ident) {
  return knex('sms_codes').where('ident', ident).andWhere('used', false).first();
}

async function substituirCodigos(ident) {
  await knex('sms_codes').where('ident', ident).del();
}

async function criarCodigo(ident, code) {
  const agoraMs = Date.now();
  const id = crypto.randomUUID();
  const reg = {
    id,
    ident,
    phone: ehEmail(ident) ? '' : ident,
    code,
    expires_at: new Date(agoraMs + 10 * 60 * 1000),
    attempts: 0,
    used: false,
    next_allowed_at: new Date(agoraMs + 5 * 60 * 1000),
    created_at: new Date()
  };
  await knex('sms_codes').insert(reg);
  return reg;
}

async function atualizarCodigo(id, patch) {
  return knex('sms_codes').where('id', id).update(patch);
}

async function removerCodigo(id) {
  return knex('sms_codes').where('id', id).del();
}

/* ---------------- magic tokens (sem RLS) ---------------- */

async function listarMagicTokens(userId) {
  return knex('magic_tokens').where('user_id', userId);
}
async function ativosMagicTokens(userId) {
  return knex('magic_tokens').where('user_id', userId).andWhere('used', false);
}
async function removerMagicTokens(userId) {
  return knex('magic_tokens').where('user_id', userId).del();
}
async function criarMagicToken({ userId, email }) {
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString('hex');
  const expira = new Date(Date.now() + 15 * 60 * 1000);
  await knex('magic_tokens').insert({ id, token, user_id: userId || null, email, expires_at: expira, used: false });
  return { id, token, email, expires_at: expira.toISOString() };
}

/* ---------------- salão do usuário (escopo global p/ dono) ---------------- */

async function salaoDoUsuario(user) {
  if (!user) return null;
  if (user.role === 'dono') {
    return asAdmin(trx => trx('barbershops').where('owner_user_id', user.id).first().then(lojaPublica));
  }
  if (user.role === 'barbeiro') {
    const prof = await knex('professionals').where('user_id', user.id).first();
    if (!prof) return null;
    return asAdmin(trx => trx('barbershops').where('id', prof.barbershop_id).first().then(lojaPublica));
  }
  return null;
}

async function planoPorNome(nome) {
  return knex('plans').where('name', nome).first();
}

/* Lê uma configuração global do painel do super-admin.
   platform_settings.chave -> valor (jsonb). */
async function settingValor(chave, padrao) {
  try {
    const r = await knex('platform_settings').where('chave', chave).first();
    if (!r) return padrao;
    return r.valor === null || r.valor === undefined ? padrao : r.valor;
  } catch (e) {
    return padrao;
  }
}

/* ---------------- provisionamento do dono (RF-005) ---------------- */

async function slugUnico(nome) {
  const base = String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'salao';
  const existe = async (slug) => !!await asAdmin(trx => trx('barbershops').where('slug', slug).first());
  if (!(await existe(base))) return base;
  for (let i = 0; i < 50; i++) {
    const cand = base + '-' + Math.floor(Math.random() * 900 + 100);
    if (!(await existe(cand))) return cand;
  }
  throw { status: 500, error: 'Não foi possível gerar um identificador único para o salão.' };
}

async function provisionarSalao(usuario, nomeSalao) {
  const slug = await slugUnico(nomeSalao);
  const lojaId = crypto.randomUUID();
  const now = new Date();
  const phoneDig = normalizarTelefone(usuario.phone);
  const planoSalao = await planoPorNome('Salao');
  /* [SEGURANÇA] O trial de boas-vindas nasce aqui. Precisa gravar
     trial_usado=true — sem isso o DEFAULT FALSE da coluna deixava a
     assinatura com trial_usado=false, e assinarComTrial (que só checa
     essa flag) concedia 10 dias novos todas as vezes que o trial
     expirava. Respeita também a configuração trial_10dias do painel. */
  const cfg = await settingValor('trial_10dias', true);
  const diasTrial = Number(cfg && cfg.dias) > 0 ? Number(cfg.dias) : 10;
  const trialLiberado = cfg ? cfg.ativo !== false : true;
  const expira = trialLiberado
    ? new Date(Date.now() + diasTrial * 24 * 3600 * 1000)
    : null;

  await asAdmin(async trx => {
    await trx('barbershops').insert({
      id: lojaId, owner_user_id: usuario.id, name: nomeSalao, description: '', slug,
      phone: phoneDig ? '(' + phoneDig.slice(0, 2) + ') ' + phoneDig.slice(2) : '',
      whatsapp: '', email: usuario.email || '', instagram: '',
      address: '', city: '', uf: '', lat: null, lng: null, logo_url: null, cover_url: null,
      tags: ['Corte', 'Barba'], rating_base: 0, rating_count_base: 0,
      horarios_configurados: 0,
      created_at: now, updated_at: now
    });
    // horários padrão: seg–sáb 09–18, dom fechado
    for (let dow = 1; dow <= 6; dow++) {
      await trx('working_hours').insert({
        id: crypto.randomUUID(), barbershop_id: lojaId, professional_id: null,
        day_of_week: dow, start_time: '09:00:00', end_time: '18:00:00',
        lunch_start: null, lunch_end: null, is_open: true
      });
    }
    await trx('working_hours').insert({
      id: crypto.randomUUID(), barbershop_id: lojaId, professional_id: null,
      day_of_week: 0, start_time: '09:00:00', end_time: '18:00:00',
      lunch_start: null, lunch_end: null, is_open: false
    });
    // serviços iniciais
    const svcIni = [
      { nome: 'Corte', dur: 30, preco: 40 },
      { nome: 'Barba', dur: 20, preco: 25 },
      { nome: 'Corte + Barba', dur: 45, preco: 60 }
    ];
    for (let i = 0; i < svcIni.length; i++) {
      const s = svcIni[i];
      await trx('services').insert({
        id: crypto.randomUUID(), barbershop_id: lojaId, name: s.nome,
        category: s.nome.includes('Barba') ? 'Barba' : 'Cabelo', description: '',
        duration_min: s.dur, price: s.preco, active: true, sort_order: i + 1,
        created_at: now, updated_at: now
      });
    }
    // assinatura trial do plano Salao — trial_usado gravado para impedir
    // que assinarComTrial conceda um segundo trial quando este expirar
    if (trialLiberado) {
      await trx('subscriptions').insert({
        id: crypto.randomUUID(), barbershop_id: lojaId,
        plan_id: planoSalao ? planoSalao.id : null,
        status: 'trial', trial_ends_at: expira, current_period_end: expira,
        trial_usado: true,
        created_at: now, updated_at: now
      });
    } else {
      /* Trial desligado no painel: a loja nasce no plano Free. */
      const planoFree = await trx('plans').where('is_free', true).first();
      await trx('subscriptions').insert({
        id: crypto.randomUUID(), barbershop_id: lojaId,
        plan_id: planoFree ? planoFree.id : (planoSalao ? planoSalao.id : null),
        status: 'expirada', trial_ends_at: null, current_period_end: null,
        trial_usado: true,
        created_at: now, updated_at: now
      });
    }
  });

  return lojaPublica(await asAdmin(trx => trx('barbershops').where('id', lojaId).first()));
}

/* ---------------- audit log ---------------- */

async function auditLog(userId, acao, extra, ip) {
  try {
    await knex('audit_log').insert({
      id: crypto.randomUUID(), user_id: userId || null, acao,
      extra: extra ? JSON.stringify(extra) : null,
      ip_address: ip || null, timestamp: new Date()
    });
  } catch (e) { /* não bloqueia o fluxo */ }
}

module.exports = {
  // datas
  hojeISO, addDiasISO, agoraISO, fmtLocal,
  // identidade
  normalizarTelefone, normalizarIdentidade, ehEmail,
  // conversões
  sic, publicUser, lojaPublica,
  // usuários
  usuarioPorIdentidade, usuarioPorId, criarUsuario,
  // sessões
  sessoesPorUsuario, criarSessao, usuarioDaSessao, revogarSessao, revogarSessoesUsuario,
  // códigos
  codigoAtivo, substituirCodigos, criarCodigo, atualizarCodigo, removerCodigo,
  // magic tokens
  listarMagicTokens, ativosMagicTokens, removerMagicTokens, criarMagicToken,
  // salão
  salaoDoUsuario, planoPorNome, settingValor, slugUnico, provisionarSalao,
  // audit
  auditLog
};
