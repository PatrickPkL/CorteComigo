'use strict';
/* ============================================================
   Corte Comigo – pg_map.js
   Mapeamento entre o formato em memória da aplicação (db.js:
   camelCase, flags 1/0, timestamps locais) e as tabelas do
   PostgreSQL (snake_case, tipos SQL, cifragem de dados sensíveis).

   Cada entrada define:
     colecao  : chave do objeto _d() (ex: 'appointments')
     tabela   : tabela no PostgreSQL
     pk       : nome(s) da coluna chave no formato memória
     toPg     : (obj memória) => objeto que será inserido no banco
     toMem    : (linha banco)  => objeto no formato memória
     dateOut  : formato de data na SAÍDA (memória):
                 'local' -> "YYYY-MM-DDTHH:MM"  (fuso America/Sao_Paulo)
                 'iso'   -> ISO com Z
                 'ms'    -> milissegundos
                 'date'  -> "YYYY-MM-DD"
     encUsers : true => users (cifra/decifra email/phone + hashes)
   ============================================================ */

const crypt = require('./crypt');

function pad2(n) { return String(n).padStart(2, '0'); }

/* Converte valor (string local/ISO, Date ou ms) -> Date */
function toPgDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  const n = Number(v);
  if (typeof v === 'number' || (/^\d+$/.test(String(v)) && String(v).length >= 12)) {
    return new Date(n);
  }
  // "YYYY-MM-DDTHH:MM[:ss]" ou "YYYY-MM-DD" — interpretado no fuso local do servidor
  return new Date(String(v).length === 10 ? String(v) + 'T12:00:00' : String(v).replace(' ', 'T'));
}

function toMemDate(v, kind) {
  if (v == null) return v;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return String(v);
  switch (kind) {
    case 'ms': return d.getTime();
    case 'iso': return d.toISOString();
    case 'date':
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    default: // local
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
        'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
}

function hhmmToTime(v) {
  if (!v) return null;
  return /^\d{2}:\d{2}$/.test(v) ? v + ':00' : v;
}
function timeToHHMM(v) {
  if (!v) return null;
  const s = String(v);
  return s.length >= 5 ? s.slice(0, 5) : s;
}
function tagNum(v) { return v ? 1 : 0; }
function tagBool(v) { return !!v; }

/* Configuração por tabela (no formato memória) */
const MAP = [
  {
    colecao: 'users', tabela: 'users', pk: 'id', encUsers: true, dateOut: 'local',
    toPg: (u) => ({
      id: u.id, role: u.role, name: u.name,
      email: u.email ? crypt.criptografar(u.email) : null,
      email_hash: u.email ? crypt.hashSHA256(String(u.email).toLowerCase()) : null,
      phone: u.phone ? crypt.criptografar(u.phone) : null,
      phone_hash: u.phone ? crypt.hashSHA256(u.phone) : null,
      verified: tagBool(u.verified),
      password_hash: u.password_hash || null,
      barbershop_id: u.barbershop_id || null,
      prefs: knexJson(u.prefs || { notif_email: 'sim', notif_sms: 'não', lembrete: '30' }),
      consentimentos: knexJsonArr(u.consentimentos || []),
      created_at: toPgDate(u.created_at), updated_at: toPgDate(u.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, role: r.role, name: r.name,
      email: crypt.descriptografar(r.email), phone: crypt.descriptografar(r.phone),
      verified: r.verified ? 1 : 0,
      password_hash: r.password_hash || null,
      barbershop_id: r.barbershop_id || null,
      prefs: r.prefs || null,
      consentimentos: (r.consentimentos && r.consentimentos.length) ? r.consentimentos : [],
      created_at: toMemDate(r.created_at, 'local')
    })
  },
  {
    colecao: 'sessions', tabela: 'sessions', pk: 'id', dateOut: 'iso',
    toPg: (s) => ({ id: s.id, user_id: s.user_id, token: s.token, expires_at: toPgDate(s.expires_at) }),
    toMem: (r) => ({ id: r.id, user_id: r.user_id, token: r.token, expires_at: toMemDate(r.expires_at, 'iso') })
  },
  {
    colecao: 'sms_codes', tabela: 'sms_codes', pk: 'id', dateOut: 'ms',
    toPg: (c) => ({
      id: c.id, ident: c.ident, phone: c.phone, code: c.code,
      expires_at: toPgDate(c.expires_at), attempts: c.attempts || 0, used: tagBool(c.used),
      next_allowed_at: toPgDate(c.next_allowed_at),
      payload: knexJson(c.payload), created_at: toPgDate(c.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, ident: r.ident, phone: r.phone, code: r.code,
      expires_at: toMemDate(r.expires_at, 'ms'), attempts: r.attempts, used: r.used ? 1 : 0,
      next_allowed_at: toMemDate(r.next_allowed_at, 'ms'),
      payload: r.payload || {}, created_at: r.created_at ? toMemDate(r.created_at, 'iso') : undefined
    })
  },
  {
    colecao: 'barbershops', tabela: 'barbershops', pk: 'id', dateOut: 'local',
    toPg: (b) => ({
      id: b.id, owner_user_id: b.owner_user_id || null, name: b.name, slug: b.slug,
      description: b.description || '', phone: b.phone || '', whatsapp: b.whatsapp || '',
      email: b.email || '', instagram: b.instagram || '', address: b.address || '',
      city: b.city || '', uf: b.uf || '', lat: b.lat, lng: b.lng,
      logo_url: b.logo_url, cover_url: b.cover_url,
      tags: knexArr(b.tags || []),
      rating_base: (b.ratingBase || 0), rating_count_base: (b.ratingCountBase || 0),
      slot_interval_min: (b.slotIntervalMin || 15),
      horarios_configurados: b.horarios_configurados ? 1 : 0,
      codigo_unico: b.codigo_unico || null,
      views: b.views || 0,
      created_at: toPgDate(b.created_at) || new Date(), updated_at: toPgDate(b.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, owner_user_id: r.owner_user_id, name: r.name, slug: r.slug,
      description: r.description, phone: r.phone, whatsapp: r.whatsapp, email: r.email,
      instagram: r.instagram, address: r.address, city: r.city, uf: r.uf,
      lat: r.lat == null ? null : Number(r.lat), lng: r.lng == null ? null : Number(r.lng),
      logo_url: r.logo_url, cover_url: r.cover_url, tags: r.tags || [],
      ratingBase: Number(r.rating_base || 0), ratingCountBase: Number(r.rating_count_base || 0),
      slotIntervalMin: Number(r.slot_interval_min || 15),
      horarios_configurados: r.horarios_configurados ? 1 : 0,
      codigo_unico: r.codigo_unico || null,
      views: Number(r.views || 0),
      created_at: toMemDate(r.created_at, 'local'), updated_at: toMemDate(r.updated_at, 'local')
    })
  },
  {
    colecao: 'services', tabela: 'services', pk: 'id', dateOut: 'local',
    toPg: (s) => ({
      id: s.id, barbershop_id: s.barbershop_id, name: s.name, category: s.category || '',
      description: s.description || '', duration_min: s.duration_min, price: s.price,
      active: tagBool(s.active), sort_order: s.sort_order || 0,
      created_at: toPgDate(s.created_at) || new Date(), updated_at: toPgDate(s.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, name: r.name, category: r.category,
      description: r.description, duration_min: r.duration_min,
      price: Number(r.price), active: r.active ? 1 : 0, sort_order: r.sort_order,
      created_at: toMemDate(r.created_at, 'local')
    })
  },
  {
    colecao: 'professionals', tabela: 'professionals', pk: 'id', dateOut: 'local',
    toPg: (p) => ({
      id: p.id, barbershop_id: p.barbershop_id, user_id: p.user_id || null, name: p.name,
      color: p.color || null, bio: p.bio || '', phone: p.phone || '',
      is_active: tagBool(p.is_active),
      created_at: toPgDate(p.created_at) || new Date(), updated_at: toPgDate(p.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, user_id: r.user_id, name: r.name,
      color: r.color, bio: r.bio, phone: r.phone, is_active: r.is_active ? 1 : 0,
      created_at: toMemDate(r.created_at, 'local')
    })
  },
  {
    colecao: 'professional_services', tabela: 'professional_services', pk: ['professional_id', 'service_id'],
    toPg: (ps) => ({ professional_id: ps.professional_id, service_id: ps.service_id, price_override: ps.price_override }),
    toMem: (r) => ({ professional_id: r.professional_id, service_id: r.service_id, price_override: r.price_override })
  },
  {
    colecao: 'working_hours', tabela: 'working_hours', pk: 'id',
    toPg: (w) => ({
      id: w.id, barbershop_id: w.barbershop_id, professional_id: w.professional_id || null,
      day_of_week: w.day_of_week, start_time: hhmmToTime(w.start_time), end_time: hhmmToTime(w.end_time),
      lunch_start: hhmmToTime(w.lunch_start), lunch_end: hhmmToTime(w.lunch_end),
      is_open: tagBool(w.is_open)
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, professional_id: r.professional_id,
      day_of_week: r.day_of_week, start_time: timeToHHMM(r.start_time), end_time: timeToHHMM(r.end_time),
      lunch_start: timeToHHMM(r.lunch_start), lunch_end: timeToHHMM(r.lunch_end),
      is_open: r.is_open ? 1 : 0
    })
  },
  {
    colecao: 'schedule_exceptions', tabela: 'schedule_exceptions', pk: 'id', dateOut: 'local',
    toPg: (e) => ({
      id: e.id, barbershop_id: e.barbershop_id, professional_id: e.professional_id || null,
      type: e.type, starts_at: toPgDate(e.starts_at), ends_at: toPgDate(e.ends_at), reason: e.reason
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, professional_id: r.professional_id,
      type: r.type, starts_at: toMemDate(r.starts_at, 'local'), ends_at: toMemDate(r.ends_at, 'local'),
      reason: r.reason
    })
  },
  {
    colecao: 'clients', tabela: 'clients', pk: 'id', dateOut: 'local',
    toPg: (c) => ({
      id: c.id, barbershop_id: c.barbershop_id, name: c.name, phone: c.phone ? c.phone : null,
      email: c.email || '', notes: c.notes || '', total_visits: c.total_visits || 0,
      total_spent: c.total_spent || 0, last_visit_at: toPgDate(c.last_visit_at), user_id: c.user_id || null,
      created_at: toPgDate(c.created_at) || new Date(), updated_at: toPgDate(c.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, name: r.name, phone: r.phone, email: r.email,
      notes: r.notes, total_visits: r.total_visits, total_spent: Number(r.total_spent || 0),
      last_visit_at: toMemDate(r.last_visit_at, 'local'), user_id: r.user_id,
      created_at: toMemDate(r.created_at, 'local')
    })
  },
  {
    colecao: 'plans', tabela: 'plans', pk: 'id', dateOut: 'iso',
    toPg: (p) => ({
      id: p.id, name: p.name, price_monthly: p.price_monthly, price_annual: p.price_annual || 0, price_per_employee: p.price_per_employee || 0,
      price_compare: p.price_compare != null ? p.price_compare : null,
      max_professionals: p.max_professionals, max_dependents: p.max_dependents, features: knexArr(p.features || []),
      permissions: knexArr(p.permissions || []), is_free: !!p.is_free, active: tagBool(p.active),
      nivel_relatorio: p.nivel_relatorio || null,
      created_at: toPgDate(p.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, name: r.name, price_monthly: Number(r.price_monthly), price_annual: Number(r.price_annual || 0), price_per_employee: Number(r.price_per_employee || 0),
      price_compare: r.price_compare != null ? Number(r.price_compare) : null,
      max_professionals: r.max_professionals, max_dependents: r.max_dependents, features: r.features || [], permissions: r.permissions || [],
      is_free: !!r.is_free, active: r.active ? 1 : 0, nivel_relatorio: r.nivel_relatorio || null,
      created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'subscriptions', tabela: 'subscriptions', pk: 'id', dateOut: 'local',
    toPg: (s) => ({
      id: s.id, barbershop_id: s.barbershop_id, plan_id: s.plan_id, status: s.status,
      trial_ends_at: toPgDate(s.trial_ends_at), current_period_end: toPgDate(s.current_period_end),
      trial_usado: !!s.trial_usado,
      created_at: toPgDate(s.created_at) || new Date(), updated_at: toPgDate(s.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, plan_id: r.plan_id, status: r.status,
      trial_ends_at: toMemDate(r.trial_ends_at, 'date'), current_period_end: toMemDate(r.current_period_end, 'date'),
      trial_usado: !!r.trial_usado,
      created_at: toMemDate(r.created_at, 'local'), updated_at: toMemDate(r.updated_at, 'local')
    })
  },
  {
    colecao: 'payments', tabela: 'payments', pk: 'id', dateOut: 'iso',
    toPg: (p) => ({
      id: p.id, barbershop_id: p.barbershop_id, plan_id: p.plan_id || null, amount_cents: p.amount_cents,
      status: p.status || 'pending', provider: p.provider || 'demo', abacate_id: p.abacate_id,
      br_code: p.br_code, qr_base64: p.qr_base64, dev_mode: tagBool(p.dev_mode),
      refunded_at: toPgDate(p.refunded_at), refund_reason: p.refund_reason || null, refund_id: p.refund_id || null,
      created_at: toPgDate(p.created_at) || new Date(), expires_at: toPgDate(p.expires_at), paid_at: toPgDate(p.paid_at)
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, plan_id: r.plan_id, amount_cents: r.amount_cents,
      status: r.status, provider: r.provider, abacate_id: r.abacate_id, br_code: r.br_code,
      qr_base64: r.qr_base64, dev_mode: r.dev_mode ? 1 : 0,
      refunded_at: toMemDate(r.refunded_at, 'iso'), refund_reason: r.refund_reason || null, refund_id: r.refund_id || null,
      created_at: toMemDate(r.created_at, 'iso'), expires_at: toMemDate(r.expires_at, 'iso'), paid_at: toMemDate(r.paid_at, 'iso')
    })
  },
  {
    colecao: 'audit_log', tabela: 'audit_log', pk: 'id', dateOut: 'iso',
    toPg: (a) => ({
      id: a.id, user_id: a.user_id || null, acao: a.acao, extra: a.extra || null,
      ip_address: a.ip_address || null, timestamp: toPgDate(a.timestamp) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, user_id: r.user_id, acao: r.acao, extra: r.extra,
      ip_address: r.ip_address, timestamp: toMemDate(r.timestamp, 'iso')
    })
  },
  {
    colecao: 'appointments', tabela: 'appointments', pk: 'id', dateOut: 'local',
    toPg: (a) => ({
      id: a.id, barbershop_id: a.barbershop_id, client_id: a.client_id || null,
      professional_id: a.professional_id || null, user_id: a.user_id || null,
      client_name: a.client_name, client_phone: a.client_phone || '', client_email: a.client_email || '',
      starts_at: toPgDate(a.starts_at), ends_at: toPgDate(a.ends_at), status: a.status, origin: a.origin || 'online',
      price_total: a.price_total, cancellation_reason: a.cancellation_reason, notes: a.notes,
      lembrete_email_em: toPgDate(a.lembrete_email_em) || null,
      lembrete_dia_email_em: toPgDate(a.lembrete_dia_email_em) || null,
      created_at: toPgDate(a.created_at) || new Date(), updated_at: toPgDate(a.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, client_id: r.client_id, professional_id: r.professional_id,
      user_id: r.user_id, client_name: r.client_name, client_phone: r.client_phone, client_email: r.client_email,
      starts_at: toMemDate(r.starts_at, 'local'), ends_at: toMemDate(r.ends_at, 'local'),
      status: r.status, origin: r.origin, price_total: Number(r.price_total || 0),
      cancellation_reason: r.cancellation_reason, notes: r.notes,
      lembrete_email_em: r.lembrete_email_em ? toMemDate(r.lembrete_email_em, 'local') : null,
      lembrete_dia_email_em: r.lembrete_dia_email_em ? toMemDate(r.lembrete_dia_email_em, 'local') : null,
      created_at: toMemDate(r.created_at, 'local')
    })
  },
  {
    colecao: 'appointment_services', tabela: 'appointment_services', pk: 'id',
    toPg: (as) => ({
      id: as.id, appointment_id: as.appointment_id, service_id: as.service_id,
      name_snapshot: as.name_snapshot, price_snapshot: as.price_snapshot, duration_snapshot: as.duration_snapshot
    }),
    toMem: (r) => ({
      id: r.id, appointment_id: r.appointment_id, service_id: r.service_id,
      name_snapshot: r.name_snapshot, price_snapshot: Number(r.price_snapshot), duration_snapshot: r.duration_snapshot
    })
  },
  {
    colecao: 'reviews', tabela: 'reviews', pk: 'id', dateOut: 'local',
    toPg: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, user_id: r.user_id || null, rating: r.rating,
      comment: r.comment, created_at: toPgDate(r.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, user_id: r.user_id, rating: r.rating,
      comment: r.comment, created_at: toMemDate(r.created_at, 'local')
    })
  },
  {
    colecao: 'gallery_images', tabela: 'gallery_images', pk: 'id', dateOut: 'iso',
    toPg: (g) => ({
      id: g.id, barbershop_id: g.barbershop_id, url: g.url, caption: g.caption,
      sort_order: g.sort_order || 0, created_at: toPgDate(g.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, url: r.url, caption: r.caption,
      sort_order: r.sort_order, created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'notifications', tabela: 'notifications', pk: 'id', dateOut: 'iso',
    toPg: (n) => ({
      id: n.id, barbershop_id: n.barbershop_id || null, user_id: n.user_id || null,
      type: n.type, title: n.title, message: n.message, read: tagBool(n.read),
      created_at: toPgDate(n.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, user_id: r.user_id, type: r.type, title: r.title,
      message: r.message, read: r.read ? 1 : 0, created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'tickets', tabela: 'tickets', pk: 'id', dateOut: 'iso',
    toPg: (t) => ({
      id: t.id, salao_id: t.salao_id || null, user_id: t.user_id || null, subject: t.subject,
      message: t.message, status: t.status || 'aberto', resposta: t.resposta != null ? t.resposta : null,
      created_at: toPgDate(t.created_at) || new Date(), updated_at: toPgDate(t.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, salao_id: r.salao_id, user_id: r.user_id, subject: r.subject, message: r.message,
      status: r.status, resposta: r.resposta != null ? r.resposta : null,
      created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'magic_tokens', tabela: 'magic_tokens', pk: 'id', dateOut: 'iso',
    toPg: (m) => ({
      id: m.id, token: m.token, user_id: m.user_id || null, email: m.email || null,
      expires_at: toPgDate(m.expires_at), used: tagBool(m.used), created_at: toPgDate(m.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, token: r.token, user_id: r.user_id, email: r.email,
      expires_at: toMemDate(r.expires_at, 'iso'), used: r.used ? 1 : 0, created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'superadmin_sessions', tabela: 'superadmin_sessions', pk: 'id', dateOut: 'iso',
    toPg: (s) => ({
      id: s.id, token: s.token, email: s.email, created_at: toPgDate(s.created_at) || new Date(), expires_at: toPgDate(s.expires_at)
    }),
    toMem: (r) => ({
      id: r.id, token: r.token, email: r.email, created_at: toMemDate(r.created_at, 'iso'), expires_at: toMemDate(r.expires_at, 'iso')
    })
  },
  {
    colecao: 'reports', tabela: 'reports', pk: 'id', dateOut: 'iso',
    toPg: (r) => ({
      id: r.id, reporter_user_id: r.reporter_user_id || null, reporter_role: r.reporter_role || null,
      reporter_name: r.reporter_name || null, target_type: r.target_type,
      target_user_id: r.target_user_id || null,
      target_barbershop_id: r.target_barbershop_id || null,
      target_client_id: r.target_client_id || null,
      target_display: r.target_display || null,
      reason: r.reason, description: r.description != null ? r.description : null,
      status: r.status || 'pendente', status_note: r.status_note != null ? r.status_note : null,
      created_at: toPgDate(r.created_at) || new Date(), updated_at: toPgDate(r.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, reporter_user_id: r.reporter_user_id, reporter_role: r.reporter_role,
      reporter_name: r.reporter_name, target_type: r.target_type,
      target_user_id: r.target_user_id, target_barbershop_id: r.target_barbershop_id,
      target_client_id: r.target_client_id, target_display: r.target_display,
      reason: r.reason, description: r.description != null ? r.description : null,
      status: r.status, status_note: r.status_note != null ? r.status_note : null,
      created_at: toMemDate(r.created_at, 'iso'), updated_at: toMemDate(r.updated_at, 'iso')
    })
  },
  {
    colecao: 'blocked_clients', tabela: 'blocked_clients', pk: ['barbershop_id', 'client_id'], dateOut: 'iso',
    toPg: (b) => ({
      barbershop_id: b.barbershop_id, client_id: b.client_id,
      created_at: toPgDate(b.created_at) || new Date()
    }),
    toMem: (r) => ({
      barbershop_id: r.barbershop_id, client_id: r.client_id,
      created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'relatorios_diarios', tabela: 'relatorios_diarios', pk: 'id', dateOut: 'date',
    toPg: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, data: r.data,
      faturamento: r.faturamento, agendamentos: r.agendamentos || 0,
      ticket: r.ticket != null ? r.ticket : null,
      faixa_pico: r.faixa_pico != null ? r.faixa_pico : null,
      created_at: toPgDate(r.created_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, barbershop_id: r.barbershop_id, data: toMemDate(r.data, 'date'),
      faturamento: Number(r.faturamento) || 0, agendamentos: r.agendamentos || 0,
      ticket: r.ticket != null ? Number(r.ticket) : null,
      faixa_pico: r.faixa_pico != null ? r.faixa_pico : null,
      created_at: toMemDate(r.created_at, 'iso')
    })
  },
  {
    colecao: 'platform_settings', tabela: 'platform_settings', pk: 'chave', dateOut: 'iso',
    toPg: (s) => ({
      chave: s.chave, valor: knexJson(s.valor || {}),
      updated_at: toPgDate(s.updated_at) || new Date()
    }),
    toMem: (r) => ({
      chave: r.chave, valor: r.valor || {},
      updated_at: toMemDate(r.updated_at, 'iso')
    })
  },
  {
    colecao: 'reembolsos', tabela: 'reembolsos', pk: 'id', dateOut: 'iso',
    toPg: (r) => ({
      id: r.id, user_id: r.user_id, barbershop_id: r.barbershop_id || null,
      temporary_pix_key: r.temporary_pix_key, reason: r.reason,
      status: r.status || 'PENDENTE_GMAIL', visible_to_admin: tagBool(r.visible_to_admin),
      created_at: toPgDate(r.created_at) || new Date(), updated_at: toPgDate(r.updated_at) || new Date()
    }),
    toMem: (r) => ({
      id: r.id, user_id: r.user_id, barbershop_id: r.barbershop_id,
      temporary_pix_key: r.temporary_pix_key, reason: r.reason,
      status: r.status, visible_to_admin: r.visible_to_admin ? 1 : 0,
      created_at: toMemDate(r.created_at, 'iso'), updated_at: toMemDate(r.updated_at, 'iso')
    })
  }
];

/* helpers de serialização JSON/array para tipos PG */
function knexJson(v) { return (v == null) ? null : JSON.stringify(v); }
function knexJsonArr(arr) {
  // JSONB[] (array de objetos) — array de JSON strings; o writer monta ARRAY[...]::jsonb[]
  return (arr || []).map(x => (typeof x === 'string' ? x : JSON.stringify(x)));
}
function knexArr(arr) { return arr || []; }

/* Tipos SQL por coluna para casts explícitos no upsert.
   Colunas não listadas são tratadas como texto/valor simples. */
const CASTS = {
  users: { role: 'usr_role', prefs: 'jsonb', consentimentos: 'jsonb[]', barbershop_id: 'uuid', created_at: 'timestamptz', updated_at: 'timestamptz' },
  sessions: { user_id: 'uuid', expires_at: 'timestamptz', created_at: 'timestamptz' },
  sms_codes: { expires_at: 'timestamptz', next_allowed_at: 'timestamptz', created_at: 'timestamptz', payload: 'jsonb' },
  barbershops: { owner_user_id: 'uuid', uf: null, lat: 'numeric', lng: 'numeric', tags: 'text[]', rating_base: 'numeric', slot_interval_min: 'int', views: 'int', created_at: 'timestamptz', updated_at: 'timestamptz' },
  services: { barbershop_id: 'uuid', price: 'numeric', duration_min: 'int', sort_order: 'int', updated_at: 'timestamptz', created_at: 'timestamptz' },
  professionals: { barbershop_id: 'uuid', user_id: 'uuid', is_active: 'boolean', created_at: 'timestamptz', updated_at: 'timestamptz' },
  professional_services: { professional_id: 'uuid', service_id: 'uuid', price_override: 'numeric' },
  working_hours: { barbershop_id: 'uuid', professional_id: 'uuid', day_of_week: 'int', start_time: 'time', end_time: 'time', lunch_start: 'time', lunch_end: 'time', is_open: 'boolean' },
  schedule_exceptions: { barbershop_id: 'uuid', professional_id: 'uuid', type: 'exc_tipo', starts_at: 'timestamptz', ends_at: 'timestamptz' },
  clients: { barbershop_id: 'uuid', user_id: 'uuid', total_spent: 'numeric', last_visit_at: 'timestamptz', created_at: 'timestamptz', updated_at: 'timestamptz' },
  plans: { max_professionals: 'int', max_dependents: 'int', features: 'text[]', permissions: 'text[]', is_free: 'boolean', price_monthly: 'numeric', price_annual: 'numeric', price_per_employee: 'numeric', price_compare: 'numeric', created_at: 'timestamptz' },
  subscriptions: { barbershop_id: 'uuid', plan_id: 'uuid', status: 'sub_status', trial_ends_at: 'timestamptz', current_period_end: 'timestamptz', created_at: 'timestamptz', updated_at: 'timestamptz' },
  payments: { barbershop_id: 'uuid', plan_id: 'uuid', status: 'pay_status', dev_mode: 'boolean', refunded_at: 'timestamptz', created_at: 'timestamptz', expires_at: 'timestamptz', paid_at: 'timestamptz' },
  appointments: { barbershop_id: 'uuid', client_id: 'uuid', professional_id: 'uuid', user_id: 'uuid', status: 'ag_status', origin: 'ag_origin', price_total: 'numeric', starts_at: 'timestamptz', ends_at: 'timestamptz', lembrete_email_em: 'timestamptz', lembrete_dia_email_em: 'timestamptz', created_at: 'timestamptz', updated_at: 'timestamptz' },
  appointment_services: { appointment_id: 'uuid', service_id: 'uuid', price_snapshot: 'numeric' },
  reviews: { barbershop_id: 'uuid', user_id: 'uuid', rating: 'int', created_at: 'timestamptz' },
  gallery_images: { barbershop_id: 'uuid', sort_order: 'int', created_at: 'timestamptz' },
  notifications: { barbershop_id: 'uuid', user_id: 'uuid', read: 'boolean', created_at: 'timestamptz' },
  tickets: { salao_id: 'uuid', user_id: 'uuid', status: 'tik_status', created_at: 'timestamptz', updated_at: 'timestamptz' },
  magic_tokens: { user_id: 'uuid', used: 'boolean', expires_at: 'timestamptz', created_at: 'timestamptz' },
  superadmin_sessions: { expires_at: 'timestamptz', created_at: 'timestamptz' },
  audit_log: { user_id: 'uuid', extra: 'jsonb', ip_address: 'inet', timestamp: 'timestamptz' },
  reports: { reporter_user_id: 'uuid', target_type: 'report_target', target_user_id: 'uuid', target_barbershop_id: 'uuid', target_client_id: 'uuid', status: 'report_status', created_at: 'timestamptz', updated_at: 'timestamptz' },
  blocked_clients: { barbershop_id: 'uuid', client_id: 'uuid', created_at: 'timestamptz' },
  relatorios_diarios: { barbershop_id: 'uuid', data: 'date', faturamento: 'numeric', agendamentos: 'int', ticket: 'numeric', created_at: 'timestamptz' },
  platform_settings: { valor: 'jsonb', updated_at: 'timestamptz' },
  reembolsos: { user_id: 'uuid', barbershop_id: 'uuid', status: 'reimb_status', visible_to_admin: 'boolean', created_at: 'timestamptz', updated_at: 'timestamptz' }
};

const BY_COLECAO = {};
MAP.forEach(m => { BY_COLECAO[m.colecao] = m; });
// 'favorites' não é uma tabela no schema (22 tabelas) — mantido só em memória
BY_COLECAO.favorites = null;

module.exports = { MAP, BY_COLECAO, CASTS, toPgDate, toMemDate };
