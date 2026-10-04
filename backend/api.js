/* ============================================================
   Corte Comigo – local-api.js  (PRD v2 · RNF-03 / Seção 3)
   Camada de API local que ESPELHA os contratos REST do backend v1:
   mesmos paths lógicos, payloads e respostas; erros simulados via
   throw { status, error } (códigos HTTP simulados).
   Requer db.js + auth.js carregados antes.
   ============================================================ */

window.API = (function () {
  'use strict';

  var Mailer = require('./mailer');
  /* ================= helpers ================= */

  function _db() { return DB._d(); }

  /* Índices por chave para as varreduras aninhadas.
     O padrão "para cada X, filtre o array inteiro de Y" é O(n·m): o painel
     super-admin filtra TODOS os agendamentos uma vez por loja e uma vez por
     usuário, e o job de lembretes filtra appointment_services uma vez por
     agendamento — com 100k agendamentos isso são centenas de milhões de
     comparações dentro do event loop, o que trava o servidor inteiro (e
     expira requisição, virando 503).
     Aqui o mapa é montado uma vez (O(n)) e cada item resolve em O(1), com
     resultado idêntico. Nada é guardado entre chamadas, então não existe
     risco de índice desatualizado. */

  /* grupo -> lista de itens: _idx(db.appointments, 'barbershop_id') */
  function _idx(arr, chave) {
    var m = new Map();
    if (!arr) return m;
    for (var i = 0; i < arr.length; i++) {
      var o = arr[i];
      if (o == null || o[chave] == null) continue;
      var k = o[chave];
      var l = m.get(k);
      if (!l) { l = []; m.set(k, l); }
      l.push(o);
    }
    return m;
  }

  /* chave -> único item, com a mesma semântica de Array.find
     (o PRIMEIRO que casa vence, não o último). */
  function _um(arr, chave) {
    var m = new Map();
    if (!arr) return m;
    for (var i = 0; i < arr.length; i++) {
      var o = arr[i];
      if (o == null || o[chave] == null) continue;
      if (!m.has(o[chave])) m.set(o[chave], o);
    }
    return m;
  }

  function _conta(lista) { return lista ? lista.length : 0; }

  function err(status, error) { throw { status, error }; }

  function agoraISO() { return new Date().toISOString(); }
  function agoraLocal() { return DB.hojeISO() + 'T' + DB.minToHHMM(DB.agoraMinutos()); }

  /* Telefone canônico: só dígitos, com o DDI 55 removido quando o número
     já vem com ele. Sem isso "+55 11 99999-0000" e "11999990000" viravam
     duas contas diferentes (e dois phone_hash distintos). */
  function normalizarTelefone(v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    if (d.length > 11 && d.slice(0, 2) === '55') d = d.slice(2);
    return d;
  }

  /* ================= LGPD — Auditoria ================= */

  function _auditLog(userId, acao, extra) {
    var d = DB._d();
    d.audit_log = d.audit_log || [];
    d.audit_log.push({
      id: DB.proximoId(),
      user_id: userId,
      acao: acao,
      extra: extra || null,
      timestamp: new Date().toISOString()
    });
    /* manter apenas últimos 1000 registros */
    if (d.audit_log.length > 1000) {
      d.audit_log = d.audit_log.slice(-1000);
    }
    DB.salvar();
  }

  function meusLogsDeAcesso() {
    var user = sessao();
    var d = DB._d();
    var desde = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    return (d.audit_log || []).filter(function(l) {
      return l.user_id === user.id && l.timestamp >= desde;
    }).sort(function(a, b) { return b.timestamp > a.timestamp ? 1 : -1; });
  }

  function clampInt(v, min, max, def) {
    const n = parseInt(v, 10);
    if (isNaN(n)) return def;
    return Math.max(min, Math.min(max, n));
  }

  /* ---------- sessão / papéis (RF-011, RNF-06) ---------- */

  function sessao() {
    const u = Auth.usuarioAtual();
    if (!u) err(401, 'Sessão expirada. Faça login novamente.');
    return u;
  }

  function exigirDono() {
    const user = sessao();
    const shop = Auth.salaoDoUsuario(user);
    if (!shop) err(404, 'Nenhum salão vinculado a esta conta.');
    if (user.role !== 'dono') {
      /* Dependente/Funcionário: bloqueio explícito de relatórios
         financeiros/gerenciais e de toda ação exclusiva do dono. */
      if (user.role === 'dependente') {
        err(403, 'Acesso restrito: a conta Dependente não pode acessar relatórios financeiros/gerenciais nem essa área do dono.');
      }
      err(403, 'Acesso restrito ao dono do salão.');
    }
    return { user, shop };
  }

  /* Dono ou barbeiro ajudante da loja: podem gerenciar o vínculo dos
     dependentes (visualizar e desligar). Dependente/cliente não. */
  function exigirDonoOuBarbeiro() {
    const user = sessao();
    const shop = Auth.salaoDoUsuario(user);
    if (!shop) err(404, 'Nenhum salão vinculado a esta conta.');
    if (user.role !== 'dono' && user.role !== 'barbeiro') {
      err(403, 'Acesso restrito ao dono ou barbeiro do salão.');
    }
    return { user, shop };
  }

  /* Equipe = dono, barbeiro ajudante OU dependente (funcionário) da
     loja. Libera agenda e clientes; relatórios financeiros/gerenciais
     continuam exclusivos do dono (exigirDono). */
  function exigirEquipe() {
    const user = sessao();
    const shop = Auth.salaoDoUsuario(user);
    if (!shop) err(404, 'Nenhum salão vinculado a esta conta.');
    if (user.role !== 'dono' && user.role !== 'barbeiro' && user.role !== 'dependente') {
      err(403, 'Acesso restrito à equipe do salão.');
    }
    return { user, shop };
  }

  /**
   * Travamento por funcionalidade (planos v3).
   *
   * O plano EFETIVO de uma loja é o da assinatura vigente (trial em
   * andamento ou período pago corrente). Fora isso (sem assinatura,
   * expirada ou cancelada) a loja fica sem plano —
   * leituras continuam liberadas, escritas exigem a permissão do plano.
   */
  function planoFree() {
    const db = DB._d();
    return db.plans.find(p => p.is_free) ||
      db.plans.find(p => String(p.name || '').toLowerCase() === 'free') || null;
  }

  function planoEfetivo(shopId) {
    const db = DB._d();
    const sub = db.subscriptions.find(s => s.barbershop_id == shopId);
    let liberado = false;
    try {
      liberado = typeof window.API.acessoLiberado === 'function'
        ? window.API.acessoLiberado(shopId)
        : false;
    } catch (e) { liberado = false; }
    if (sub && liberado) {
      const plano = db.plans.find(p => p.id === sub.plan_id);
      if (plano) return { sub, plano };
    }
    if (modoGratuito()) return { sub: sub || null, plano: planoGratuitoPlataforma() };
    return { sub: sub || null, plano: null };
  }

  /* Permissões do plano (RF-066). */
  function funcionalidadesDe(shopId) {
    const { plano } = planoEfetivo(shopId);
    if (!plano) return [];
    if (!Array.isArray(plano.permissions) || plano.permissions.length === 0) {
      return [];
    }
    return plano.permissions;
  }

  function temFuncionalidade(shopId, chave) {
    const lista = funcionalidadesDe(shopId);
    /* 'relatorios' é a permissão-mãe de relatorios/relatorios_diario. */
    return lista.includes(chave) || lista.includes('relatorios');
  }

  function exigirFuncionalidade(shopId, chave, descricao) {
    exigirAssinaturaAtiva(shopId);
    if (!temFuncionalidade(shopId, chave)) {
      const { plano } = planoEfetivo(shopId);
      const alvo = (plano && plano.name) || 'um plano pago';
      throw {
        status: 403,
        error: (descricao || chave) + ' está bloqueado no seu plano (' + alvo +
          '). Assine ou faça upgrade na aba Assinatura para liberar.'
      };
    }
  }
  const _PERMISSOES_COMPLETAS = ['servicos', 'profissionais', 'clientes', 'agendar',
    'horarios', 'galeria', 'relatorios', 'notificacoes', 'exportar_csv'];

  /* ---------------- Modo plataforma grátis (config global) ----------------
     O super-admin pode ligar "site_gratis": nesse modo TODAS as lojas têm
     acesso completo (funcionalidades e relatórios), sem exigir assinatura
     ativa. Os preços cadastrados permanecem intactos para quando o modo
     for desligado. */

  function modoGratuito() {
    try {
      const st = (_db().platform_settings || []).find(s => s.chave === 'site_gratis');
      return !!(st && st.valor && st.valor.ativo);
    } catch (e) { return false; }
  }

  function definirModoGratuito(ativo) {
    const db = _db();
    db.platform_settings = db.platform_settings || [];
    let st = db.platform_settings.find(s => s.chave === 'site_gratis');
    if (!st) {
      st = { chave: 'site_gratis', valor: {}, updated_at: agoraISO() };
      db.platform_settings.push(st);
    }
    st.valor = { ativo: !!ativo };
    st.updated_at = agoraISO();
    DB.salvar();
    return { site_gratis: !!ativo };
  }

  /* ---------- Trial "10 dias grátis" para novas contas (config global) ----------
     O super-admin liga/desliga a promoção. DESLIGADA: nenhuma assinatura nova
     entra em trial (a função deixa de existir); trials já em andamento seguem
     até o fim. LIGADA (padrão quando a chave não existe): novas contas podem
     iniciar os 10 dias grátis ao escolher um plano. */
  function modoTrialAtivo() {
    try {
      const st = (_db().platform_settings || []).find(s => s.chave === 'trial_10dias');
      if (!st || !st.valor) return true;
      return st.valor.ativo !== false;
    } catch (e) { return true; }
  }

  function definirModoTrial(ativo) {
    const db = _db();
    db.platform_settings = db.platform_settings || [];
    let st = db.platform_settings.find(s => s.chave === 'trial_10dias');
    if (!st) {
      st = { chave: 'trial_10dias', valor: {}, updated_at: agoraISO() };
      db.platform_settings.push(st);
    }
    st.valor = { ativo: !!ativo };
    st.updated_at = agoraISO();
    DB.salvar();
    return { trial_10dias: !!ativo };
  }

  function planoGratuitoPlataforma() {
    return {
      id: '__plataforma_gratis__', name: 'Grátis (plataforma)', is_free: true,
      permissions: _PERMISSOES_COMPLETAS.slice(), features: [],
      nivel_relatorio: 'completo', max_professionals: null,
      price_monthly: 0, price_annual: 0, price_per_employee: 0
    };
  }

  /* Bloqueia ações produtivas do dono quando não há assinatura ativa
     (sistema de cobrança). Leituras seguem liberadas; o frontend redireciona
     para a tela de assinatura ao receber code 'assinatura_necessaria'. */
  function exigirAssinaturaAtiva(shopId) {
    if (modoGratuito()) return;
    let liberado = false;
    try {
      liberado = typeof window.API.acessoLiberado === 'function'
        ? window.API.acessoLiberado(shopId)
        : false;
    } catch (e) { liberado = false; }
    if (!liberado) {
      throw {
        status: 402, code: 'assinatura_necessaria',
        error: 'Sua assinatura está inativa. Assine na aba Assinatura para liberar esta ação.'
      };
    }
  }

  function podeVerAgendamento(user, ag) {
    if (!user) return false;
    if (ag.user_id === user.id) return true;
    const loja = DB._d().barbershops.find(b => b.id === ag.barbershop_id);
    return !!(loja && loja.owner_user_id === user.id);
  }

  /* ---------- avaliações agregadas (RF-056) ---------- */

  function ratingDeLoja(shopId) {
    const db = DB._d();
    const loja = db.barbershops.find(b => b.id == shopId);
    if (!loja) return { media: 0, count: 0 };
    const avs = db.reviews.filter(r => r.barbershop_id == shopId);
    const soma = avs.reduce((a, r) => a + r.rating, 0);
    const baseCount = loja.ratingCountBase || 0;
    const baseSum = (loja.ratingBase || 0) * baseCount;
    const total = baseCount + avs.length;
    const mediaNum = total ? ((baseSum + soma) / total) : 0;
    return { media: Math.round(mediaNum * 10) / 10, count: total };
  }

  /* ================= BARBERSHOPS (RF-012..017) ================= */

  function listarLojasPublicas(opts) {
    opts = opts || {};
    const db = DB._d();
    const limite = clampInt(opts.limit, 1, 100, 100);
    const page = clampInt(opts.page, 1, 9999, 1);
    let lista = db.barbershops.slice();

    const q = String(opts.q || '').toLowerCase().trim();
    if (q) lista = lista.filter(l =>
      l.name.toLowerCase().includes(q) ||
      (l.description || '').toLowerCase().includes(q) ||
      (l.city || '').toLowerCase().includes(q));

    lista.sort((a, b) => a.name.localeCompare(b.name));
    const total = lista.length;
    const items = lista.slice((page - 1) * limite, page * limite).map(lojaPublica);
    return { items, total, page, limit: limite };
  }

function statsDeAgendamentos(shopId) {
    const db = DB._d();
    const todos = (db.appointments || []).filter(a => a.barbershop_id == shopId);
    const total = todos.length;
    const dias = new Set();
    todos.forEach(a => dias.add(String(a.starts_at || a.created_at || '').slice(0, 10)));
    const diasCom = dias.size;
    return {
      total_agendamentos: total,
      media_agendamentos_dia: diasCom ? Math.round((total / diasCom) * 10) / 10 : 0
    };
  }

  function registrarVisualizacao(shopId) {
    const db = DB._d();
    const l = db.barbershops.find(b => b.id == shopId);
    if (!l) err(404, 'Salão não encontrado.');
    l.views = (l.views || 0) + 1;
    DB.salvar();
    return { views: l.views };
  }

function lojaPublica(l) {
    const r = ratingDeLoja(l.id);
    const stats = statsDeAgendamentos(l.id);
    return {
      id: l.id, name: l.name, slug: l.slug, description: l.description || '',
      address: l.address || '', city: l.city || '', uf: l.uf || '',
      phone: l.phone || '', whatsapp: l.whatsapp || '', instagram: l.instagram || '',
      logo_url: l.logo_url || null, cover_url: l.cover_url || null,
      tags: l.tags || [],
      lat: l.lat ?? null, lng: l.lng ?? null,
      rating_avg: r.media, rating_count: r.count,
      views: l.views || 0,
      total_agendamentos: stats.total_agendamentos,
      media_agendamentos_dia: stats.media_agendamentos_dia,
      created_at: l.created_at
    };
  }

  function getLoja(id) {
    const l = DB._d().barbershops.find(x => x.id == id);
    if (!l) err(404, 'Salão não encontrado.');
    return lojaPublica(l);
  }

  function minhaLoja() {
    const { user, shop } = exigirDono();
    const sub = DB._d().subscriptions.find(s => s.barbershop_id === shop.id);
    const plano = sub && DB._d().plans.find(p => p.id === sub.plan_id);
    return Object.assign({}, shop, { subscription: sub ? assinaturaPublica(sub) : null });
  }

  function atualizarLoja(patch) {
    const { shop } = exigirDono();
    if (patch.slot_interval_min !== undefined && patch.slot_interval_min !== null) {
      const v = clampInt(patch.slot_interval_min, 5, 180, 15);
      shop.slotIntervalMin = v;
      shop.slot_interval_min = v;
      /* RF-035: definir o intervalo também habilita a agenda para o cliente */
      shop.horarios_configurados = 1;
    }
    const campos = ['name', 'description', 'phone', 'email', 'whatsapp',
      'instagram', 'address', 'city', 'uf', 'logo_url', 'cover_url', 'tags',
      'lat', 'lng'];
    campos.forEach(c => {
      if (patch[c] !== undefined) shop[c] = patch[c];
    });
    if (!shop.name.trim()) err(400, 'Nome do salão é obrigatório.');
    shop.updated_at = agoraISO();
    DB.salvar();
    localStorage.setItem('barbershop', JSON.stringify(shop));
    return shop;
  }

  function excluirLoja() {
    /* [SEGURANÇA] Só o DONO pode apagar o salão. Antes usava sessao() e
       Auth.salaoDoUsuario, que devolvem loja também para barbeiro e
       dependente — qualquer funcionário logado apagava o salão inteiro. */
    const { user, shop } = exigirDono();
    deletarLojaCascade(shop);
    DB.salvar();
    return { ok: true };
  }

  /** Cascata completa (RF-010/RF-016). */
  function deletarLojaCascade(shop) {
    if (!shop) return;
    const db = DB._d();
    db.services = db.services.filter(s => s.barbershop_id !== shop.id);
    db.professionals = db.professionals.filter(p => p.barbershop_id !== shop.id);
    db.professional_services = db.professional_services.filter(ps =>
      !db.services.some(s => s.barbershop_id === shop.id && s.id === ps.service_id));
    db.working_hours = db.working_hours.filter(w => w.barbershop_id !== shop.id);
    db.schedule_exceptions = db.schedule_exceptions.filter(x => x.barbershop_id !== shop.id);
    db.appointments = db.appointments.filter(a => a.barbershop_id !== shop.id);
    db.gallery_images = db.gallery_images.filter(g => g.barbershop_id !== shop.id);
    db.subscriptions = db.subscriptions.filter(s => s.barbershop_id !== shop.id);
    db.reviews = db.reviews.filter(r => r.barbershop_id !== shop.id);
    db.clients = db.clients.filter(c => c.barbershop_id !== shop.id);
    db.tickets = db.tickets.filter(t => t.salao_id !== shop.id);
    db.barbershops = db.barbershops.filter(b => b.id !== shop.id);
  }

  /* RF-015 — nearby Haversine */
  function lojasProximas(dados) {
    var R = 6371;
    function haversine(a, b) {
      var toRad = function(d) { return d * Math.PI / 180; };
      var dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
      var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
      return 2 * R * Math.asin(Math.sqrt(h));
    }
    var lat = dados.lat, lng = dados.lng;
    var origem = { lat: Number(lat), lng: Number(lng) };
    if (isNaN(origem.lat) || isNaN(origem.lng)) err(400, 'Informe latitude e longitude.');
    var raio = Number(dados.raio) || 20;
    var filtros = { servico: dados.servico, cidade: dados.cidade, precoMax: dados.precoMax };
    var resultado = DB._d().barbershops
      .filter(function(l) { return l.lat != null && l.lng != null; })
      .map(function(l) { return { loja: lojaPublica(l), dist: haversine(origem, l) }; })
      .filter(function(x) { return x.dist <= raio; });
    if (filtros.servico) {
      var sn = filtros.servico.toLowerCase();
      resultado = resultado.filter(function(x) {
        var svcs = DB._d().services.filter(function(s) { return s.barbershop_id === x.loja.id && s.active; });
        return svcs.some(function(s) { return s.name.toLowerCase().indexOf(sn) !== -1; });
      });
    }
    if (filtros.cidade) {
      var cn = filtros.cidade.toLowerCase();
      resultado = resultado.filter(function(x) { return (x.loja.city || '').toLowerCase() === cn; });
    }
    if (filtros.precoMax != null) {
      var pm = Number(filtros.precoMax);
      if (isFinite(pm)) {
        resultado = resultado.filter(function(x) {
          var svcs = DB._d().services.filter(function(s) { return s.barbershop_id === x.loja.id && s.active; });
          return svcs.length === 0 || svcs.every(function(s) { return Number(s.price) <= pm; });
        });
      }
    }
    resultado.sort(function(a, b) { return a.dist - b.dist; });
    return { items: resultado.map(function(x) {
      return Object.assign(x.loja, { distance_km: Math.round(x.dist * 10) / 10 });
    }) };
  }

  function verificarMagicLink(token) {
    var tk = String(token || '').trim();
    if (!tk) err(400, 'Token obrigatório.');
    var all = _db().magic_tokens || [];
    var registro = null;
    for (var i = 0; i < all.length; i++) {
      if (all[i].token === tk && !all[i].used) { registro = all[i]; break; }
    }
    if (!registro) err(404, 'Link inválido ou já utilizado.');
    if (new Date(registro.expires_at) < new Date()) err(410, 'Link expirado. Solicite um novo.');
    registro.used = 1;
    DB.salvar();
    var usuario = (_db().users || []).find(function(u) { return u.id === registro.user_id; });
    if (!usuario) err(404, 'Usuário não encontrado.');
    var sessao = Auth.criarSessao(usuario.id);
    return {
      token: sessao.token,
      user: { id: usuario.id, name: usuario.name, role: usuario.role },
      barbershop: Auth.salaoDoUsuario(usuario)
    };
  }

  /* Envia os lembretes por e-mail (Gmail) de uma data.
     campoMarca: coluna persistida que registra o envio (evita reenvio).
     quando: rótulo exibido no e-mail ("amanhã" / "hoje").
     somenteFuturos: no dia, ignora horários que já passaram. */
  function _enviarLembretesDe(dataAlvo, campoMarca, quando, somenteFuturos) {
    const db = _db();
    const appUrl = process.env.APP_URL || 'http://localhost:3000';
    const agoraMin = somenteFuturos ? DB.agoraMinutos() : null;
    const ags = (db.appointments || []).filter(function(a) {
      if (!a.starts_at || String(a.starts_at).slice(0, 10) !== dataAlvo || a[campoMarca]) return false;
      if (a.status !== 'confirmado' && a.status !== 'pendente') return false;
      if (somenteFuturos && DB.hhmmToMin(String(a.starts_at).slice(11, 16)) < agoraMin) return false;
      return true;
    });
    /* Nada a enviar: não monta índice nenhum (o job roda 2x a cada 30 min
       mesmo em dias sem agendamento). */
    if (!ags.length) return 0;

    /* Mapas montados uma vez. Antes, para CADA agendamento, havia um
       .find em barbershops, um .find em users, um .filter em
       appointment_services e um .find em professionals — ou seja, o custo
       crescia com (agendamentos × serviços) e travava o event loop. */
    const lojasPorId = _um(db.barbershops, 'id');
    const usersPorId = _um(db.users, 'id');
    const profsPorId = _um(db.professionals, 'id');
    const servicosPorAgendamento = _idx(db.appointment_services, 'appointment_id');

    var enviados = 0;
    ags.forEach(function(ag) {
      var loja = lojasPorId.get(ag.barbershop_id);
      if (!loja) return;
      var cli = usersPorId.get(ag.user_id);
      /* link exclusivo para o cliente marcar/ver o salão */
      var linkAgenda = appUrl + '/public/salao-publico.html?id=' + encodeURIComponent(ag.barbershop_id);
      var dados = {
        salaoNome: loja.name,
        servicos: (function() {
          var itens = servicosPorAgendamento.get(ag.id);
          return itens && itens.length ? itens.map(function(i) { return i.name_snapshot || ''; }).join(' + ') : '';
        })(),
        hora: String(ag.starts_at || '').slice(11, 16),
        endereco: loja.address || '',
        appUrl: appUrl,
        linkAgendamento: linkAgenda,
        quando: quando
      };
      var tentouEnviar = false;
      var cliEmail = (cli && cli.email) || ag.client_email || '';
      var cliNome = (cli && cli.name) || ag.client_name || '';
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliEmail)) {
        Mailer.enviarLembrete(cliEmail, Object.assign({ nome: cliNome, isCliente: true }, dados))
          .catch(function() {});
        tentouEnviar = true;
      }
      var prof = profsPorId.get(ag.professional_id);
      if (prof && prof.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(prof.email)) {
        Mailer.enviarLembrete(prof.email, Object.assign({
          nome: prof.name, isCliente: false
        }, dados)).catch(function() {});
        tentouEnviar = true;
      }
      /* marca como enviado (persistido) para o job não reenviar */
      if (tentouEnviar) {
        ag[campoMarca] = agoraISO();
        enviados++;
      }
    });
    if (enviados) DB.salvar();
    return enviados;
  }

  /* Dispara os dois lembretes: 1 dia antes e no próprio dia. */
  function gerarLembretesAmanha() {
    var enviados = 0;
    enviados += _enviarLembretesDe(DB.addDiasISO(1), 'lembrete_email_em', 'amanhã', false);
    enviados += _enviarLembretesDe(DB.hojeISO(), 'lembrete_dia_email_em', 'hoje', true);
    return { enviados: enviados };
  }

  /* ================= SUPER-ADMIN (v2.4) ================= */

  var bcrypt;
  try { bcrypt = require('bcryptjs'); } catch(e) { bcrypt = null; }

  function ensureSuperAdmin() {
    var hash = process.env.SUPER_ADMIN_HASH;
    if (!hash) err(500, 'SUPER_ADMIN_HASH não configurado.');
    var email = (process.env.SUPER_ADMIN_EMAIL || 'admin@cortecomigo.com').toLowerCase();
    var ips = (process.env.SUPER_ADMIN_IPS || '').split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    return { email: email, hash: hash, ips: ips };
  }

  function superAdminLogin(dados) {
    var cfg = ensureSuperAdmin();
    var email = String(dados.email || '').toLowerCase().trim();
    var senha = String(dados.senha || '').trim();
    if (email !== cfg.email) err(401, 'E-mail ou senha incorretos.');
    if (!bcrypt) err(500, 'Módulo bcrypt não disponível.');
    var ok;
    try { ok = bcrypt.compareSync(senha, cfg.hash); } catch(e) { ok = false; }
    if (!ok) err(401, 'E-mail ou senha incorretos.');
    var crypto = require('crypto');
    var token = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    _db().superadmin_sessions = (_db().superadmin_sessions || []).filter(function(s) {
      return s.email !== email;
    });
    _db().superadmin_sessions.push({
      id: DB.proximoId(), token: token, email: email,
      created_at: agoraISO(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    });
    DB.salvar();
    return { token: token, email: email };
  }

  function superAdminAuth(token) {
    var tk = String(token || '').trim();
    if (!tk) err(401, 'Token obrigatório.');
    var sessoes = _db().superadmin_sessions || [];
    var sessao = null;
    for (var i = 0; i < sessoes.length; i++) {
      if (sessoes[i].token === tk) { sessao = sessoes[i]; break; }
    }
    if (!sessao) err(401, 'Sessão inválida.');
    if (new Date(sessao.expires_at) < new Date()) err(401, 'Sessão expirada.');
    return sessao;
  }

  function superAdminLogout(token) {
    var tk = String(token || '').trim();
    _db().superadmin_sessions = (_db().superadmin_sessions || []).filter(function(s) { return s.token !== tk; });
    DB.salvar();
    return { ok: true };
  }

  function saListarLojas() {
    /* Mapas por chave: antes cada loja filtrava o array inteiro de
       agendamentos, profissionais e assinaturas, e vice-versa — O(lojas ×
       agendamentos). Em 300 lojas com 100k agendamentos isso é 30 milhões
       de comparações por clique no painel. */
    var usersPorId = _um(_db().users, 'id');
    var planosPorId = _um(_db().plans, 'id');
    var subsPorLoja = _idx(_db().subscriptions, 'barbershop_id');
    var profsPorLoja = _idx(_db().professionals, 'barbershop_id');
    var agsAtivosPorLoja = new Map();
    (_db().appointments || []).forEach(function(a) {
      if (!a.barbershop_id || a.status === 'cancelado') return;
      agsAtivosPorLoja.set(a.barbershop_id, (agsAtivosPorLoja.get(a.barbershop_id) || 0) + 1);
    });

    var lojas = (_db().barbershops || []).map(function(b) {
      var owner = usersPorId.get(b.owner_user_id);
      var listaSubs = subsPorLoja.get(b.id);
      var sub = listaSubs && listaSubs.length ? listaSubs[0] : undefined;
      var planoDb = sub && planosPorId.get(sub.plan_id);
      var profCount = _conta(profsPorLoja.get(b.id));
      var agCount = agsAtivosPorLoja.get(b.id) || 0;
      return {
        id: b.id, name: b.name, city: b.city, uf: b.uf,
        owner_name: owner ? owner.name : '?',
        owner_email: owner ? owner.email : '',
        plano: planoDb ? planoDb.name : 'nenhum',
        plan_name: planoDb ? planoDb.name : null,
        status: sub ? sub.status : 'nenhum',
        trial_ends_at: sub && sub.trial_ends_at ? sub.trial_ends_at : null,
        profissionais: profCount,
        agendamentos: agCount,
        created_at: b.created_at
      };
    });
    return lojas;
  }

  function saListarUsuarios() {
    /* Era o pior ponto do projeto: para CADA usuário, um filter em todos os
       agendamentos e em todas as sessões. Com 2.000 usuários e 100k
       agendamentos são 200 milhões de comparações — o painel inteiro
       travava. */
    var agsPorUsuario = new Map();
    (_db().appointments || []).forEach(function(a) {
      if (!a.user_id) return;
      agsPorUsuario.set(a.user_id, (agsPorUsuario.get(a.user_id) || 0) + 1);
    });
    var sessoesPorUsuario = _idx(_db().sessions, 'user_id');

    return (_db().users || []).map(function(u) {
      return {
        id: u.id, name: u.name, email: u.email, phone: u.phone,
        role: u.role,
        agendamentos: agsPorUsuario.get(u.id) || 0,
        sessoes: _conta(sessoesPorUsuario.get(u.id)),
        created_at: u.created_at
      };
    });
  }

  function saDetalheLoja(shopId) {
    var b = (_db().barbershops || []).find(function(x) { return x.id == shopId; });
    if (!b) err(404, 'Loja não encontrada.');
    var owner = (_db().users || []).find(function(u) { return u.id === b.owner_user_id; });
    var svcs = (_db().services || []).filter(function(s) { return s.barbershop_id === b.id; });
    var profs = (_db().professionals || []).filter(function(p) { return p.barbershop_id === b.id; });
    var ags = (_db().appointments || []).filter(function(a) { return a.barbershop_id === b.id; });
    var sub = (_db().subscriptions || []).find(function(s) { return s.barbershop_id === b.id; });
    var planoDb = sub && (_db().plans || []).find(function(p) { return p.id === sub.plan_id; });
    var totalPago = (_db().payments || []).filter(function(p) { return p.barbershop_id === b.id && p.status === 'paid'; })
      .reduce(function(sum, p) { return sum + (Number(p.amount_cents) || 0) / 100; }, 0);
    return {
      loja: b, owner: owner, planos: sub,
      plano: planoDb || null,
      servicos: svcs, profissionais: profs,
      totalAgendamentos: ags.length,
      agendamentosPorStatus: {
        confirmado: ags.filter(function(a) { return a.status === 'confirmado'; }).length,
        concluido: ags.filter(function(a) { return a.status === 'concluido'; }).length,
        cancelado: ags.filter(function(a) { return a.status === 'cancelado'; }).length
      },
      totalPago: totalPago
    };
  }

  function saAtualizarPlano(shopId, dados) {
    var sub = (_db().subscriptions || []).find(function(s) { return s.barbershop_id == shopId; });
    if (!sub) err(404, 'Assinatura não encontrada.');
    dados = dados || {};
    if (dados.plan_id != null && dados.plan_id !== '') {
      var plano = (_db().plans || []).find(function(p) { return p.id == dados.plan_id; });
      if (!plano) err(400, 'Plano não encontrado.');
      sub.plan_id = plano.id;
      if (plano.is_free) {
        sub.status = 'cancelada';
        sub.trial_ends_at = null;
        sub.current_period_end = null;
      }
    }
    if (dados.status) {
      var valido = ['trial', 'ativa', 'cancelada'];
      if (valido.indexOf(dados.status) === -1) err(400, 'Status inválido. Use trial, ativa ou cancelada.');
      sub.status = dados.status;
    }
    if (dados.current_period_end) sub.current_period_end = dados.current_period_end;
    sub.updated_at = agoraISO();
    DB.salvar();
    var planoDb = (_db().plans || []).find(function(p) { return p.id === sub.plan_id; });
    return {
      id: sub.id, barbershop_id: sub.barbershop_id, plan_id: sub.plan_id,
      plano: planoDb ? planoDb.name : null,
      status: sub.status,
      trial_ends_at: sub.trial_ends_at || null,
      current_period_end: sub.current_period_end || null
    };
  }

  /* ---------------- Super-admin: preços dos planos e modo grátis ---------------- */

  function _numPreco(v, campo) {
    if (v === undefined || v === null || v === '') return undefined;
    var n = Number(v);
    if (!isFinite(n) || n < 0) err(400, 'Valor inválido para ' + campo + '.');
    return n;
  }

  function saListarPlanos() {
    return (_db().plans || []).slice()
      .sort(function(a, b) { return Number(a.price_monthly || 0) - Number(b.price_monthly || 0); })
      .map(function(p) {
        return {
          id: p.id, name: p.name, is_free: !!p.is_free, active: !!p.active,
          price_monthly: Number(p.price_monthly || 0),
          price_annual: Number(p.price_annual || 0),
          price_per_employee: Number(p.price_per_employee || 0),
          price_compare: p.price_compare != null ? Number(p.price_compare) : null,
          max_professionals: (p.max_professionals == null) ? null : Number(p.max_professionals),
          max_dependents: (p.max_dependents == null) ? null : Number(p.max_dependents),
          features: (p.features || []),
          permissions: (p.permissions || []),
          nivel_relatorio: p.nivel_relatorio || null
        };
      });
  }

  function _planoCompleto(p) {
    return {
      id: p.id, name: p.name, is_free: !!p.is_free, active: !!p.active,
      price_monthly: Number(p.price_monthly || 0),
      price_annual: Number(p.price_annual || 0),
      price_per_employee: Number(p.price_per_employee || 0),
      price_compare: p.price_compare != null ? Number(p.price_compare) : null,
      max_professionals: (p.max_professionals == null) ? null : Number(p.max_professionals),
      max_dependents: (p.max_dependents == null) ? null : Number(p.max_dependents),
      features: (p.features || []),
      permissions: (p.permissions || []),
      nivel_relatorio: p.nivel_relatorio || null
    };
  }

  function saCriarPlano(dados) {
    dados = dados || {};
    if (!dados.name || !String(dados.name).trim()) err(400, 'Informe o nome do plano.');
    const db = _db();
    const nome = String(dados.name).trim();
    if (db.plans.some(x => String(x.name || '').toLowerCase() === nome.toLowerCase())) {
      err(409, 'Já existe um plano com este nome.');
    }
    const pm = _numPreco(dados.price_monthly, 'preço mensal');
    const novo = {
      id: DB.proximoId(),
      name: nome,
      price_monthly: pm === undefined ? 0 : pm,
      price_annual: _numPreco(dados.price_annual, 'preço anual'),
      price_per_employee: _numPreco(dados.price_per_employee, 'preço por funcionário'),
      price_compare: _numPreco(dados.price_compare, 'preço de comparação'),
      max_professionals: dados.max_professionals == null || dados.max_professionals === '' || dados.max_professionals === 'ilimitado'
        ? null : Number(dados.max_professionals),
      max_dependents: dados.max_dependents == null || dados.max_dependents === '' || dados.max_dependents === 'ilimitado'
        ? null : Number(dados.max_dependents),
      features: Array.isArray(dados.features) ? dados.features : [],
      permissions: Array.isArray(dados.permissions) ? dados.permissions : [],
      is_free: !!dados.is_free,
      active: dados.active == null ? true : !!dados.active,
      nivel_relatorio: dados.nivel_relatorio || null,
      created_at: agoraISO()
    };
    db.plans.push(novo);
    DB.salvar();
    return { ok: true, plano: _planoCompleto(novo) };
  }

  /* Atualiza dados de um PLANO (nome, preços, limites, features) —
     não confundir com saAtualizarPlano(shopId, dados) da assinatura. */
  function saEditarPlano(planoId, dados) {
    const p = (_db().plans || []).find(function(x) { return x.id == planoId; });
    if (!p) err(404, 'Plano não encontrado.');
    dados = dados || {};

    if (dados.name != null) {
      const nome = String(dados.name).trim();
      if (!nome) err(400, 'Informe o nome do plano.');
      if (_db().plans.some(x => x.id != p.id &&
          String(x.name || '').toLowerCase() === nome.toLowerCase())) {
        err(409, 'Já existe um plano com este nome.');
      }
      p.name = nome;
    }

    ['price_monthly', 'price_annual', 'price_per_employee', 'price_compare'].forEach(function(k) {
      const v = _numPreco(dados[k], k.replace('_', ' '));
      if (v !== undefined) p[k] = v;
    });

    if (dados.max_professionals !== undefined) {
      p.max_professionals = (dados.max_professionals === '' || dados.max_professionals == null)
        ? null : Number(dados.max_professionals);
    }
    if (dados.max_dependents !== undefined) {
      p.max_dependents = (dados.max_dependents === '' || dados.max_dependents == null)
        ? null : Number(dados.max_dependents);
    }
    if (Array.isArray(dados.features)) p.features = dados.features;
    if (Array.isArray(dados.permissions)) p.permissions = dados.permissions;
    if (dados.is_free !== undefined) p.is_free = !!dados.is_free;
    if (dados.active !== undefined) p.active = !!dados.active;
    if (dados.nivel_relatorio !== undefined) p.nivel_relatorio = dados.nivel_relatorio || null;

    DB.salvar();
    return { ok: true, plano: _planoCompleto(p) };
  }

  /* Remove o plano: só se nenhuma assinatura ou cobrança o referencia. */
  function saExcluirPlano(planoId) {
    const db = _db();
    const idx = db.plans.findIndex(function(x) { return x.id == planoId; });
    if (idx < 0) err(404, 'Plano não encontrado.');
    const p = db.plans[idx];
    const emUsoSub = (db.subscriptions || []).some(s => s.plan_id == p.id);
    const emUsoPag = (db.payments || []).some(pg => pg.plan_id == p.id);
    if (emUsoSub || emUsoPag) {
      err(409, 'Este plano está em uso por assinaturas ou cobranças. Não é possível excluí-lo.');
    }
    db.plans.splice(idx, 1);
    DB.salvar();
    return { ok: true, id: p.id };
  }

  function saAtualizarPrecosPlano(planoId, dados) {
    var p = (_db().plans || []).find(function(x) { return x.id == planoId; });
    if (!p) err(404, 'Plano não encontrado.');
    dados = dados || {};
    var pm = _numPreco(dados.price_monthly, 'preço mensal');
    var pa = _numPreco(dados.price_annual, 'preço anual');
    var pe = _numPreco(dados.price_per_employee, 'preço por funcionário');
    var pc = _numPreco(dados.price_compare, 'preço de comparação');
    if (pm !== undefined) p.price_monthly = pm;
    if (pa !== undefined) p.price_annual = pa;
    if (pe !== undefined) p.price_per_employee = pe;
    if (pc !== undefined) p.price_compare = pc;
    DB.salvar();
    return {
      ok: true, plano: {
        id: p.id, name: p.name,
        price_monthly: Number(p.price_monthly || 0),
        price_annual: Number(p.price_annual || 0),
        price_per_employee: Number(p.price_per_employee || 0),
        price_compare: p.price_compare != null ? Number(p.price_compare) : null
      }
    };
  }

  function saObterConfig() {
    return { site_gratis: modoGratuito(), trial_10dias: modoTrialAtivo() };
  }

  function saDefinirSiteGratis(ativo) {
    if (ativo && typeof ativo === 'object') ativo = ativo.ativo;
    return definirModoGratuito(!!ativo);
  }

  function saDefinirTrial(ativo) {
    if (ativo && typeof ativo === 'object') ativo = ativo.ativo;
    return definirModoTrial(!!ativo);
  }

  function saExcluirLoja(shopId) {
    var b = (_db().barbershops || []).find(function(x) { return x.id == shopId; });
    if (!b) err(404, 'Loja não encontrada.');
    _db().services = (_db().services || []).filter(function(s) { return s.barbershop_id !== b.id; });
    _db().professionals = (_db().professionals || []).filter(function(p) { return p.barbershop_id !== b.id; });
    _db().clients = (_db().clients || []).filter(function(c) { return c.barbershop_id !== b.id; });
    _db().appointments = (_db().appointments || []).filter(function(a) { return a.barbershop_id !== b.id; });
    _db().notifications = (_db().notifications || []).filter(function(n) { return n.barbershop_id !== b.id; });
    _db().subscriptions = (_db().subscriptions || []).filter(function(s) { return s.barbershop_id !== b.id; });
    _db().payments = (_db().payments || []).filter(function(p) { return p.barbershop_id !== b.id; });
    _db().reviews = (_db().reviews || []).filter(function(r) { return r.barbershop_id !== b.id; });
    _db().gallery_images = (_db().gallery_images || []).filter(function(g) { return g.barbershop_id !== b.id; });
    _db().working_hours = (_db().working_hours || []).filter(function(w) { return w.barbershop_id !== b.id; });
    _db().schedule_exceptions = (_db().schedule_exceptions || []).filter(function(e) { return e.barbershop_id !== b.id; });
    _db().appointment_services = (_db().appointment_services || []).filter(function(a) {
      var ag = (_db().appointments || []).find(function(x) { return x.id === a.appointment_id; });
      return !ag || ag.barbershop_id !== b.id;
    });
    _db().tickets = (_db().tickets || []).filter(function(t) { return t.salaoId !== b.id; });
    _db().barbershops = _db().barbershops.filter(function(x) { return x.id !== b.id; });
    DB.salvar();
    return { ok: true };
  }

  function saDashboard() {
    return {
      totalLojas: (_db().barbershops || []).length,
      totalUsuarios: (_db().users || []).length,
      totalAgendamentos: (_db().appointments || []).length,
      totalReceita: (_db().payments || []).filter(function(p) { return p.status === 'paid'; })
        .reduce(function(s, p) { return s + (Number(p.amount_cents) || 0) / 100; }, 0),
      lojasTrial: (_db().subscriptions || []).filter(function(s) { return s.status === 'trial'; }).length,
      lojasAtivas: (_db().subscriptions || []).filter(function(s) { return s.status === 'ativa'; }).length,
      agendamentosHoje: (_db().appointments || []).filter(function(a) { return a.date === agoraISO().slice(0, 10); }).length
    };
  }

  /**
   * Relatórios globais da plataforma (página "Relatórios" do admin).
   * Retorna assinaturas por plano, séries mensais de uso, clientes e
   * logins de TODO o site, além dos totais atuais. Fonte: PostgreSQL
   * (coleções do pg_map via _db()).
   */
  function saRelatorios() {
    const db = _db();

    const meses = [];
    const agora = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      meses.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
    }
    const setMeses = new Set(meses);

    function serieMensal(lista, extrair) {
      const map = {};
      (lista || []).forEach(r => {
        const k = String(extrair(r) || '').slice(0, 7);
        if (setMeses.has(k)) map[k] = (map[k] || 0) + 1;
      });
      return meses.map(m => ({ mes: m, valor: map[m] || 0 }));
    }

    const assinaturas = db.subscriptions || [];

    const planos = (db.plans || []).map(p => {
      const subs = assinaturas.filter(s => s.plan_id === p.id);
      return {
        plan_id: p.id,
        name: p.name,
        price_monthly: p.price_monthly,
        total: subs.length,
        ativas: subs.filter(s => s.status === 'ativa').length,
        trial: subs.filter(s => s.status === 'trial').length,
        canceladas: subs.filter(s => s.status === 'cancelada').length
      };
    }).sort((a, b) => b.total - a.total);

    const lojas = db.barbershops || [];
    const lojasComPlano = new Set(assinaturas.map(s => s.barbershop_id));
    const logins = (db.audit_log || []).filter(l => String(l.acao || '').indexOf('login') === 0);

    function dentroDe(ts, dias) {
      if (!ts) return false;
      const d = new Date(ts).getTime();
      return Number.isFinite(d) && d >= Date.now() - dias * 86400000;
    }

    const pagos = (db.payments || []).filter(p => p.status === 'paid');
    const receitaLoja = {};
    pagos.forEach(p => {
      receitaLoja[p.barbershop_id] = (receitaLoja[p.barbershop_id] || 0) + (Number(p.amount_cents) || 0) / 100;
    });

    const usuariosMap = (db.users || []).reduce(function(m, u) { m[u.id] = u; return m; }, {});

    const top10 = lojas.map(b => {
      const sub = assinaturas.find(s => s.barbershop_id === b.id);
      const planoDb = sub && (db.plans || []).find(p => p.id === sub.plan_id);
      return {
        id: b.id,
        nome: b.name,
        cidade: b.city,
        plano: planoDb ? planoDb.name : 'nenhum',
        status: sub ? sub.status : 'nenhum',
        receita: Math.round((receitaLoja[b.id] || 0) * 100) / 100,
        agendamentos: (db.appointments || []).filter(a => a.barbershop_id === b.id && a.status !== 'cancelado').length
      };
    }).sort((a, b) => b.receita - a.receita).slice(0, 10);

    const atividade = logins
      .map(l => {
        const u = usuariosMap[l.user_id] || {};
        return {
          timestamp: l.timestamp,
          nome: u.name || null,
          email: u.email || null,
          papel: u.role || null
        };
      })
      .sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')))
      .slice(0, 20);

    return {
      generated_at: agoraISO(),
      meses,
      planos,
      sem_plano: lojas.filter(b => b && b.id != null && !lojasComPlano.has(b.id)).length,
      assinaturas: {
        total: assinaturas.length,
        ativas: assinaturas.filter(s => s.status === 'ativa').length,
        trial: assinaturas.filter(s => s.status === 'trial').length,
        canceladas: assinaturas.filter(s => s.status === 'cancelada').length,
        receita_mensal_projetada: Math.round(planos.reduce((s, p) => s + Number(p.price_monthly || 0) * p.ativas, 0) * 100) / 100
      },
      series: {
        uso_por_mes: serieMensal(db.appointments || [], a => a.starts_at || a.date),
        clientes_por_mes: serieMensal(db.clients || [], c => c.created_at),
        logins_por_mes: serieMensal(logins, l => l.timestamp)
      },
      totais: {
        total_lojas: lojas.length,
        total_usuarios: (db.users || []).length,
        total_agendamentos: (db.appointments || []).length,
        agendamentos_hoje: (db.appointments || []).filter(a => (a.starts_at || a.date || '').slice(0, 10) === agoraISO().slice(0, 10)).length,
        logins_30d: logins.filter(l => (l.timestamp || '') >= new Date(Date.now() - 30 * 86400000).toISOString()).length
      },
      por_periodo: {
        novas_lojas: { d30: lojas.filter(b => dentroDe(b.created_at, 30)).length, d90: lojas.filter(b => dentroDe(b.created_at, 90)).length, d365: lojas.filter(b => dentroDe(b.created_at, 365)).length },
        novos_usuarios: { d30: (db.users || []).filter(u => dentroDe(u.created_at, 30)).length, d90: (db.users || []).filter(u => dentroDe(u.created_at, 90)).length, d365: (db.users || []).filter(u => dentroDe(u.created_at, 365)).length },
        agendamentos: { d30: (db.appointments || []).filter(a => dentroDe(a.starts_at || a.date, 30)).length, d90: (db.appointments || []).filter(a => dentroDe(a.starts_at || a.date, 90)).length, d365: (db.appointments || []).filter(a => dentroDe(a.starts_at || a.date, 365)).length },
        receita: { d30: pagos.filter(p => dentroDe(p.paid_at, 30)).reduce((s, p) => s + (Number(p.amount_cents) || 0) / 100, 0), d90: pagos.filter(p => dentroDe(p.paid_at, 90)).reduce((s, p) => s + (Number(p.amount_cents) || 0) / 100, 0), d365: pagos.filter(p => dentroDe(p.paid_at, 365)).reduce((s, p) => s + (Number(p.amount_cents) || 0) / 100, 0) }
      },
      top10_lojas: top10,
      atividade_recente: atividade,
      total_receita: Math.round((receitaLoja && Object.values(receitaLoja).reduce((a, b) => a + (Number(b) || 0), 0)) * 100) / 100
    };
  }

  /* Lista todos os tickets (visão super admin). */
  function saTickets(filtros) {
    var db = _db();
    var lista = db.tickets || [];
    if (filtros && filtros.status && filtros.status !== 'todos') {
      lista = lista.filter(function(t) { return t.status === filtros.status; });
    }
    return lista.map(function(t) {
      var loja = (db.barbershops || []).find(function(b) { return b.id === t.salao_id; });
      return {
        id: t.id,
        assunto: t.subject,
        mensagem: t.message,
        status: t.status || 'aberto',
        resposta: t.resposta != null ? t.resposta : null,
        criadoEm: t.created_at,
        lojaId: t.salao_id,
        lojaNome: loja ? loja.name : ('Loja #' + t.salao_id),
        lojaCidade: loja ? (loja.city || '') : ''
      };
    }).sort(function(a, b) { return String(b.criadoEm || '').localeCompare(String(a.criadoEm || '')); });
  }

  /* Atualiza status/resposta de um ticket (visão super admin). */
  function saResponderTicket(ticketId, dados) {
    var db = _db();
    var t = (db.tickets || []).find(function(x) { return x.id == ticketId; });
    if (!t) err(404, 'Ticket não encontrado.');
    var novaStatus = dados && dados.status;
    if (novaStatus && ['aberto', 'em_andamento', 'respondido', 'resolvido', 'fechado'].indexOf(novaStatus) === -1) {
      err(400, 'Status inválido.');
    }
    if (novaStatus) t.status = novaStatus;
    if (dados && dados.resposta != null && String(dados.resposta).trim()) {
      t.resposta = String(dados.resposta).trim();
    }
    t.updated_at = agoraISO();
    DB.salvar();
    return {
      id: t.id,
      assunto: t.subject,
      mensagem: t.message,
      status: t.status,
      resposta: t.resposta != null ? t.resposta : null,
      criadoEm: t.created_at,
      lojaId: t.salao_id
    };
  }

  /* ================= SERVIÇOS (RF-018..021) ================= */

  function validarServico(dados, parcial) {
    if (!parcial || dados.name !== undefined) {
      const nome = String(dados.name ?? '').trim();
      if (nome.length < 2 || nome.length > 100) err(400, 'Nome do serviço deve ter entre 2 e 100 caracteres.');
    }
    if (!parcial || dados.duration_min !== undefined) {
      const dur = Number(dados.duration_min);
      if (!Number.isFinite(dur) || dur < 5 || dur > 480) err(400, 'Duração deve estar entre 5 e 480 minutos.');
    }
    if (!parcial || dados.price !== undefined) {
      const p = Number(dados.price);
      if (!Number.isFinite(p) || p < 0) err(400, 'Preço deve ser um valor maior ou igual a zero.');
    }
  }

  function servicosDaLoja(shopId, apenasAtivos) {
    return DB._d().services
      .filter(s => s.barbershop_id == shopId && (!apenasAtivos || s.active))
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  }

  function criarServico(dados) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'servicos', 'Gerenciar serviços');
    validarServico(dados, false);
    const svc = {
      id: DB.proximoId(),
      barbershop_id: shop.id,
      name: String(dados.name).trim(),
      category: String(dados.category || '').trim(),
      description: String(dados.description || '').trim(),
      duration_min: Number(dados.duration_min),
      price: Number(dados.price),
      active: dados.active === undefined ? 1 : (dados.active ? 1 : 0),
      sort_order: Number(dados.sort_order) ||
        (servicosDaLoja(shop.id, false).reduce((m, s) => Math.max(m, s.sort_order), 0) + 1),
      created_at: agoraISO()
    };
    DB._d().services.push(svc);
    DB.salvar();
    return svc;
  }

  function atualizarServico(id, patch) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'servicos', 'Editar serviços');
    const svc = DB._d().services.find(s => s.id == id && s.barbershop_id === shop.id);
    if (!svc) err(404, 'Serviço não encontrado.');
    validarServico(patch, true);
    ['name', 'category', 'description', 'duration_min', 'price'].forEach(c => {
      if (patch[c] !== undefined) svc[c] = c === 'name' ? String(patch[c]).trim() : patch[c];
    });
    if (patch.active !== undefined) svc.active = patch.active ? 1 : 0;
    if (patch.sort_order !== undefined) svc.sort_order = Number(patch.sort_order);
    DB.salvar();
    return svc;
  }

  function excluirServico(id) {
    const { shop } = exigirDono();
    const db = DB._d();
    const svc = db.services.find(s => s.id == id && s.barbershop_id === shop.id);
    if (!svc) err(404, 'Serviço não encontrado.');
    // DELETE físico (RF-020); snapshots em appointment_services são preservados
    db.professional_services = db.professional_services.filter(ps => ps.service_id != id);
    db.services = db.services.filter(s => s.id != id);
    DB.salvar();
    return { ok: true };
  }

  /* ================= PROFISSIONAIS (RF-022..026, DT-09/DT-12) ================= */

  function precoEfetivo(profissionalId, servico) {
    const link = DB._d().professional_services.find(ps =>
      ps.professional_id == profissionalId && ps.service_id === servico.id);
    return { ...servico, effective_price: (link && link.price_override != null) ? link.price_override : servico.price };
  }

  function profissionaisDaLoja(shopId, apenasAtivos) {
    const db = DB._d();
    return db.professionals
      .filter(p => p.barbershop_id == shopId && (!apenasAtivos || p.is_active))
      .map(p => ({
        id: p.id, name: p.name, phone: p.phone || '', color: p.color,
        bio: p.bio || '', is_active: p.is_active, created_at: p.created_at,
        services: db.professional_services
          .filter(ps => ps.professional_id === p.id)
          .map(ps => {
            const svc = db.services.find(s => s.id === ps.service_id);
            return svc
              ? { id: svc.id, name: svc.name, duration_min: svc.duration_min, price: svc.price, active: svc.active, effective_price: ps.price_override ?? svc.price }
              : null;
          }).filter(Boolean)
      }));
  }

  /* HH:MM → minutos; null/vazio/inválido = null */
  function _hhmmParaMin(v) {
    if (v === null || v === undefined || v === '') return null;
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(v).trim());
    return m ? (Number(m[1]) * 60 + Number(m[2])) : NaN;
  }

  /* Ponto único de validação de expediente: create e update chegam aqui.
     Sem isto, "09:00–08:00" era gravado e a agenda do profissional ficava
     impossível (janela negativa). Almoço precisa caber dentro do expediente
     e ser um intervalo real. */
  function _validarExpediente(inicio, fim, lunchStart, lunchEnd) {
    const i = _hhmmParaMin(inicio);
    const f = _hhmmParaMin(fim);
    if (Number.isNaN(i)) err(400, 'Horário de início inválido: use o formato HH:MM.');
    if (Number.isNaN(f)) err(400, 'Horário de término inválido: use o formato HH:MM.');
    if (f <= i) err(400, 'O término deve ser depois do início do expediente.');

    const li = _hhmmParaMin(lunchStart);
    const lf = _hhmmParaMin(lunchEnd);
    /* almoço é tudo-ou-nada: informar só um dos lados é erro de
       preenchimento, não "intervalo invertido" */
    const temIni = lunchStart !== null && lunchStart !== undefined && lunchStart !== '';
    const temFim = lunchEnd !== null && lunchEnd !== undefined && lunchEnd !== '';
    if (!temIni && !temFim) return;
    if (!temIni) err(400, 'Informe o início do almoço ou apague os dois campos.');
    if (!temFim) err(400, 'Informe o término do almoço ou apague os dois campos.');
    if (Number.isNaN(li)) err(400, 'Início do almoço inválido: use o formato HH:MM.');
    if (Number.isNaN(lf)) err(400, 'Término do almoço inválido: use o formato HH:MM.');
    if (lf <= li) err(400, 'O término do almoço deve ser depois do início.');
    if (li < i || lf > f) err(400, 'O almoço precisa ficar dentro do expediente.');
  }

  function gravarHorariosProfissional(shopId, profId, inicio, fim, lunchStart, lunchEnd) {
    _validarExpediente(inicio, fim, lunchStart, lunchEnd);
    const db = DB._d();
    const diasLoja = db.working_hours.filter(w => w.barbershop_id == shopId && w.professional_id == null);
    // regrava dom–sáb [0..6] preservando os horários da loja (DT-09);
    // linha nova só é criada em dias em que a loja abre
    for (let dow = 0; dow <= 6; dow++) {
      const linhaLoja = diasLoja.find(w => w.day_of_week === dow);
      const aberto = linhaLoja ? linhaLoja.is_open : (dow === 0 ? 0 : 1);
      const existente = db.working_hours.find(w =>
        w.barbershop_id == shopId && w.professional_id == profId && w.day_of_week === dow);
      if (!existente) {
        if (!aberto) continue;
        db.working_hours.push({
id: DB.proximoId(), barbershop_id: shopId, professional_id: profId,
      day_of_week: dow,
          start_time: inicio, end_time: fim,
          lunch_start: lunchStart || null, lunch_end: lunchEnd || null,
          is_open: aberto
        });
      } else {
        existente.start_time = inicio; existente.end_time = fim;
        existente.lunch_start = lunchStart || null;
        existente.lunch_end = lunchEnd || null;
        existente.is_open = aberto;
      }
    }
  }

  /* Localiza conta de usuário existente por telefone OU e-mail (RBAC) */
  function usuarioContaAcesso(db, { email, tel }) {
    if (tel) {
      const porFone = db.users.find(u => u.phone === tel);
      if (porFone) return porFone;
    }
    if (email) {
      return db.users.find(u => String(u.email || '').toLowerCase() === email.toLowerCase()) || null;
    }
    return null;
  }

  /* RF-026 / DT-12 — cota de profissionais ATIVOS por plano.
     `ignorarProfId` permite revalidar na reativação sem contar o próprio
     profissional que está voltando. Usa planoEfetivo (não a assinatura
     crua) para que loja expirada caia na cota do plano Free, e nunca
     fique com limite ilimitado por herança de um plano pago vencido. */
  function exigirCotaProfissionais(shopId, ignorarProfId) {
    const db = DB._d();
    const { plano } = planoEfetivo(shopId);
    if (!plano || plano.max_professionals == null) return;
    const limite = Number(plano.max_professionals);
    if (!Number.isFinite(limite)) return;
    const atuais = db.professionals.filter(p =>
      p.barbershop_id === shopId && p.is_active && p.id !== ignorarProfId).length;
    if (atuais >= limite) {
      err(409, 'Limite do plano "' + plano.name + '" atingido (' + limite +
        ' profissional(is) ativo(s)). Desative um profissional ou faça upgrade para adicionar mais.');
    }
  }

  function criarProfissional(dados) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'profissionais', 'Criar profissionais');
    const db = DB._d();

    const nome = String(dados.name || '').trim();
    if (nome.length < 2) err(400, 'Informe o nome do profissional.');

    const email = String(dados.email || '').trim();
    if (email && !email.includes('@')) err(400, 'E-mail inválido.');
    const tel = String(dados.phone || '').replace(/\D/g, '');

    /* RF-026 / DT-12: plano limita nº de profissionais */
    exigirCotaProfissionais(shop.id, null);

    /* RBAC: com e-mail ou telefone informado, o dono convida um barbeiro
       ajudante — cria (ou reaproveita) a conta de acesso usada no login */
    let contaAcesso = null;
    if (email || tel) {
      contaAcesso = usuarioContaAcesso(db, { email, tel });
      if (contaAcesso && contaAcesso.role === 'dono') {
        err(409, 'Este telefone/e-mail já pertence à conta de um dono de salão.');
      }
      /* [SEGURANÇA] Reaproveitar uma conta de cliente trocava o papel e
         sobrescrevia o nome da pessoa — ela perdia o acesso de cliente sem
         aviso. O cadastro do profissional não deve assumir identidades
         existentes. */
      if (contaAcesso && contaAcesso.role === 'cliente') {
        err(409, 'Este e-mail já é uma conta de cliente. Crie o profissional sem e-mail/telefone e vincule a conta depois.');
      }
      if (contaAcesso &&
          db.professionals.some(p => p.barbershop_id === shop.id && p.user_id === contaAcesso.id)) {
        err(409, 'Já existe um profissional vinculado a este telefone/e-mail nesta loja.');
      }
      if (!contaAcesso) {
        contaAcesso = {
          id: DB.proximoId(),
          role: 'barbeiro',
          name: nome,
          email,
          phone: tel,
          verified: 1,
          created_at: DB.hojeISO() + 'T' + DB.minToHHMM(DB.agoraMinutos()),
          prefs: { notif_email: 'sim', notif_sms: 'não', lembrete: '30' }
        };
        db.users.push(contaAcesso);
      } else {
        /* conta de barbeiro/dependente reaproveitada: nunca de cliente
           (bloqueado acima). O nome pertence à PESSOA, não ao cadastro
           profissional — sobrescrever aqui renomeava a conta de acesso sem
           ela ter pedido. Só preenche o que ainda estiver vazio. */
        if (!contaAcesso.name) contaAcesso.name = nome;
        if (email && !contaAcesso.email) contaAcesso.email = email;
        if (tel && !contaAcesso.phone) contaAcesso.phone = tel;
      }
    }

    const prof = {
      id: DB.proximoId(),
      barbershop_id: shop.id,
      name: nome,
      phone: String(dados.phone || ''),
      color: dados.color || '#3b82f6',
      bio: String(dados.bio || '').trim(),
      is_active: 1,
      user_id: contaAcesso ? contaAcesso.id : null,
      created_at: agoraISO()
    };
    db.professionals.push(prof);

    /* almoço configurável (DT-09): chaves presentes no payload são
       respeitadas — enviar null/null grava SEM almoço; quando ausentes
       (chamada programática), vale o padrão 12:00–13:00 */
    gravarHorariosProfissional(
      shop.id, prof.id,
      dados.start_time || '09:00',
      dados.end_time || '19:00',
      dados.lunch_start !== undefined ? dados.lunch_start : '12:00',
      dados.lunch_end !== undefined ? dados.lunch_end : '13:00'
    );

    /* vínculos com serviços */
    if (Array.isArray(dados.service_ids)) substituirVinculos(prof.id, dados.service_ids);

    DB.salvar();
    return prof;
  }

  function substituirVinculos(profId, serviceIds) {
    const db = DB._d();
    db.professional_services = db.professional_services.filter(ps => ps.professional_id !== profId);
    serviceIds.forEach(sid => {
      if (!db.services.some(s => s.id == sid)) return;
      db.professional_services.push({ professional_id: profId, service_id: sid, price_override: null });
    });
  }

  /* ============================================================
     Dependente / Funcionário (3º papel)
     ============================================================ */

  /* Garante que a loja sempre tenha um Código Único (backfill para
     lojas antigas que nunca tiveram um gerado). */
  function codigoUnicoDaLoja(shop) {
    if (!shop.codigo_unico) {
      shop.codigo_unico = Auth.gerarCodigoUnico();
      DB.salvar();
    }
    return shop.codigo_unico;
  }

  function dependentesDaLoja(shopId) {
    return DB._d().users.filter(u => u.role === 'dependente' && u.barbershop_id === shopId);
  }

  /* Plano efetivo + cota de dependentes da loja.
     O plano usado é o mesmo de planoEfetivo (Free quando não há
     assinatura válida,.site_gratis quando ligado). Antes lia a
     assinatura crua: uma loja expirada/cancelada continuava usando a
     cota do plano pago — e, se o plano for ilimitado (max_dependents
     NULL), isso virava "dependentes infinitos para sempre". */
  function cotaDependentes(shopId) {
    const db = DB._d();
    const { plano } = planoEfetivo(shopId);
    const ativos = dependentesDaLoja(shopId);
    let limite;
    if (!plano) {
      limite = 0;
    } else if (plano.max_dependents == null) {
      limite = Infinity; // ilimitado (Salao Pro)
    } else {
      limite = Number(plano.max_dependents) || 0;
    }
    return { plano, ativos, limite, nomePlano: plano ? plano.name : 'sem plano' };
  }

  /* Dados dos dependentes da loja. `incluirCodigo` controla se o Código
     Único (convite de novos funcionários) é exposto: só o dono o vê. */
  function dadosDependentesDaEquipe(shop, incluirCodigo) {
    const { plano, ativos, limite, nomePlano } = cotaDependentes(shop.id);
    return {
      codigo_unico: incluirCodigo ? codigoUnicoDaLoja(shop) : null,
      empresa: shop.name,
      plano: nomePlano,
      max_dependents: limite === Infinity ? null : limite,
      dependentes_ativos: ativos.length,
      dependentes: ativos.map(u => ({
        id: u.id,
        name: u.name,
        email: String(u.email || ''),
        created_at: u.created_at || null
      }))
    };
  }

  /* Cota do plano no painel do dono (ex.: "1 de 5 usados") */
  function meuCodigoEmpresa() {
    const { shop } = exigirDono();
    return dadosDependentesDaEquipe(shop, true);
  }

  /* Barbeiro e dono: listam os dependentes da loja. O Código Único
     (chave de convite do dono) só é exposto ao dono. */
  function listarDependentes() {
    const { user, shop } = exigirDonoOuBarbeiro();
    return dadosDependentesDaEquipe(shop, user.role === 'dono');
  }

  /* RF: o dono cria as credenciais (Login/Senha) do funcionário.
     A cota é definida pelo plano: Básico/Autonomo = 1; Salao = 5;
     Salao Pro = ilimitado. */
  function criarDependente(dados) {
    const { shop, user } = exigirDono();
    const db = DB._d();

    const nome = String((dados && dados.name) || '').trim();
    if (nome.length < 2) err(400, 'Informe o nome do funcionário.');

    const login = String((dados && (dados.login || dados.email)) || '').trim().toLowerCase();
    if (!login || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) {
      err(400, 'Informe um e-mail válido para ser o login do funcionário.');
    }

    const senha = validarForcaSenha((dados && dados.senha) || '');

    /* identidade não pode pertencer a outro papel importante */
    const existente = db.users.find(u => String(u.email || '').toLowerCase() === login);
    if (existente) {
      if (existente.role === 'dono' || existente.role === 'barbeiro') {
        err(409, 'Este e-mail já pertence a outra conta (dono/barbeiro).');
      }
      if (existente.role === 'dependente') {
        err(409, 'Já existe um funcionário com este login nesta conta.');
      }
      /* [SEGURANÇA] Converter a conta de um cliente existente permitia que
         qualquer dono assumisse a conta de um cliente apenas informando o
         e-mail dele: trocava o papel, o nome e a senha. O vínculo correto é
         o próprio cliente usando o Código Único (vincularDependente). */
      if (existente.role === 'cliente') {
        err(409, 'Este e-mail já é uma conta de cliente. Peça para a pessoa entrar com a própria conta e vincular o Código Único da empresa.');
      }
    }

    /* cota do plano — erro exato exigido pelo RF */
    const { plano, ativos, limite, nomePlano } = cotaDependentes(shop.id);
    if (limite === 0) {
      err(402, 'Sua assinatura está inativa. Assine um plano para cadastrar funcionários.');
    }
    if (ativos.length >= limite) {
      err(409, 'Já está no número de dependentes desta conta');
    }

    const agora = DB.hojeISO() + 'T' + DB.minToHHMM(DB.agoraMinutos());
    /* todo e-mail já existente foi rejeitado acima (dono/barbeiro/
       dependente/cliente) — a conta é sempre nova a partir daqui */
    const conta = {
      id: DB.proximoId(),
      role: 'dependente',
      name: nome,
      email: login,
      phone: normalizarTelefone((dados && dados.phone) || ''),
      verified: 1,
      password_hash: Auth.hashSenha(senha),
      barbershop_id: shop.id,
      created_at: agora,
      prefs: { notif_email: 'sim', notif_sms: 'não', lembrete: '30' }
    };
    db.users.push(conta);

    _auditLog(user.id, 'criar_dependente', { dependente_id: conta.id });
    DB.salvar();
    return {
      id: conta.id, name: conta.name, email: conta.email,
      barbershop_id: conta.barbershop_id, created_at: conta.created_at,
      plano: nomePlano, usados: ativos.length + 1,
      limite: limite === Infinity ? null : limite
    };
  }

  /* Espelha no estado em memória as ações ON DELETE das FKs para users
     (SET NULL / CASCADE). Sem isso, linhas antigas com user_id apagado
     fariam o syncAll falhar na FK (ex.: audit_log_user_id_fkey). */
  function _limparReferenciasUsuario(db, userId) {
    (db.audit_log || []).forEach(l => { if (l.user_id === userId) l.user_id = null; });
    (db.appointments || []).forEach(a => { if (a.user_id === userId) a.user_id = null; });
    (db.clients || []).forEach(c => { if (c.user_id === userId) c.user_id = null; });
    (db.reviews || []).forEach(r => { if (r.user_id === userId) r.user_id = null; });
    (db.professionals || []).forEach(p => { if (p.user_id === userId) p.user_id = null; });
    (db.tickets || []).forEach(t => { if (t.user_id === userId) t.user_id = null; });
    (db.reports || []).forEach(r => {
      if (r.reporter_user_id === userId) r.reporter_user_id = null;
      if (r.target_user_id === userId) r.target_user_id = null;
    });
    db.sessions = (db.sessions || []).filter(s => s.user_id !== userId);
    db.notifications = (db.notifications || []).filter(n => n.user_id !== userId);
    db.magic_tokens = (db.magic_tokens || []).filter(t => t.user_id !== userId);
    db.favorites = (db.favorites || []).filter(f => f.user_id !== userId);
  }

  function excluirDependente(id) {
    const { shop, user } = exigirDono();
    const db = DB._d();
    const alvo = db.users.find(u => u.id == id && u.role === 'dependente' && u.barbershop_id === shop.id);
    if (!alvo) err(404, 'Funcionário não encontrado nesta empresa.');
    _limparReferenciasUsuario(db, alvo.id);
    db.users = db.users.filter(u => u.id !== alvo.id);
    _auditLog(user.id, 'excluir_dependente', { dependente_id: alvo.id });
    DB.salvar();
    return { ok: true, id: alvo.id };
  }

  /* O usuário pode desconectar sua conta da empresa (soft disconnect):
      limpa o barbershop_id, mantém a conta existindo e pode logar outra vez.
      Este é o "desconectar": o usuário sai, pode logar como outro usuário. */
  function desvincularMinhaConta() {
    const user = sessao();
    const db = DB._d();
    const conta = db.users.find(u => u.id === user.id);
    if (!conta) err(404, 'Usuário não encontrado.');
    const shopId = conta.barbershop_id;
    conta.barbershop_id = null;
    if (conta.role !== 'cliente') conta.role = 'cliente';
    _auditLog(user.id, 'desvincular_minha_conta', { barbershop_id: shopId, via: user.role });
    DB.salvar();
    Auth.logout();
    return { ok: true, message: 'Conexão com a empresa removida. Você pode logar como outro usuário.' };
  }

  /* login público do funcionário — o Código Único é opcional:
     · conta criada pelo dono (já vinculada) → senha + código;
     · conta criada por autoatendimento (sem vínculo) → login+senha
       entram sem código e o app leva o usuário a vincular com o código. */
  const _loginDepFalhas = new Map();
  const LOGIN_DEP_MAX = 5;
  const LOGIN_DEP_BLOQUEIO_MS = 15 * 60 * 1000;

  function loginDependente(dados) {
    const db = DB._d();
    const login = String((dados && (dados.login || dados.email)) || '').trim().toLowerCase();
    const senha = String((dados && dados.senha) || '');
    const codigo = String((dados && dados.codigo_unico) || '').trim().toUpperCase();

    if (!login || !senha) {
      err(400, 'Informe login e senha.');
    }

    const chave = codigo ? (codigo + '|' + login) : ('sem-codigo|' + login);
    const falha = _loginDepFalhas.get(chave);
    if (falha && Date.now() < falha.bloqueioAte) {
      const min = Math.ceil((falha.bloqueioAte - Date.now()) / 60000);
      err(429, 'Muitas tentativas. Aguarde ' + min + ' min para tentar novamente.');
    }

    /* anti-enumeração: mensagens idênticas para qualquer combinação errada */
    const negar = () => {
      const rec = _loginDepFalhas.get(chave) || { conta: 0, bloqueioAte: 0 };
      rec.conta++;
      if (rec.conta >= LOGIN_DEP_MAX) rec.bloqueioAte = Date.now() + LOGIN_DEP_BLOQUEIO_MS;
      _loginDepFalhas.set(chave, rec);
      err(401, 'Login, senha ou código único incorretos.');
    };
    const negarSemCodigo = () => {
      const rec = _loginDepFalhas.get('sem-codigo|' + login) || { conta: 0, bloqueioAte: 0 };
      rec.conta++;
      if (rec.conta >= LOGIN_DEP_MAX) rec.bloqueioAte = Date.now() + LOGIN_DEP_BLOQUEIO_MS;
      _loginDepFalhas.set('sem-codigo|' + login, rec);
      err(401, 'Login ou senha incorretos.');
    };

    const usuario = db.users.find(u =>
      u.role === 'dependente' &&
      String(u.email || '').toLowerCase() === login) || null;

    if (!usuario || !Auth.verificarSenha(senha, usuario.password_hash)) {
      return codigo ? negar() : negarSemCodigo();
    }

    if (codigo) {
      const loja = db.barbershops.find(b =>
        b.codigo_unico && b.codigo_unico.toUpperCase() === codigo);
      if (!loja) return negar();
      /* já vinculado a outra empresa: código errado para esta conta */
      if (usuario.barbershop_id && usuario.barbershop_id !== loja.id) return negar();

      if (usuario.barbershop_id == null) {
        const { limite, ativos } = cotaDependentes(loja.id);
        if (limite === 0) {
          err(402, 'Sua assinatura está inativa. Assine um plano para vincular funcionários.');
        }
        if (ativos.length >= limite) {
          err(409, 'Já está no número de dependentes desta conta');
        }
        usuario.barbershop_id = loja.id;
        _auditLog(usuario.id, 'vincular_dependente', { barbershop_id: loja.id, via: 'codigo_login' });
      }

      _loginDepFalhas.delete(chave);
      Auth.criarSessao(usuario.id);
      _auditLog(usuario.id, 'login_sucesso');
      return {
        token: localStorage.getItem('token'),
        user: Auth.publicUser(usuario),
        barbershop: Auth.salaoDoUsuario(usuario),
        link_pendente: false
      };
    }

    /* sem código: só permite entrar em contas ainda não vinculadas —
       o app então leva o usuário a vincular com o Código Único */
    if (usuario.barbershop_id) {
      err(400, 'Informe o Código Único da empresa para entrar como funcionário.');
    }

    _loginDepFalhas.delete(chave);
    Auth.criarSessao(usuario.id);
    _auditLog(usuario.id, 'login_sucesso');
    return {
      token: localStorage.getItem('token'),
      user: Auth.publicUser(usuario),
      barbershop: null,
      link_pendente: true
    };
  }

  /* Autoatendimento do funcionário/dependente: cria a conta normalmente
     (nome, e-mail, senha) SEM exigir o Código Único. O vínculo com a
     empresa acontece depois (login sem código ou vincularDependente). */
  function criarContaDependente(dados) {
    const db = DB._d();

    const nome = String((dados && dados.name) || '').trim();
    if (nome.length < 2) err(400, 'Informe seu nome completo.');

    const login = String((dados && (dados.login || dados.email)) || '').trim().toLowerCase();
    if (!login || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(login)) {
      err(400, 'Informe um e-mail válido.');
    }

    const senha = validarForcaSenha((dados && dados.senha) || '');

    if (!dados || !(dados.aceite_privacidade || dados.aceiteTermos)) {
      err(400, 'O aceite da Política de Privacidade e Termos de Uso é obrigatório.');
    }

    const existente = db.users.find(u => String(u.email || '').toLowerCase() === login);
    if (existente) {
      if (existente.role === 'dono' || existente.role === 'barbeiro') {
        err(409, 'Este e-mail já pertence a outra conta (dono/barbeiro).');
      }
      if (existente.role === 'dependente') {
        err(409, 'Já existe uma conta de funcionário com este e-mail.');
      }
      err(409, 'Este e-mail já está cadastrado. Entre com a sua conta e vincule o Código Único.');
    }

    const agora = DB.hojeISO() + 'T' + DB.minToHHMM(DB.agoraMinutos());
    const conta = {
      id: DB.proximoId(),
      role: 'dependente',
      name: nome,
      email: login,
      phone: String((dados && dados.phone) || '').replace(/\D/g, ''),
      verified: 1,
      password_hash: Auth.hashSenha(senha),
      barbershop_id: null,
      consentimentos: [{ tipo: 'privacidade', data: new Date().toISOString(), versao: '1.0' }],
      created_at: agora,
      prefs: { notif_email: 'sim', notif_sms: 'não', lembrete: '30' }
    };
    db.users.push(conta);
    _auditLog(conta.id, 'criar_conta_dependente', { nome: conta.name });
    DB.salvar();
    return { ok: true, id: conta.id, link_pendente: true };
  }

  /* Vincula a conta já logada (dependente ou cliente) ao Código Único. */
  function vincularDependente(dados) {
    const user = sessao();
    const db = DB._d();
    const codigo = String((dados && dados.codigo_unico) || '').trim().toUpperCase();
    if (!codigo) err(400, 'Informe o código único da empresa.');

    const loja = db.barbershops.find(b =>
      b.codigo_unico && b.codigo_unico.toUpperCase() === codigo);
    if (!loja) err(404, 'Código único não encontrado.');

    const conta = db.users.find(u => u.id === user.id);
    if (!conta) err(404, 'Conta não encontrada.');
    if (conta.role !== 'dependente' && conta.role !== 'cliente') {
      err(403, 'Sua conta não pode ser vinculada como funcionário.');
    }
    if (conta.barbershop_id) {
      err(409, 'Esta conta já está vinculada a uma empresa.');
    }

    const { limite, ativos } = cotaDependentes(loja.id);
    if (limite === 0) {
      err(402, 'A empresa está com a assinatura inativa. Não é possível vincular funcionários agora.');
    }
    if (ativos.length >= limite) {
      err(409, 'A empresa já está no número de dependentes desta conta');
    }

    conta.role = 'dependente';
    conta.barbershop_id = loja.id;
    _auditLog(conta.id, 'vincular_dependente', { barbershop_id: loja.id, via: 'painel' });
    DB.salvar();
    return {
      ok: true,
      user: Auth.publicUser(conta),
      barbershop: Auth.salaoDoUsuario(conta),
      link_pendente: false
    };
  }

  /* O próprio dependente pode deixar de ser dependente (vira cliente). */
  function sairDeDependente() {
    const user = sessao();
    const db = DB._d();
    const conta = db.users.find(u => u.id === user.id);
    if (!conta || conta.role !== 'dependente') {
      err(400, 'Esta conta não é de um dependente.');
    }
    const shopId = conta.barbershop_id;
    conta.role = 'cliente';
    conta.barbershop_id = null;
    _auditLog(conta.id, 'desvincular_dependente', { barbershop_id: shopId, via: 'proprio' });
    DB.salvar();
    return { ok: true, user: Auth.publicUser(conta) };
  }

  /* O dono OU o barbeiro podem desligar (desvincular) um dependente da
     loja mantendo a conta. Isso libera a vaga da cota do plano para um
     novo funcionário. */
  function desvincularDependente(id) {
    const { shop, user } = exigirDonoOuBarbeiro();
    const db = DB._d();
    const alvo = db.users.find(u => u.id == id && u.role === 'dependente' && u.barbershop_id === shop.id);
    if (!alvo) err(404, 'Funcionário não encontrado nesta empresa.');
    alvo.role = 'cliente';
    alvo.barbershop_id = null;
    _auditLog(user.id, 'desvincular_dependente', { dependente_id: alvo.id, via: user.role });
    DB.salvar();
    return { ok: true, id: alvo.id };
  }

  function atualizarProfissional(id, patch) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'profissionais', 'Editar profissionais');
    const db = DB._d();
    const prof = db.professionals.find(p => p.id == id && p.barbershop_id === shop.id);
    if (!prof) err(404, 'Profissional não encontrado.');

    if (patch.name !== undefined) {
      const nome = String(patch.name).trim();
      if (nome.length < 2) err(400, 'Informe o nome do profissional.');
      prof.name = nome;
    }
    if (patch.phone !== undefined) prof.phone = String(patch.phone);
    if (patch.color !== undefined) prof.color = patch.color;
    if (patch.bio !== undefined) prof.bio = String(patch.bio).trim();
    if (patch.is_active !== undefined) {
      const querAtivar = patch.is_active ? 1 : 0;
      /* [SEGURANÇA] A cota max_professionals era checada só em
         criarProfissional. Reativar um profissional desativado passava
         direto, então dava para contornar o limite: desativar o único
         profissional do Autonomo, criar outro e reativar o primeiro.
         Agora a cota vale na reativação também. */
      if (querAtivar && !prof.is_active) {
        exigirCotaProfissionais(shop.id, prof.id);
      }
      prof.is_active = querAtivar;
    }

    /* regrava expediente usando os valores atuais como base (DT-09):
       um patch que só muda o almoço não reseta início/fim para o padrão */
    if (patch.start_time || patch.end_time || patch.lunch_start !== undefined || patch.lunch_end !== undefined) {
      const atual = db.working_hours.find(w =>
        w.barbershop_id === shop.id && w.professional_id === prof.id && w.day_of_week === 1) ||
        db.working_hours.find(w => w.barbershop_id === shop.id && w.professional_id === prof.id);
      gravarHorariosProfissional(
        shop.id, prof.id,
        patch.start_time || (atual && atual.start_time) || '09:00',
        patch.end_time || (atual && atual.end_time) || '19:00',
        patch.lunch_start !== undefined ? patch.lunch_start : (atual ? atual.lunch_start : null),
        patch.lunch_end !== undefined ? patch.lunch_end : (atual ? atual.lunch_end : null)
      );
    }

    if (Array.isArray(patch.service_ids)) substituirVinculos(prof.id, patch.service_ids);

    DB.salvar();
    return prof;
  }

  /** Soft-delete preferível (UC-09.4): is_active = 0. */
  function desativarProfissional(id) {
    return atualizarProfissional(id, { is_active: false });
  }

  /* ================= HORÁRIOS DE FUNCIONAMENTO (RF-027..031, DT-09) ================= */

  function horariosDaLoja(shopId, apenasLoja) {
    return DB._d().working_hours
      .filter(w => w.barbershop_id == shopId && (!apenasLoja || w.professional_id == null))
      .sort((a, b) => (a.day_of_week - b.day_of_week) || ((a.professional_id || 0) - (b.professional_id || 0)));
  }

  /** Upsert POR DIA da loja (preserva horários dos profissionais — DT-09). */
  function salvarHorariosLoja(dias) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'horarios', 'Editar horários de funcionamento');
    const db = DB._d();
    if (!Array.isArray(dias)) err(400, 'Envie a grade de horários.');

    /* RF-035: salvar o expediente habilita agendamento para o cliente */
    shop.horarios_configurados = 1;

    dias.forEach(dia => {
      const dow = Number(dia.day_of_week);
      if (!(dow >= 0 && dow <= 6)) err(400, 'Dia da semana inválido.');
      const existente = db.working_hours.find(w =>
        w.barbershop_id === shop.id && w.professional_id == null && w.day_of_week === dow);
      const payload = {
        start_time: dia.start_time || '09:00',
        end_time: dia.end_time || '18:00',
        lunch_start: dia.lunch_start || null,
        lunch_end: dia.lunch_end || null,
        is_open: dia.is_open ? 1 : 0
      };
      if (payload.is_open && payload.lunch_start && payload.lunch_end &&
          payload.lunch_start >= payload.lunch_end) {
        payload.lunch_start = payload.lunch_end = null;
      }
      if (existente) Object.assign(existente, payload);
      else db.working_hours.push({
        id: DB.proximoId(), barbershop_id: shop.id,
        professional_id: null, day_of_week: dow, ...payload
      });
    });

    /* sincroniza flag de abertura nos profissionais para o mesmo dia */
    dias.forEach(dia => {
      const dow = Number(dia.day_of_week);
      const lojaAberta = dias.find(d => Number(d.day_of_week) === dow).is_open ? 1 : 0;
      db.working_hours.forEach(w => {
        if (w.barbershop_id === shop.id && w.professional_id != null && w.day_of_week === dow) {
          w.is_open = lojaAberta;
        }
      });
    });

    DB.salvar();
    return horariosDaLoja(shop.id, true);
  }

  function atualizarLinhaHorario(rowId, patch) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'horarios', 'Editar horários de funcionamento');
    const w = DB._d().working_hours.find(x => x.id == rowId && x.barbershop_id === shop.id);
    if (!w) err(404, 'Linha de horário não encontrada.');
    ['start_time', 'end_time', 'lunch_start', 'lunch_end'].forEach(c => {
      if (patch[c] !== undefined) w[c] = patch[c] || null;
    });
    if (patch.is_open !== undefined) w.is_open = patch.is_open ? 1 : 0;
    shop.horarios_configurados = 1;
    DB.salvar();
    return w;
  }

  /* ---- exceções de agenda / folgas (RF-031 — GAP corrigido) ---- */

  function listarExcecoes() {
    const { shop } = exigirDono();
    return DB._d().schedule_exceptions.filter(x => x.barbershop_id === shop.id);
  }

  function criarExcecao(dados) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'horarios', 'Criar folgas');
    if (!dados.starts_at) err(400, 'Informe a data inicial da folga.');
    const TIPOS_EXC = ['folga', 'fechamento', 'feriado', 'evento'];
    const type = TIPOS_EXC.indexOf(dados.type) >= 0 ? dados.type : 'folga';
    const exc = {
      id: DB.proximoId(),
      barbershop_id: shop.id,
      professional_id: dados.professional_id || null,
      type: type,
      starts_at: dados.starts_at,
      ends_at: dados.ends_at || null,
      reason: String(dados.reason || '')
    };
    DB._d().schedule_exceptions.push(exc);
    DB.salvar();
    return exc;
  }

  function excluirExcecao(id) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'horarios', 'Excluir folgas');
    const db = DB._d();
    const x = db.schedule_exceptions.find(e => e.id == id && e.barbershop_id === shop.id);
    if (!x) err(404, 'Exceção não encontrada.');
    db.schedule_exceptions = db.schedule_exceptions.filter(e => e.id != id);
    DB.salvar();
    return { ok: true };
  }

  /* ================= MOTOR DE DISPONIBILIDADE (RF-032..036) ================= */

  const STEP_MIN = 15; // fallback quando o salão não define intervalo

  function periodosDeTrabalho(linhaWh) {
    if (!linhaWh || !linhaWh.is_open) return [];
    const ini = DB.hhmmToMin(linhaWh.start_time);
    const fim = DB.hhmmToMin(linhaWh.end_time);
    if (ini == null || fim == null || fim <= ini) return [];
    const lIni = linhaWh.lunch_start ? DB.hhmmToMin(linhaWh.lunch_start) : null;
    const lFim = linhaWh.lunch_end ? DB.hhmmToMin(linhaWh.lunch_end) : null;
    const temAlmoco = lIni != null && lFim != null && lIni < lFim;
    if (!temAlmoco) return [[ini, fim]];
    const periodos = [];
    if (ini < lIni) periodos.push([ini, lIni]);
    if (lFim < fim) periodos.push([lFim, fim]);
    return periodos;
  }

  function bloqueiosDoDia(db, shopId, profId, dataISO) {
    const prefixo = dataISO + 'T';
    const blocks = [];

    db.appointments.forEach(a => {
      if (a.barbershop_id != shopId) return;
      if (!a.starts_at.startsWith(prefixo)) return;
      if (a.status === 'cancelado' || a.status === 'nao_compareceu') return;
      if (profId != null) {
        if (a.professional_id != profId) return;   // conflito por profissional
      } else if (a.professional_id != null) {
        return;                                     // modo loja: só bloqueios "da casa"
      }
      blocks.push([
        DB.hhmmToMin(a.starts_at.slice(11)),
        DB.hhmmToMin(a.ends_at.slice(11))
      ]);
    });

    db.schedule_exceptions.forEach(x => {
      if (x.barbershop_id != shopId) return;
      if (x.professional_id != null && profId != null && x.professional_id != profId) return;
      if (profId == null && x.professional_id != null) return;
      const xIni = String(x.starts_at).slice(0, 10);
      const xFim = x.ends_at ? String(x.ends_at).slice(0, 10) : null;
      if (dataISO < xIni) return;
      if (xFim && dataISO > xFim) return;
      if (!xFim && dataISO > xIni) { blocks.push([0, 24 * 60]); return; } // folga sem fim
      const bIni = xIni === dataISO ? (DB.hhmmToMin(String(x.starts_at).slice(11)) || 0) : 0;
      const bFim = xFim === dataISO ? (DB.hhmmToMin(String(x.ends_at).slice(11)) ?? 24 * 60) : 24 * 60;
      blocks.push([bIni, bFim]);
    });

    return blocks;
  }

  function slotsLivres(periodos, durMin, bloqueios, stepMin) {
    const passo = clampInt(stepMin, 5, 180, STEP_MIN);
    const out = new Set();
    periodos.forEach(([pIni, pFim]) => {
      for (let t = pIni; t + durMin <= pFim; t += passo) {
        const conflita = bloqueios.some(([bIni, bFim]) => t < bFim && bIni < t + durMin);
        if (!conflita) out.add(DB.minToHHMM(t));
      }
    });
    return Array.from(out).sort();
  }

  /**
   * Funde intervalos [[ini, fim], ...] (em minutos) em faixas contínuas
   * e devolve em HH:MM. `agoraMin` (opcional) corta o início de hoje.
   */
  function mergeRanges(intervalos, agoraMin) {
    const mais = intervalos.slice().sort((a, b) => a[0] - b[0]);
    const merged = [];
    mais.forEach(([ini, fim]) => {
      if (agoraMin != null && fim <= agoraMin) return;
      if (agoraMin != null && ini < agoraMin) ini = agoraMin;
      if (ini >= fim) return;
      const ultimo = merged[merged.length - 1];
      if (ultimo && ini <= ultimo[1]) { ultimo[1] = Math.max(ultimo[1], fim); return; }
      merged.push([ini, fim]);
    });
    return merged.map(r => ({ start: DB.minToHHMM(r[0]), end: DB.minToHHMM(r[1]) }));
  }

  /**
   * Faixas contínuas de tempo livre (resolução de 1 minuto).
   * O cliente pode escolher QUALQUER horário dentro de uma faixa —
   * não apenas os "cliques" de 15 em 15 minutos dos slots.
   * `durMin` é a duração que cada horário deve caber dentro da faixa.
   */
  function rangesLivres(periodos, durMin, bloqueios) {
    const livres = [];
    periodos.forEach(([pIni, pFim]) => {
      for (let t = pIni; t + durMin <= pFim; t++) {
        const conflita = bloqueios.some(([bIni, bFim]) => t < bFim && bIni < t + durMin);
        if (!conflita) livres.push(t);
      }
    });
    /* funde minutos consecutivos em faixas [ini, fim] (fim exclusivo) */
    const ranges = [];
    livres.forEach(t => {
      const ult = ranges[ranges.length - 1];
      if (ult && t === ult[1]) { ult[1] = t + 1; return; }
      ranges.push([t, t + 1]);
    });
    return ranges.map(r => ({ start: DB.minToHHMM(r[0]), end: DB.minToHHMM(r[1]) }));
  }

  /**
   * RF-032 — GET availability.
   * Retorna mapa per_professional + união ordenada.
   * Sem profissionais cadastrados: valida contra o expediente da LOJA
   * usando todos os agendamentos do dia como bloqueio (RF-036 / DT-03).
   */
  function disponibilidade(barbershopId, dateISO, durMin, professionalId) {
    const db = DB._d();
    const shop = db.barbershops.find(b => b.id == barbershopId);
    if (!shop) err(404, 'Salão não encontrado.');
    if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) err(400, 'Informe uma data válida (AAAA-MM-DD).');
    const dur = clampInt(durMin, 5, 600, 30);
    const slotInterval = clampInt(shop.slotIntervalMin || shop.slot_interval_min || STEP_MIN, 5, 180, STEP_MIN);

    const dow = DB.diaSemana(dateISO);
    const linhaLoja = db.working_hours.find(w =>
      w.barbershop_id == shop.id && w.professional_id == null && w.day_of_week === dow);

    const respostaBase = {
      date: dateISO, duration_min: dur,
      is_open: !!(linhaLoja && linhaLoja.is_open),
      horarios_configurados: !!shop.horarios_configurados,
      per_professional: [], union: [], available_slots: [], free_ranges: []
    };
    if (!respostaBase.is_open) return respostaBase;
    /* RF-035: sem horários configurados pelo dono, a agenda fica vazia para o cliente */
    if (!shop.horarios_configurados) return respostaBase;

    const periodosLoja = periodosDeTrabalho(linhaLoja);

    /* filtro "passou" para hoje (UX coerente) */
    const ehHoje = dateISO === DB.hojeISO();
    const agoraMin = DB.agoraMinutos();
    const passou = t => ehHoje && t <= agoraMin;

    let profsAtivos = db.professionals.filter(p => p.barbershop_id == shop.id && p.is_active);
    if (professionalId) profsAtivos = profsAtivos.filter(p => p.id == professionalId);

    if (profsAtivos.length === 0) {
      /* DT-03: valida contra a LOJA mesmo sem profissionais */
      const bloqueios = bloqueiosDoDia(db, shop.id, null, dateISO)
        .concat(db.appointments
          .filter(a => a.barbershop_id == shop.id && a.professional_id == null &&
            a.starts_at.startsWith(dateISO + 'T') &&
            a.status !== 'cancelado' && a.status !== 'nao_compareceu')
          .map(a => [DB.hhmmToMin(a.starts_at.slice(11)), DB.hhmmToMin(a.ends_at.slice(11))]));
      const slots = slotsLivres(periodosLoja, dur, bloqueios, slotInterval).filter(h => !passou(DB.hhmmToMin(h)));
      respostaBase.union = slots;
      respostaBase.available_slots = slots;
      respostaBase.shop_only = true;
      respostaBase.free_ranges = mergeRanges(
        rangesLivres(periodosLoja, dur, bloqueios).map(r => [DB.hhmmToMin(r.start), DB.hhmmToMin(r.end)]),
        ehHoje ? agoraMin : null);
      return respostaBase;
    }

    const uniaoSet = new Set();
    const todasRanges = [];
    profsAtivos.forEach(p => {
      const linha = db.working_hours.find(w =>
        w.barbershop_id == shop.id && w.professional_id === p.id && w.day_of_week === dow);
      const periodos = (linha && linha.is_open) ? periodosDeTrabalho(linha) : [];
      if (!periodos.length) periodos.push(...periodosLoja); // fallback ao expediente da loja
      const slots = slotsLivres(periodos, dur, bloqueiosDoDia(db, shop.id, p.id, dateISO), slotInterval)
        .filter(h => !passou(DB.hhmmToMin(h)));
      const ranges = rangesLivres(periodos, dur, bloqueiosDoDia(db, shop.id, p.id, dateISO));
      respostaBase.per_professional.push({
        professional_id: p.id, professional_name: p.name, color: p.color, slots, free_ranges: ranges
      });
      slots.forEach(h => uniaoSet.add(h));
      ranges.forEach(r => todasRanges.push([DB.hhmmToMin(r.start), DB.hhmmToMin(r.end)]));
    });

    respostaBase.union = Array.from(uniaoSet).sort();
    respostaBase.available_slots = respostaBase.union;
    /* união das faixas livres de todos os profissionais (fundidas) */
    respostaBase.free_ranges = mergeRanges(todasRanges, ehHoje ? agoraMin : null);
    return respostaBase;
  }

  /** Dado um slot livre na união, escolhe o profissional com menos agendamentos no dia (round-robin leve). */
  function profissionalParaSlot(barbershopId, dateISO, hora, durMin) {
    const disp = disponibilidade(barbershopId, dateISO, durMin);
    const alvo = DB.hhmmToMin(hora);
    const aptos = disp.per_professional.filter(p =>
      p.slots.some(h => DB.hhmmToMin(h) === alvo));
    if (!aptos.length) return null;
    const db = DB._d();
    const contagem = {};
    aptos.forEach(p => { contagem[p.professional_id] = 0; });
    db.appointments.filter(a =>
      a.barbershop_id === barbershopId &&
      a.starts_at.startsWith(dateISO) &&
      a.status !== 'cancelado' &&
      aptos.some(p => p.professional_id === a.professional_id)
    ).forEach(a => { contagem[a.professional_id] = (contagem[a.professional_id] || 0) + 1; });
    aptos.sort((a, b) => (contagem[a.professional_id] || 0) - (contagem[b.professional_id] || 0));
    return { professional_id: aptos[0].professional_id, professional_name: aptos[0].professional_name };
  }

  /**
   * DT-04 — horário livre: valida QUALQUER minuto (não só os "clicks" de
   * STEP_MIN) contra o expediente + conflitos do(s) profissional(is).
   * Retorna os profissionais que conseguem atender naquele horário e, se
   * o horário estiver ocupado, as faixas livres para orientar o cliente.
   */
  function verificarHorarioLivre(barbershopId, dateISO, hora, durMin) {
    const db = DB._d();
    const shop = db.barbershops.find(b => b.id == barbershopId);
    if (!shop) err(404, 'Salão não encontrado.');
    if (!dateISO || !/^\d{4}-\d{2}-\d{2}$/.test(dateISO)) err(400, 'Informe uma data válida (AAAA-MM-DD).');
    if (!/^\d{2}:\d{2}$/.test(hora)) err(400, 'Horário inválido (use HH:MM).');
    const dur = clampInt(durMin, 5, 600, 30);
    const iniMin = DB.hhmmToMin(hora);

    let profs = db.professionals.filter(p => p.barbershop_id == shop.id && p.is_active);
    const candidatos = [];
    profs.forEach(p => {
      if (verificarSlot(db, shop.id, p.id, dateISO, iniMin, dur).ok) {
        candidatos.push({ professional_id: p.id, professional_name: p.name, color: p.color });
      }
    });
    /* sem profissionais: valida contra o expediente/horários da loja */
    const servicoLoja = profs.length === 0 && verificarSlot(db, shop.id, null, dateISO, iniMin, dur).ok;

    if (candidatos.length || servicoLoja) {
      return {
        ok: true, date: dateISO, hora, duration_min: dur,
        professionals: candidatos, shop_only: servicoLoja && profs.length === 0
      };
    }

    const disp = disponibilidade(barbershopId, dateISO, dur);
    return {
      ok: false, date: dateISO, hora, duration_min: dur,
      motivo: 'ocupado',
      free_ranges: disp.free_ranges || []
    };
  }

  /* ================= AGENDAMENTOS (RF-037..043, DT-07) ================= */

  const STATUS_VALIDOS = ['pendente', 'confirmado', 'concluido', 'nao_compareceu', 'cancelado'];

  function itensDoAgendamento(agId) {
    return DB._d().appointment_services
      .filter(i => i.appointment_id == agId)
      .map(i => ({
        service_id: i.service_id, name: i.name_snapshot,
        price: i.price_snapshot, duration_min: i.duration_snapshot
      }));
  }

  function agendamentoPublico(a) {
    const db = DB._d();
    const prof = a.professional_id ? db.professionals.find(p => p.id === a.professional_id) : null;
    const cliente = a.client_id ? db.clients.find(c => c.id === a.client_id) : null;
    const loja = db.barbershops.find(b => b.id === a.barbershop_id);
    return {
      id: a.id,
      barbershop_id: a.barbershop_id,
      barbershop_name: loja ? loja.name : '',
      client_id: a.client_id,
      client_name: a.client_name,
      client_phone: a.client_phone || '',
      client_email: a.client_email || '',
      professional_id: a.professional_id,
      professional_name: prof ? prof.name : null,
      starts_at: a.starts_at,
      ends_at: a.ends_at,
      date: a.starts_at.slice(0, 10),
      time: a.starts_at.slice(11),
      status: a.status,
      origin: a.origin,
      price_total: a.price_total,
      cancellation_reason: a.cancellation_reason || null,
      notes: a.notes || null,
      created_at: a.created_at,
      services: itensDoAgendamento(a.id),
      client_metrics: cliente
        ? { total_visits: cliente.total_visits, total_spent: cliente.total_spent }
        : null
    };
  }

  /**
   * Upsert de cliente por telefone → nome → usuário (RF-039.5).
   * Idempotente por telefone na mesma loja (RF-046).
   */
  function upsertCliente(shopId, dados, userId) {
    const db = DB._d();
    const tel = String(dados.client_phone || '').replace(/\D/g, '');
    let c = null;
    if (tel) c = db.clients.find(x => x.barbershop_id == shopId && x.phone === tel);
    if (!c && dados.client_email) {
      const em = String(dados.client_email).toLowerCase().trim();
      c = db.clients.find(x => x.barbershop_id == shopId &&
        String(x.email || '').toLowerCase().trim() === em);
    }
    if (!c && dados.client_name) {
      c = db.clients.find(x => x.barbershop_id == shopId &&
        x.name.toLowerCase().trim() === String(dados.client_name).toLowerCase().trim());
    }
    if (c) {
      c.name = c.name || dados.client_name;
      c.phone = tel || c.phone;
      c.email = dados.client_email || c.email;
      if (!c.user_id && userId) c.user_id = userId;
      return c;
    }
    c = {
      id: DB.proximoId(),
      barbershop_id: shopId,
      name: dados.client_name,
      phone: tel,
      email: dados.client_email || '',
      notes: '',
      total_visits: 0, total_spent: 0, last_visit_at: null,
      user_id: userId || null,
      created_at: agoraLocal()
    };
    db.clients.push(c);
    return c;
  }

  /**
   * RF-039 — criação de agendamento.
   * Exige usuário autenticado (cliente, dono ou barbeiro) — anônimo
   * recebe 401. No painel, staff agenda para clientes cadastrados.
   */
  function criarAgendamento(payload) {
    const db = DB._d();
    const user = Auth.usuarioAtual();
    if (!user) err(401, 'Faça login para agendar.');

    let shopId = payload.barbershop_id;
    const ehStaff = user.role === 'dono' || user.role === 'barbeiro' || user.role === 'dependente';
    if (!shopId && ehStaff) {
      const loja = Auth.salaoDoUsuario(user);
      if (loja) shopId = loja.id;
    }
    if (!shopId) err(400, 'Informe o salão do agendamento.');
    const shop = db.barbershops.find(b => b.id == shopId);
    if (!shop) err(404, 'Salão não encontrado.');

    /* staff só cria na própria loja — nunca numa alheia */
    let origemPainel = false;
    if (ehStaff) {
      const minha = Auth.salaoDoUsuario(user);
      if (!minha || minha.id != shop.id) {
        err(403, 'Você só pode agendar pela sua própria loja.');
      }
      origemPainel = true;
    }

    /* assinatura em dia é exigida para agendamentos públicos também —
       link de agendamento para de funcionar quando a assinatura expira. */
    if (!acessoLiberado(shop.id)) {
      err(402, 'Esta barbearia está com a assinatura inativa. O agendamento online está temporariamente indisponível.');
    }
    /* staff pelo painel: exige feature 'agendar' além da assinatura */
    if (origemPainel) {
      exigirFuncionalidade(shop.id, 'agendar', 'Criar agendamentos pelo painel');
    }
    const origin = origemPainel ? 'admin' : 'online';

    const date = String(payload.date || '');
    const hora = String(payload.start_time || payload.hora || '');
    const clientName = String(payload.client_name || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) err(400, 'Data inválida.');
    if (!/^\d{2}:\d{2}$/.test(hora)) err(400, 'Horário inválido.');
    if (!clientName) err(400, 'Nome do cliente é obrigatório.');

    /* bloqueio: cliente bloqueado pelo salão não consegue agendar */
    const telCli = String(payload.client_phone || '').replace(/\D/g, '');
    const clienteBloq = (db.clients || []).find(c =>
      c.barbershop_id === shop.id && telCli && c.phone === telCli);
    if (clienteBloq && _clienteBloqueado(shop.id, clienteBloq.id)) {
      err(403, 'Este cliente está bloqueado e não pode realizar novos agendamentos nesta barbearia.');
    }
    if (user && user.role === 'cliente') {
      const cliPorUser = (db.clients || []).find(c =>
        c.barbershop_id === shop.id && c.user_id === user.id);
      if (cliPorUser && _clienteBloqueado(shop.id, cliPorUser.id)) {
        err(403, 'Você está bloqueado nesta barbearia e não pode realizar novos agendamentos.');
      }
    }

    /* duração = soma dos serviços | informado | 30 (RF-039.2) */
    const idsServicos = Array.isArray(payload.service_ids) && payload.service_ids.length
      ? payload.service_ids.map(String)
      : (payload.service_id ? [String(payload.service_id)] : []);
    const svcs = idsServicos
      .map(id => db.services.find(s => s.id == id && s.barbershop_id == shop.id))
      .filter(Boolean);
    const durMin = svcs.length
      ? svcs.reduce((a, s) => a + s.duration_min, 0)
      : clampInt(payload.duration_min, 5, 600, 30);

    /* profissional informado ou primeiro ativo (RF-039.3) */
    let profId = payload.professional_id ? String(payload.professional_id) : null;
    if (profId) {
      const p = db.professionals.find(p => p.id == profId && p.barbershop_id == shop.id && p.is_active);
      if (!p) profId = null;
    }
    if (!profId) {
      const primeiro = db.professionals.find(p => p.barbershop_id == shop.id && p.is_active);
      profId = primeiro ? primeiro.id : null;
    }

    const iniMin = DB.hhmmToMin(hora);
    const fimMin = iniMin + durMin;
    const startsAt = date + 'T' + hora;

    /* validação de conflito (RF-039.4) — contra profissional OU loja (DT-03) */
    const disponivel = verificarSlot(db, shop.id, profId, date, iniMin, durMin);
    if (!disponivel.ok) {
      if (disponivel.motivo === 'sem-horarios') {
        err(409, 'Este salão ainda não definiu os horários de agendamento.');
      }
      const disp = disponibilidade(shop.id, date, durMin, profId);
      err(409, 'Conflito de horário para este profissional. Horários livres: ' +
        (disp.available_slots.join(', ') || 'nenhum neste dia.'));
    }

    const endsAt = date + 'T' + DB.minToHHMM(fimMin);

    /* preço vigente com override do profissional (RF-039.6) */
    const precoTotal = svcs.reduce((acc, s) => {
      const link = db.professional_services.find(ps =>
        ps.professional_id === profId && ps.service_id === s.id);
      const p = (link && link.price_override != null) ? link.price_override : s.price;
      return acc + Number(p);
    }, 0);

    const ag = {
      id: DB.proximoId(),
      barbershop_id: shop.id,
      client_id: null,
      professional_id: profId,
      user_id: user ? user.id : null,
      client_name: clientName,
      client_phone: String(payload.client_phone || ''),
      client_email: String(payload.client_email || ''),
      starts_at: startsAt,
      ends_at: endsAt,
      status: STATUS_VALIDOS.includes(payload.status) ? payload.status : 'pendente',
      origin,
      price_total: precoTotal,
      cancellation_reason: null,
      notes: String(payload.notes || '') || null,
      created_at: agoraLocal()
    };
    db.appointments.push(ag);

    /* snapshot dos itens (imune a edições futuras do catálogo) */
    svcs.forEach(s => db.appointment_services.push({
      id: DB.proximoId(),
      appointment_id: ag.id,
      service_id: s.id,
      name_snapshot: s.name,
      price_snapshot: s.price,
      duration_snapshot: s.duration_min
    }));

    /* resolução de cliente */
    ag.client_id = upsertCliente(shop.id, {
      client_name: clientName,
      client_phone: ag.client_phone,
      client_email: ag.client_email
    }, user ? user.id : null).id;

    DB.salvar();

    /* notificar dono da loja por e-mail */
    try {
      var lojaRef = (db.barbershops || []).find(function(b) { return b.id === ag.barbershop_id; });
      if (lojaRef && lojaRef.owner_email) {
        var cliRef = (db.users || []).find(function(u) { return u.id === ag.user_id; });
        Mailer.enviarNovoAgendamento(lojaRef.owner_email, {
          clienteNome: (cliRef && cliRef.name) || clientName,
          salaoNome: lojaRef.name,
          servicos: svcs.map(function(s) { return s.name; }),
          data: DB.fmtDataBR(date),
          hora: hora
        }).catch(function() {});
      }
      /* confirmar para o cliente por e-mail */
      var cliRef2 = (db.users || []).find(function(u) { return u.id === ag.user_id; });
      if (cliRef2 && cliRef2.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cliRef2.email)) {
        Mailer.enviarConfirmacaoAgendamento(cliRef2.email, {
          salaoNome: lojaRef ? lojaRef.name : 'Seu salão',
          servicos: svcs.map(function(s) { return s.name; }),
          data: DB.fmtDataBR(date),
          hora: hora,
          clienteNome: cliRef2.name
        }).catch(function() {});
      }
    } catch (notifErr) { /* notificação é best-effort */ }

    /* notificações (UC-17 / RF-066) */
    const nomesSvc = svcs.map(s => s.name).join(' + ') || 'atendimento';
    notificar({
      user_id: user ? user.id : null,
      barbershop_id: shop.id,
      type: 'appointment_created',
      title: 'Agendamento solicitado',
      message: 'Seu pedido de ' + nomesSvc + ' na ' + shop.name +
        ' foi registrado para ' + DB.fmtDataBR(date) + ' às ' + hora + '.',
      extra: { appointment_id: ag.id }
    });
    if (shop.owner_user_id) {
      notificar({
        user_id: shop.owner_user_id,
        barbershop_id: shop.id,
        type: 'new_appointment',
        title: 'Novo agendamento',
        message: clientName + ' solicitou ' + nomesSvc + ' para ' +
          DB.fmtDataBR(date) + ' às ' + hora + '.',
        extra: { appointment_id: ag.id }
      });
    }

    return agendamentoPublico(ag);
  }

  function verificarSlot(db, shopId, profId, dateISO, iniMin, durMin) {
    const shop = db.barbershops.find(b => b.id == shopId);
    if (!shop || !shop.horarios_configurados) {
      return { ok: false, motivo: 'sem-horarios' };
    }
    const dow = DB.diaSemana(dateISO);

    let linha = null;
    if (profId != null) {
      linha = db.working_hours.find(w =>
        w.barbershop_id == shopId && w.professional_id === profId && w.day_of_week === dow);
      if (!linha || !linha.is_open) {
        linha = db.working_hours.find(w =>
          w.barbershop_id == shopId && w.professional_id == null && w.day_of_week === dow);
      }
    } else {
      linha = db.working_hours.find(w =>
        w.barbershop_id == shopId && w.professional_id == null && w.day_of_week === dow);
    }

    const cabe = periodosDeTrabalho(linha).some(([pi, pf]) => iniMin >= pi && iniMin + durMin <= pf);
    if (!cabe) return { ok: false, motivo: 'fora-do-expediente' };

    const ocupado = profId != null
      ? bloqueiosDoDia(db, shopId, profId, dateISO)
      : bloqueiosDoDia(db, shopId, null, dateISO)
        .concat(db.appointments
          .filter(a => a.barbershop_id == shopId && a.professional_id != null &&
            a.starts_at.startsWith(dateISO + 'T') &&
            a.status !== 'cancelado' && a.status !== 'nao_compareceu')
          .map(a => [DB.hhmmToMin(a.starts_at.slice(11)), DB.hhmmToMin(a.ends_at.slice(11))]));

    const conflita = ocupado.some(([bi, bf]) => iniMin < bf && bi < iniMin + durMin);
    return conflita ? { ok: false, motivo: 'conflito' } : { ok: true };
  }

  function listarAgendamentos(filtros) {
    filtros = filtros || {};
    const db = DB._d();
    let escopo;

    if (filtros.scope === 'me') {
      const user = sessao();
      escopo = db.appointments.filter(a => a.user_id === user.id);
    } else {
      const { shop } = exigirEquipe();
      escopo = db.appointments.filter(a => a.barbershop_id === shop.id);
    }

    if (filtros.date) escopo = escopo.filter(a => a.starts_at.startsWith(filtros.date));
    if (filtros.status) escopo = escopo.filter(a => a.status === filtros.status);
    if (filtros.professional_id) escopo = escopo.filter(a => a.professional_id == filtros.professional_id);
    if (filtros.client_id) escopo = escopo.filter(a => a.client_id == filtros.client_id);
    if (filtros.q) {
      const q = String(filtros.q).toLowerCase();
      escopo = escopo.filter(a => a.client_name.toLowerCase().includes(q));
    }
    if (filtros.de) escopo = escopo.filter(a => a.starts_at.slice(0, 10) >= filtros.de);
    if (filtros.ate) escopo = escopo.filter(a => a.starts_at.slice(0, 10) <= filtros.ate);

    const ordem = filtros.ordem === 'asc' ? 1 : -1;
    escopo.sort((a, b) => ordem * a.starts_at.localeCompare(b.starts_at));

    const limite = clampInt(filtros.limit, 1, 200, 200);
    const page = clampInt(filtros.page, 1, 99999, 1);
    const total = escopo.length;
    const items = escopo.slice((page - 1) * limite, page * limite).map(agendamentoPublico);
    return { items, total, page, limit: limite };
  }

  /**
   * RF-041 — PATCH parcial com autorização por papel e revalidação
   * de conflito (DT-07) + métricas do cliente ao concluir (RF-042).
   */
  function atualizarAgendamento(id, patch) {
    const user = sessao();
    const db = DB._d();
    const ag = db.appointments.find(a => a.id == id);
    if (!ag) err(404, 'Agendamento não encontrado.');

    const lojaAg = db.barbershops.find(b => b.id === ag.barbershop_id);
    const ehEquipe = !!lojaAg && (
      lojaAg.owner_user_id === user.id ||
      ((user.role === 'barbeiro' || user.role === 'dependente') &&
        (Auth.salaoDoUsuario(user) || {}).id === lojaAg.id)
    );
    const ehCliente = ag.user_id === user.id;
    if (!ehEquipe && !ehCliente) err(403, 'Você não tem permissão sobre este agendamento.');
    if (ehEquipe) exigirFuncionalidade(ag.barbershop_id, 'agendar', 'Editar agendamentos pelo painel');

    /* cliente só cancela ou reagenda o próprio (RF-041 + self-service) */
    if (!ehEquipe) {
      if (patch.status !== undefined && patch.status !== 'cancelado')
        err(403, 'Cliente só pode cancelar ou reagendar o próprio agendamento.');
      if (ag.status === 'concluido' || ag.status === 'cancelado') {
        err(400, 'Este agendamento já está ' + ag.status + ' e não pode ser alterado.');
      }
    }

    /* enum de status válido (DT-07) */
    let novoStatus = ag.status;
    if (patch.status !== undefined) {
      if (!STATUS_VALIDOS.includes(patch.status)) {
        err(400, 'Status inválido. Use: ' + STATUS_VALIDOS.join(', ') + '.');
      }
      novoStatus = patch.status;
    }

    /* reagendamento: recalcula fim e revalida conflito (DT-07) */
    let novaData = ag.starts_at.slice(0, 10);
    let novaHora = ag.starts_at.slice(11);
    if (ehEquipe || ehCliente) {
      if (patch.date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.date)) err(400, 'Data inválida.');
        novaData = patch.date;
      }
      if (patch.start_time || patch.hora) {
        novaHora = String(patch.start_time || patch.hora);
        if (!/^\d{2}:\d{2}$/.test(novaHora)) err(400, 'Horário inválido.');
      }
      if (patch.professional_id !== undefined && ehEquipe) {
        const pid = patch.professional_id ? String(patch.professional_id) : null;
        if (pid) {
          const p = db.professionals.find(x => x.id == pid && x.barbershop_id === ag.barbershop_id);
          if (!p) err(400, 'Profissional inválido para esta loja.');
        }
        ag.professional_id = pid;
      }
    }

    if (novaData !== ag.starts_at.slice(0, 10) || novaHora !== ag.starts_at.slice(11) ||
        patch.professional_id !== undefined) {
      const itens = itensDoAgendamento(ag.id);
      const dur = itens.length
        ? itens.reduce((a, i) => a + i.duration_min, 0)
        : clampInt(patch.duration_min, 5, 600, 30);
      const okSlot = verificarSlot(db, ag.barbershop_id, ag.professional_id, novaData,
        DB.hhmmToMin(novaHora), dur);
      if (!okSlot.ok) {
        if (okSlot.motivo === 'sem-horarios') {
          err(409, 'Este salão ainda não definiu os horários de agendamento.');
        }
        const disp = disponibilidade(ag.barbershop_id, novaData, dur, ag.professional_id);
        err(409, 'Conflito de horário. Livres: ' + (disp.available_slots.join(', ') || 'nenhum neste dia.'));
      }
      ag.starts_at = novaData + 'T' + novaHora;
      ag.ends_at = novaData + 'T' + DB.minToHHMM(DB.hhmmToMin(novaHora) + dur);
    }

    const statusAnterior = ag.status;
    ag.status = novoStatus;

    if (ehEquipe) {
      if (patch.notes !== undefined) ag.notes = String(patch.notes || '') || null;
      if (patch.cancellation_reason !== undefined) {
        ag.cancellation_reason = String(patch.cancellation_reason || '') || null;
      }
    }

    /* RF-042: ao concluir, cria/atualiza cliente e incrementa métricas
       apenas se ainda não havia client_id (DT-11) */
    if (novoStatus === 'concluido' && statusAnterior !== 'concluido' && !ag.client_id) {
      const c = upsertCliente(ag.barbershop_id, {
        client_name: ag.client_name,
        client_phone: ag.client_phone,
        client_email: ag.client_email
      }, ag.user_id);
      ag.client_id = c.id;
      c.total_visits += 1;
      c.total_spent += Number(ag.price_total || 0);
      c.last_visit_at = ag.ends_at;
    }

    DB.salvar();

    /* notificação de mudança de status para o cliente (RF-066) */
    if (novoStatus !== statusAnterior && ag.user_id) {
      const rotulos = {
        pendente: 'pendente', confirmado: 'confirmado', concluido: 'concluído',
        nao_compareceu: 'marcado como não compareceu', cancelado: 'cancelado'
      };
      notificar({
        user_id: ag.user_id,
        barbershop_id: ag.barbershop_id,
        type: 'appointment_status',
        title: 'Agendamento ' + rotulos[novoStatus],
        message: 'Seu agendamento na ' + nomeLoja(ag.barbershop_id) +
          ' foi ' + rotulos[novoStatus] + '.',
        extra: { appointment_id: ag.id, old_status: statusAnterior, new_status: novoStatus }
      });
    }

    return agendamentoPublico(ag);
  }

  function excluirAgendamento(id) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'agendar', 'Excluir agendamentos');
    const db = DB._d();
    const ag = db.appointments.find(a => a.id == id && a.barbershop_id === shop.id);
    if (!ag) err(404, 'Agendamento não encontrado.');
    db.appointment_services = db.appointment_services.filter(i => i.appointment_id != id);
    db.appointments = db.appointments.filter(a => a.id != id);
    DB.salvar();
    return { ok: true };
  }

  /* me/appointments — todas as lojas, mais recentes primeiro (RF-009) */
  function meusAgendamentos() {
    const user = sessao();
    return listarAgendamentos({ scope: 'me', ordem: 'desc', limit: 200 }).items
      .map(agendamentoPublico);
  }

  /* ================= CLIENTES / CRM (RF-044..047) ================= */

  function listarClientes(filtros) {
    filtros = filtros || {};
    const { shop } = exigirEquipe();
    let lista = DB._d().clients.filter(c => c.barbershop_id === shop.id);

    const q = String(filtros.q || '').toLowerCase().trim();
    if (q) lista = lista.filter(c =>
      c.name.toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q.replace(/\D/g, '')));

    lista.sort((a, b) => a.name.localeCompare(b.name));

    const limite = clampInt(filtros.limit, 1, 200, 200);
    const page = clampInt(filtros.page, 1, 9999, 1);
    const total = lista.length;
    return {
      items: lista.slice((page - 1) * limite, page * limite).map(c => clientePublico(c)),
      total, page, limit: limite
    };
  }

  function clientePublico(c) {
    return {
      id: c.id, name: c.name, phone: c.phone || '', email: c.email || '',
      notes: c.notes || '', total_visits: c.total_visits,
      total_spent: c.total_spent, last_visit_at: c.last_visit_at,   // campo correto (DT-23)
      user_id: c.user_id || null, created_at: c.created_at,
      blocked: _clienteBloqueado(c.barbershop_id, c.id)
    };
  }

  function getCliente(id) {
    const { shop } = exigirEquipe();
    const c = DB._d().clients.find(x => x.id == id && x.barbershop_id === shop.id);
    if (!c) err(404, 'Cliente não encontrado.');
    return clientePublico(c);
  }

  function criarCliente(dados) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'clientes', 'Cadastrar clientes');
    const nome = String(dados.name || '').trim();
    if (!nome) err(400, 'Nome é obrigatório.');
    if (nome.length > 120) err(400, 'Nome muito longo (máximo 120 caracteres).');
    const tel = normalizarTelefone(dados.phone);
    if (tel && (tel.length < 10 || tel.length > 13)) {
      err(400, 'Telefone inválido: use de 10 a 13 dígitos.');
    }

    /* idempotente por telefone (RF-046) */
    if (tel) {
      const existe = DB._d().clients.find(c =>
        c.barbershop_id === shop.id && normalizarTelefone(c.phone) === tel);
      if (existe) return clientePublico(existe);
    }

    const email = String(dados.email || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err(400, 'E-mail inválido.');

    const c = {
      id: DB.proximoId(), barbershop_id: shop.id,
      name: nome, phone: tel, email: email,
      notes: String(dados.notes || ''), total_visits: 0, total_spent: 0,
      last_visit_at: null, user_id: null, created_at: agoraLocal()
    };
    DB._d().clients.push(c);
    DB.salvar();
    return clientePublico(c);
  }

  function atualizarCliente(id, patch) {
    const { shop } = exigirEquipe();
    exigirFuncionalidade(shop.id, 'clientes', 'Editar clientes');
    const c = DB._d().clients.find(x => x.id == id && x.barbershop_id === shop.id);
    if (!c) err(404, 'Cliente não encontrado.');
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) err(400, 'Nome é obrigatório.');
      c.name = n;
    }
    if (patch.phone !== undefined) {
      const tel = normalizarTelefone(patch.phone);
      if (tel) {
        if (tel.length < 10) err(400, 'Telefone inválido: mínimo de 10 dígitos.');
        if (tel.length > 13) err(400, 'Telefone inválido: máximo de 13 dígitos (com DDI).');
        /* (barbershop_id, phone) é UNIQUE: aceitar telefone repetido no
           mesmo salão quebra a persistência da coleção clients inteira */
        const outro = DB._d().clients.find(x =>
          x.id !== c.id && x.barbershop_id === shop.id && normalizarTelefone(x.phone) === tel);
        if (outro) err(409, 'Já existe um cliente com este telefone neste salão.');
        c.phone = tel;
      } else {
        c.phone = '';
      }
    }
    if (patch.email !== undefined) {
      const em = String(patch.email).trim().toLowerCase();
      if (em && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) err(400, 'E-mail inválido.');
      c.email = em;
    }
    if (patch.notes !== undefined) c.notes = String(patch.notes);
    DB.salvar();
    return clientePublico(c);
  }

  function agendamentosDoCliente(clienteId) {
    const { shop } = exigirEquipe();
    const db = DB._d();
    const c = db.clients.find(x => x.id == clienteId && x.barbershop_id === shop.id);
    if (!c) err(404, 'Cliente não encontrado.');
    return db.appointments
      .filter(a => a.client_id == clienteId)
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
      .map(agendamentoPublico);
  }

  /* ================= DASHBOARD (RF-048..049) ================= */

  function janelaPeriodo(periodo) {
    const hoje = DB.hojeISO();
    switch (periodo) {
      case 'today': return { inicio: hoje, fim: hoje };
      case 'week': return { inicio: DB.addDiasISO(-6), fim: hoje };
      case 'year': return { inicio: DB.addDiasISO(-364), fim: hoje };
      case 'month':
      default: return { inicio: DB.addDiasISO(-29), fim: hoje };
    }
  }

  function dashboardStats(periodo) {
    const { shop } = exigirDono();
    const db = DB._d();
    const { inicio, fim } = janelaPeriodo(periodo);

    const noPeriodo = db.appointments.filter(a =>
      a.barbershop_id === shop.id &&
      a.starts_at.slice(0, 10) >= inicio && a.starts_at.slice(0, 10) <= fim);

    const concluidos = noPeriodo.filter(a => a.status === 'concluido');
    const receita = concluidos.reduce((acc, a) => acc + Number(a.price_total || 0), 0);
    const ticketMedio = concluidos.length ? receita / concluidos.length : 0;
    const taxaConclusao = noPeriodo.length
      ? Math.round(concluidos.length / noPeriodo.length * 1000) / 10
      : 0;

    /* clientes */
    const clientesTotal = db.clients.filter(c => c.barbershop_id === shop.id).length;
    const clientesNovos = db.clients.filter(c =>
      c.barbershop_id === shop.id &&
      (c.created_at || '').slice(0, 10) >= inicio &&
      (c.created_at || '').slice(0, 10) <= fim).length;

    /* top serviços (por aparições em concluídos) */
    const contagemSvc = {};
    concluidos.forEach(a => itensDoAgendamento(a.id).forEach(i => {
      if (!contagemSvc[i.name]) contagemSvc[i.name] = { name: i.name, count: 0, revenue: 0 };
      contagemSvc[i.name].count++;
      contagemSvc[i.name].revenue += i.price;
    }));
    const topServices = Object.values(contagemSvc)
      .sort((a, b) => b.count - a.count).slice(0, 5);

    /* top profissionais */
    const contagemProf = {};
    concluidos.forEach(a => {
      if (a.professional_id == null) return;
      const p = db.professionals.find(x => x.id === a.professional_id);
      const key = a.professional_id;
      if (!contagemProf[key]) contagemProf[key] = { name: p ? p.name : '—', count: 0, revenue: 0 };
      contagemProf[key].count++;
      contagemProf[key].revenue += Number(a.price_total || 0);
    });
    const topProfessionals = Object.values(contagemProf)
      .sort((a, b) => b.count - a.count).slice(0, 5);

    /* séries temporais */
    const serieDia = {};
    const d = DB.parseISO(inicio);
    while (true) {
      const iso = d.getFullYear() + '-' + DB.pad2(d.getMonth() + 1) + '-' + DB.pad2(d.getDate());
      if (iso > fim) break;
      serieDia[iso] = 0;
      d.setDate(d.getDate() + 1);
    }
    const serieHora = {};
    noPeriodo.forEach(a => {
      const dia = a.starts_at.slice(0, 10);
      const hora = a.starts_at.slice(11, 13) + ':00';
      if (serieDia[dia] !== undefined) serieDia[dia]++;
      serieHora[hora] = (serieHora[hora] || 0) + 1;
    });

    return {
      period: periodo || 'month', start_date: inicio, end_date: fim,
      summary: {
        appointments_total: noPeriodo.length,
        concluded: concluidos.length,
        cancelled: noPeriodo.filter(a => a.status === 'cancelado').length,
        no_show: noPeriodo.filter(a => a.status === 'nao_compareceu').length,
        pending: noPeriodo.filter(a => a.status === 'pendente').length,
        completion_rate_pct: taxaConclusao,
        revenue: Math.round(revenue(receita)),
        avg_ticket: Math.round(ticketMedio * 100) / 100
      },
      clients: { total: clientesTotal, novos_no_periodo: clientesNovos },
      top_services: topServices,
      top_professionals: topProfessionals,
      series_by_day: serieDia,
      series_by_hour: serieHora
    };
  }

  function revenue(v) { return v * 100 / 100; }

  /** RF-049 — CSV com BOM UTF-8 e escaping de aspas. */
  function exportarCSV(inicio, fim, statuses) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'exportar_csv', 'Exportar CSV');
    const db = DB._d();
    const statusSet = Array.isArray(statuses) && statuses.length
      ? new Set(statuses) : null;
    let linhas = db.appointments
      .filter(a => a.barbershop_id === shop.id &&
        a.starts_at.slice(0, 10) >= (inicio || '0000-00-00') &&
        a.starts_at.slice(0, 10) <= (fim || '9999-99-99'));
    if (statusSet) linhas = linhas.filter(a => statusSet.has(a.status));
    linhas.sort((a, b) => a.starts_at.localeCompare(b.starts_at));

    function campo(v) {
      const s = v == null ? '' : String(v);
      return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    const cab = ['ID', 'Cliente', 'Telefone', 'Email', 'Data Início', 'Data Fim',
      'Status', 'Valor Total', 'Profissional', 'Serviços', 'Observações'];
    const corpo = linhas.map(a => {
      const prof = a.professional_id ? db.professionals.find(p => p.id === a.professional_id) : null;
      const svcs = itensDoAgendamento(a.id).map(i => i.name).join('; ');
      return [
        a.id, a.client_name, a.client_phone, a.client_email,
        a.starts_at, a.ends_at, a.status,
        Number(a.price_total).toFixed(2),
        prof ? prof.name : '', svcs, a.notes || ''
      ].map(campo).join(';');
    });

    return '\uFEFF' + cab.map(campo).join(';') + '\r\n' + corpo.join('\r\n');
  }

  /* ================= RELATÓRIOS ESCALONADOS (RF-070 v3.1) =================
     Cada plano pago libera um relatório progressivamente mais completo:

       Free          → sem acesso a relatórios
       Autonomo      → basico        (faturamento total)
       Salao         → intermediario (+ total agendamentos, ticket médio)
       Salao Pro     → completo      (+ serviço/profissional top, horários
                                      de pico, comparação de períodos, CSV)

     [SEGURANÇA] O nível vem do plano EFETIVO da loja no backend. Campos
     dos níveis superiores NUNCA são calculados/retornados para os
     inferiores (fail-closed) — o frontend apenas renderiza o que chega.
  ===================================================================== */

  /* Nível de relatório do plano EFETIVO da loja.
     Free/planos sem valor → null (sem acesso). */
  function nivelRelatorioDe(shopId) {
    const { plano } = planoEfetivo(shopId);
    const nivel = plano && plano.nivel_relatorio;
    return ['basico', 'intermediario', 'completo'].includes(nivel) ? nivel : null;
  }

  /* Gate de acesso (mesma regra usada na API e nos testes) */
  function podeAcessarRelatorio(nivelPlano) {
    return ['basico', 'intermediario', 'completo'].includes(nivelPlano);
  }

  /* Resolve a loja da sessão, o nível e barra planos sem relatórios */
  function exigirNivelRelatorio() {
    const { shop } = exigirDono();
    exigirAssinaturaAtiva(shop.id);
    const nivel = nivelRelatorioDe(shop.id);
    if (!podeAcessarRelatorio(nivel)) {
      const { plano } = planoEfetivo(shop.id);
      throw {
        status: 403,
        error: 'Relatórios estão bloqueados no seu plano (' + ((plano && plano.name) || 'sem plano') +
          '). Assine ou faça upgrade na aba Assinatura para liberar.'
      };
    }
    return { shop, nivel };
  }

  /* ---- funções auxiliares ---- */

  function noPeriodo(shopId, inicio, fim) {
    return DB._d().appointments.filter(a =>
      a.barbershop_id === shopId && a.status === 'concluido' &&
      a.starts_at.slice(0, 10) >= inicio && a.starts_at.slice(0, 10) <= fim);
  }

  function calcularFaturamentoTotal(shopId, inicio, fim) {
    return noPeriodo(shopId, inicio, fim)
      .reduce((acc, a) => acc + Number(a.price_total || 0), 0);
  }

  function contarAgendamentos(shopId, inicio, fim) {
    return noPeriodo(shopId, inicio, fim).length;
  }

  /* Resumo (textos) das funcionalidades de relatório — benefícios idênticos
     em todos os planos pagos (v4). O nível diferencia apenas o número de
     profissionais; relatórios completos valem para qualquer plano. */
  function relatoriosResumoPorNivel(nivel) {
    switch (nivel) {
      case 'basico':
      case 'intermediario':
      case 'completo':
        return [
          'Relatório diário gerado automaticamente às 00:00',
          'Totais financeiros: dia a dia, semana e mês',
          'Gráfico com o dia de maior lucro no período',
          'Relatório detalhado por atendimento (cliente, profissional, serviço, valor)',
          'Comparação de períodos e horários de pico',
          'Exportação dos dados em CSV'
        ];
      default:
        return [
          'Relatório diário gerado automaticamente às 00:00 (todos os planos pagos)',
          'Assine um plano pago para liberar os relatórios'
        ];
    }
  }

  /* Semana corrente (últimos 7 dias) + delta da semana anterior (Autonomo+) */
  function resumoSemanal(shopId) {
    const hoje = DB.hojeISO();
    const inicio = DB.addDiasISO(-6);
    const antIni = DB.addDiasISO(-13);
    const antFim = DB.addDiasISO(-7);
    const fAtual = calcularFaturamentoTotal(shopId, inicio, hoje);
    const fAnte = calcularFaturamentoTotal(shopId, antIni, antFim);
    return {
      inicio, fim: hoje,
      faturamento: Math.round(fAtual * 100) / 100,
      agendamentos: contarAgendamentos(shopId, inicio, hoje),
      delta_faturamento_pct: fAnte > 0 ? Math.round((fAtual - fAnte) / fAnte * 1000) / 10 : null
    };
  }

  /* Série diária por dia (para o gráfico do dia com mais lucro) */
  function serieDias(shopId, inicio, fim) {
    const mapa = {};
    noPeriodo(shopId, inicio, fim).forEach(a => {
      const d = a.starts_at.slice(0, 10);
      if (!mapa[d]) mapa[d] = { data: d, faturamento: 0, agendamentos: 0 };
      mapa[d].faturamento += Number(a.price_total || 0);
      mapa[d].agendamentos++;
    });
    return Object.keys(mapa).sort().map(d => ({
      data: d,
      faturamento: Math.round(mapa[d].faturamento * 100) / 100,
      agendamentos: mapa[d].agendamentos
    }));
  }

  /* Dia com o maior faturamento no período (Salão+) */
  function melhorDiaDe(shopId, inicio, fim) {
    const serie = serieDias(shopId, inicio, fim);
    if (!serie.length) return null;
    return serie.reduce((a, b) => (b.faturamento > a.faturamento ? b : a));
  }

  /* Resultado mensal (mês corrente) + delta do mês anterior (Salão+) */
  function resumoMensal(shopId) {
    const hoje = DB.hojeISO();
    const inicio = hoje.slice(0, 7) + '-01';
    const prev = new Date(Number(hoje.slice(0, 4)), Number(hoje.slice(5, 7)) - 1, 0);
    const prevAno = prev.getFullYear();
    const prevMes = prev.getMonth() + 1;
    const prevLabel = prevAno + '-' + String(prevMes).padStart(2, '0');
    const prevIni = prevLabel + '-01';
    const prevFim = prevLabel + '-' + String(new Date(prevAno, prevMes, 0).getDate()).padStart(2, '0');
    const fMensal = calcularFaturamentoTotal(shopId, inicio, hoje);
    const fPrev = calcularFaturamentoTotal(shopId, prevIni, prevFim);
    return {
      mes: hoje.slice(0, 7), inicio, fim: hoje,
      faturamento: Math.round(fMensal * 100) / 100,
      agendamentos: contarAgendamentos(shopId, inicio, hoje),
      delta_faturamento_pct: fPrev > 0 ? Math.round((fMensal - fPrev) / fPrev * 1000) / 10 : null,
      mes_anterior: prevLabel
    };
  }

  /* Detalhamento por atendimento: o cliente que fez aquele corte (Salão Pro) */
  function atendimentosDetalhados(shopId, inicio, fim, limite) {
    const db = DB._d();
    return noPeriodo(shopId, inicio, fim)
      .slice()
      .sort((a, b) => b.starts_at.localeCompare(a.starts_at))
      .slice(0, limite || 200)
      .map(a => {
        const prof = a.professional_id ? db.professionals.find(p => p.id === a.professional_id) : null;
        const itens = itensDoAgendamento(a.id);
        return {
          id: a.id,
          data: a.starts_at.slice(0, 10),
          hora: a.starts_at.slice(11, 16),
          cliente: a.client_name || '—',
          profissional: prof ? prof.name : '—',
          servicos: itens.map(i => i.name).join(', ') || '—',
          valor: Math.round(Number(a.price_total || 0) * 100) / 100
        };
      });
  }

  function servicoMaisRealizado(shopId, inicio, fim) {
    const contagem = {};
    noPeriodo(shopId, inicio, fim).forEach(a => itensDoAgendamento(a.id).forEach(i => {
      if (!contagem[i.name]) contagem[i.name] = { nome: i.name, count: 0, receita: 0 };
      contagem[i.name].count++;
      contagem[i.name].receita += Number(i.price || 0);
    }));
    return Object.values(contagem)
      .sort((a, b) => b.count - a.count || b.receita - a.receita)[0] || null;
  }

  function profissionalMaisRentavel(shopId, inicio, fim) {
    const db = DB._d();
    const contagem = {};
    noPeriodo(shopId, inicio, fim).forEach(a => {
      if (a.professional_id == null) return;
      if (!contagem[a.professional_id]) {
        const p = db.professionals.find(x => x.id === a.professional_id);
        contagem[a.professional_id] = {
          id: a.professional_id, nome: p ? p.name : '—', receita: 0, atendimentos: 0
        };
      }
      contagem[a.professional_id].receita += Number(a.price_total || 0);
      contagem[a.professional_id].atendimentos++;
    });
    return Object.values(contagem).sort((a, b) => b.receita - a.receita)[0] || null;
  }

  function horariosPico(shopId, inicio, fim, limite) {
    const contagem = {};
    noPeriodo(shopId, inicio, fim).forEach(a => {
      const h = Number(a.starts_at.slice(11, 13));
      const faixa = String(h).padStart(2, '0') + ':00–' + String(h + 1).padStart(2, '0') + ':00';
      contagem[faixa] = (contagem[faixa] || 0) + 1;
    });
    return Object.keys(contagem)
      .map(faixa => ({ faixa, count: contagem[faixa] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limite || 5);
  }

  /* Job diário (00:00, padrão de todos os planos): gera/refresca o snapshot
     de faturamento por loja para a data informada + ontem (re-catchup).
     INTERNO — não é exposto via RPC (apenas window.__CC_INTERNAL). */
  function gerarDiariosParaData(data) {
    const db = DB._d();
    const alvos = [];
    [data || DB.hojeISO(), DB.addDiasISO(-1)].forEach(d => {
      if (d && alvos.indexOf(d) < 0) alvos.push(d);
    });
    const hoje = DB.hojeISO();

    /* Passada única: agrupa os agendamentos concluídos por loja+data,
       evitando um filter O(total) para CADA loja (job roda por todas). */
    const porLoja = new Map();
    for (const a of db.appointments) {
      if (a.status !== 'concluido') continue;
      const dia = a.starts_at.slice(0, 10);
      if (alvos.indexOf(dia) < 0) continue;
      const chave = a.barbershop_id + '|' + dia;
      let l = porLoja.get(chave);
      if (!l) { l = []; porLoja.set(chave, l); }
      l.push(a);
    }

    /* Índices para não repetir findIndex dentro do laço dias × lojas
       (era O(dias × lojas × relatórios)). */
    const idxRelatorio = new Map();
    db.relatorios_diarios.forEach(function(r, i) {
      if (!idxRelatorio.has(r.barbershop_id + '|' + r.data)) idxRelatorio.set(r.barbershop_id + '|' + r.data, i);
    });

    for (const dia of alvos) {
      const diaCorrente = dia === hoje;
      for (const loja of db.barbershops) {
        const chave = loja.id + '|' + dia;
        const lista = porLoja.get(chave) || [];
        const idx = idxRelatorio.has(chave) ? idxRelatorio.get(chave) : -1;
        if (idx >= 0 && !diaCorrente) continue; /* dias passados fechados: mantém o snapshot */
        const faturamento = lista.reduce((s, a) => s + Number(a.price_total || 0), 0);
        const faixas = {};
        lista.forEach(a => {
          const h = Number(a.starts_at.slice(11, 13));
          const f = String(h).padStart(2, '0') + ':00–' + String(h + 1).padStart(2, '0') + ':00';
          faixas[f] = (faixas[f] || 0) + 1;
        });
        const top = Object.keys(faixas).sort((a, b) => faixas[b] - faixas[a])[0] || null;
        const snap = {
          id: DB.proximoId(), barbershop_id: loja.id, data: dia,
          faturamento: Math.round(faturamento * 100) / 100,
          agendamentos: lista.length,
          ticket: lista.length ? Math.round(faturamento / lista.length * 100) / 100 : null,
          faixa_pico: top,
          created_at: agoraISO()
        };
        if (idx >= 0) db.relatorios_diarios[idx] = snap;
        else db.relatorios_diarios.push(snap);
      }
    }
    DB.salvar();
    return db.relatorios_diarios.filter(r => alvos.indexOf(r.data) >= 0).length;
  }

  /* Janela imediatamente anterior ao período atual (comparação) */
  function janelaPeriodoAnterior(periodo) {
    switch (periodo) {
      case 'today': return { inicio: DB.addDiasISO(-1), fim: DB.addDiasISO(-1) };
      case 'week': return { inicio: DB.addDiasISO(-13), fim: DB.addDiasISO(-7) };
      case 'year': return { inicio: DB.addDiasISO(-729), fim: DB.addDiasISO(-365) };
      case 'month':
      default: return { inicio: DB.addDiasISO(-59), fim: DB.addDiasISO(-30) };
    }
  }

  function comparacaoPeriodos(shopId, periodo) {
    const atual = janelaPeriodo(periodo);
    const anterior = janelaPeriodoAnterior(periodo);
    const fAtual = calcularFaturamentoTotal(shopId, atual.inicio, atual.fim);
    const fAnter = calcularFaturamentoTotal(shopId, anterior.inicio, anterior.fim);
    const aAtual = contarAgendamentos(shopId, atual.inicio, atual.fim);
    const aAnter = contarAgendamentos(shopId, anterior.inicio, anterior.fim);
    const pct = (atualVal, antVal) =>
      antVal > 0 ? Math.round((atualVal - antVal) / antVal * 1000) / 10 : null;
    return {
      periodo_anterior: anterior,
      faturamento_anterior: Math.round(fAnter * 100) / 100,
      agendamentos_anterior: aAnter,
      delta_faturamento_pct: pct(fAtual, fAnter),
      delta_agendamentos_pct: pct(aAtual, aAnter)
    };
  }

  /* [SEGURANÇA] Endpoint principal: devolve SOMENTE os campos que o
     nível do plano autoriza (fail-closed no backend).
     Acumulativo: básico ⊂ intermediário ⊂ completo. */
  function gerarRelatorio(periodo) {
    const { shop, nivel } = exigirNivelRelatorio();
    const { inicio, fim } = janelaPeriodo(periodo || 'month');

    const resultado = {
      nivel, period: periodo || 'month', start_date: inicio, end_date: fim
    };

    // --- NÍVEL BÁSICO (Autônomo E Superior) ---
    const faturamento = calcularFaturamentoTotal(shop.id, inicio, fim);
    resultado.faturamento = Math.round(faturamento * 100) / 100;
    resultado.lucro = resultado.faturamento;              // lucro = faturamento (sem custos cadastrados)
    resultado.totalAgendamentos = contarAgendamentos(shop.id, inicio, fim);
    resultado.semanal = resumoSemanal(shop.id);           // resultado lucrativo da semana

    // --- NÍVEL INTERMEDIÁRIO (Salão E Superior) ---
    if (nivel === 'intermediario' || nivel === 'completo') {
      resultado.ticketMedio = resultado.totalAgendamentos > 0
        ? Math.round(faturamento / resultado.totalAgendamentos * 100) / 100
        : 0;
      resultado.melhorDia = melhorDiaDe(shop.id, inicio, fim);   // dia com mais lucro
      resultado.melhorDiaSerie = serieDias(shop.id, inicio, fim); // série do gráfico
      resultado.mensal = resumoMensal(shop.id);                   // resultado mensal
    }

    // --- NÍVEL COMPLETO (apenas Salão Pro) ---
    if (nivel === 'completo') {
      resultado.servicoMaisRealizado = servicoMaisRealizado(shop.id, inicio, fim);
      resultado.profissionalMaisRentavel = profissionalMaisRentavel(shop.id, inicio, fim);
      resultado.horariosPico = horariosPico(shop.id, inicio, fim, 5);
      resultado.comparacaoPeriodos = comparacaoPeriodos(shop.id, periodo || 'month');
      resultado.atendimentosDetalhados = atendimentosDetalhados(shop.id, inicio, fim, 200);
      resultado.exportar_csv = true;
    }

    return resultado;
  }

  /* Relatório DIÁRIO — padrão de todos os planos pagos. Usa o snapshot
     gerado às 00:00 (job) e cai para cálculo em tempo real se ainda
     não existir (ex.: servidor acaba de subir). */
  function gerarRelatorioDiario(data) {
    const { shop, nivel } = exigirNivelRelatorio();
    const dia = data || DB.hojeISO();
    const reg = DB._d().relatorios_diarios.find(r =>
      r.barbershop_id === shop.id && r.data === dia);
    if (reg) {
      return {
        data: reg.data,
        faturamento: Number(reg.faturamento || 0),
        agendamentos: reg.agendamentos || 0,
        ticket: reg.ticket != null ? Number(reg.ticket) : 0,
        faixa_pico: reg.faixa_pico || null,
        gerado_em: reg.created_at || null, nivel
      };
    }
    const lista = DB._d().appointments.filter(a =>
      a.barbershop_id === shop.id && a.status === 'concluido' &&
      a.starts_at.slice(0, 10) === dia);
    const fat = lista.reduce((s, a) => s + Number(a.price_total || 0), 0);
    const faixas = {};
    lista.forEach(a => {
      const h = Number(a.starts_at.slice(11, 13));
      const f = String(h).padStart(2, '0') + ':00–' + String(h + 1).padStart(2, '0') + ':00';
      faixas[f] = (faixas[f] || 0) + 1;
    });
    const top = Object.keys(faixas).sort((a, b) => faixas[b] - faixas[a])[0] || null;
    return {
      data: dia,
      faturamento: Math.round(fat * 100) / 100,
      agendamentos: lista.length,
      ticket: lista.length ? Math.round(fat / lista.length * 100) / 100 : 0,
      faixa_pico: top,
      gerado_em: null, nivel
    };
  }

  /* ================= BUSCA PÚBLICA (RF-050..054) ================= */

  function buscar(params) {
    params = params || {};
    const db = DB._d();
    const tipo = params.type || 'all';
    const q = String(params.q || '').toLowerCase().trim();
    const cidade = params.city ? String(params.city).toLowerCase() : '';
    const uf = params.uf ? String(params.uf).toUpperCase() : '';
    const minRating = Number(params.min_rating) || 0;
    const sort = params.sort || 'relevance';
    const limite = clampInt(params.limit, 1, 100, 20);
    const page = clampInt(params.page, 1, 9999, 1);

    function passaFiltros(l) {
      if (cidade && (l.city || '').toLowerCase() !== cidade) return false;
      if (uf && (l.uf || '').toUpperCase() !== uf) return false;
      if (minRating && ratingDeLoja(l.id).media < minRating) return false;
      return true;
    }

    function enriquecer(l) {
      const pub = lojaPublica(l);
      pub.type = 'shop';
      return pub;
    }

    let resultados = [];

    if (tipo === 'all' || tipo === 'shops') {
      let shops = db.barbershops.filter(passaFiltros);
      if (q) {
        shops = shops.filter(l =>
          l.name.toLowerCase().includes(q) ||
          (l.description || '').toLowerCase().includes(q) ||
          (l.city || '').toLowerCase().includes(q) ||
          (l.address || '').toLowerCase().includes(q) ||
          (l.tags || []).some(t => t.toLowerCase().includes(q)));
      }
      resultados = resultados.concat(shops.map(enriquecer));
    }

    if (tipo === 'services') {
      const svcs = db.services.filter(s => s.active && q &&
        s.name.toLowerCase().includes(q));
      svcs.forEach(svc => {
        const l = db.barbershops.find(b => b.id === svc.barbershop_id);
        if (!l || !passaFiltros(l)) return;
        const pub = lojaPublica(l);
        pub.type = 'service';
        pub.matched_service = { id: svc.id, name: svc.name, price: svc.price };
        resultados.push(pub);
      });
    }

    if (tipo === 'professionals') {
      const pros = db.professionals.filter(p => p.is_active && q &&
        p.name.toLowerCase().includes(q));
      pros.forEach(p => {
        const l = db.barbershops.find(b => b.id === p.barbershop_id);
        if (!l || !passaFiltros(l)) return;
        const pub = lojaPublica(l);
        pub.type = 'professional';
        pub.matched_professional = { id: p.id, name: p.name, bio: p.bio };
        resultados.push(pub);
      });
    }

    /* dedup de lojas quando type=all */
    if (tipo === 'all') {
      const visto = new Set();
      resultados = resultados.filter(r =>
        !visto.has(r.id + ':' + r.type) && visto.add(r.id + ':' + r.type));
    }

    switch (sort) {
      case 'rating': resultados.sort((a, b) => b.rating_avg - a.rating_avg); break;
      case 'name': resultados.sort((a, b) => a.name.localeCompare(b.name)); break;
      case 'newest': resultados.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); break;
      default:
        resultados.sort((a, b) => {
          if (q) {
            const ai = a.name.toLowerCase().startsWith(q) ? 0 : 1;
            const bi = b.name.toLowerCase().startsWith(q) ? 0 : 1;
            if (ai !== bi) return ai - bi;
          }
          return b.rating_avg - a.rating_avg;
        });
    }

    const total = resultados.length;
    const items = resultados.slice((page - 1) * limite, page * limite);
    return { items, total, page, limit: limite };
  }

  /** RF-054 — autocomplete (≥2 chars): até 5 lojas + 5 serviços. */
  function sugestoes(qBruto) {
    const q = String(qBruto || '').toLowerCase().trim();
    if (q.length < 2) return { suggestions: [] };
    const db = DB._d();
    const out = [];

    db.barbershops
      .filter(l => l.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 5)
      .forEach(l => out.push({ type: 'shop', text: l.name, sub: (l.city || '') + (l.uf ? ', ' + l.uf : '') }));

    db.services
      .filter(s => s.active && s.name.toLowerCase().includes(q))
      .slice(0, 5)
      .forEach(s => {
        const l = db.barbershops.find(b => b.id === s.barbershop_id);
        if (l) out.push({ type: 'service', text: s.name, sub: l.name });
      });

    return { suggestions: out };
  }

  /* ================= AVALIAÇÕES (RF-055..056, DT-08) ================= */

  function reviewsDaLoja(shopId) {
    return DB._d().reviews
      .filter(r => r.barbershop_id == shopId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(r => ({
        id: r.id, client_name: r.client_name, rating: r.rating,
        comment: r.comment || '', created_at: r.created_at
      }));
  }

  function criarReview(shopId, dados) {
    const user = sessao(); // POST autenticado (corrige DT-08)
    const nota = parseInt(dados.rating, 10);
    if (!Number.isInteger(nota) || nota < 1 || nota > 5) {
      err(400, 'Avaliação inválida: informe uma nota de 1 a 5.');
    }
    const loja = DB._d().barbershops.find(b => b.id == shopId);
    if (!loja) err(404, 'Salão não encontrado.');
    const comment = String(dados.comment || '').trim();
    if (comment.length > 100) err(400, 'Comentário deve ter no máximo 100 caracteres.');

    /* (barbershop_id, user_id) é UNIQUE: sem esta checagem a segunda
       avaliação do mesmo salão quebra a persistência da coleção reviews */
    const jaAvaliou = DB._d().reviews.find(r =>
      r.barbershop_id == loja.id && r.user_id === user.id);
    if (jaAvaliou) err(409, 'Você já avaliou este salão.');

    /* vincula ao cliente cadastrado NESTA loja, quando houver. Sem o
       filtro, um cliente de outra loja recebia client_id apontando para o
       cadastro alheio. */
    const meuCliente = DB._d().clients.find(c =>
      c.user_id === user.id && c.barbershop_id === loja.id);

    const r = {
      id: DB.proximoId(),
      barbershop_id: loja.id,
      client_id: meuCliente ? meuCliente.id : null,
      user_id: user.id,
      client_name: user.name,
      rating: nota,
      comment: comment,
      created_at: agoraLocal()
    };
    DB._d().reviews.push(r);
    DB.salvar();
    return r;
  }

  /* ================= DENÚNCIAS E BLOQUEIOS ================= */

  const MOTIVOS_DENUNCIA = [
    'conteudo_inadequado', 'descricao_falsa', 'precos_enganosos',
    'comportamento_abusivo', 'nao_comparecimento', 'spam', 'outro'
  ];
  const TIPOS_ALVO = ['salao', 'barbeiro', 'cliente'];

  function isMembroEquipe(user) {
    return user && (user.role === 'dono' || user.role === 'barbeiro' || user.role === 'dependente');
  }

  /* Denúncia de perfil — regras por papel:
     - cliente logado         → denuncia salão OU barbeiro (página pública)
     - dono/barbeiro (equipe) → denuncia cliente (CRM) */
  function denunciarPerfil(dados) {
    dados = dados || {};
    const user = sessao(); // exige login para denunciar (evita abuso anônimo)
    const targetType = String(dados.target_type || '').toLowerCase();
    const motivo = String(dados.reason || '').toLowerCase();
    const descricao = String(dados.description || '').trim().slice(0, 2000);

    if (TIPOS_ALVO.indexOf(targetType) === -1) err(400, 'Tipo de alvo inválido.');
    if (MOTIVOS_DENUNCIA.indexOf(motivo) === -1) err(400, 'Motivo da denúncia inválido.');

    const db = DB._d();
    let targetUserId = dados.target_user_id ? String(dados.target_user_id) : null;
    let targetBarbershopId = dados.target_barbershop_id ? String(dados.target_barbershop_id) : null;
    let targetClientId = dados.target_client_id ? String(dados.target_client_id) : null;
    let targetDisplay = String(dados.target_display || '');

    /* ---------- regras por papel/alvo ---------- */
    if (targetType === 'salao') {
      if (isMembroEquipe(user)) err(403, 'Equipe do salão não pode denunciar outro salão.');
      if (!targetBarbershopId) err(400, 'Informe o salão denunciado.');
    } else if (targetType === 'barbeiro') {
      if (isMembroEquipe(user)) err(403, 'Equipe do salão não pode denunciar barbeiros.');
      if (!targetUserId) err(400, 'Informe o barbeiro denunciado.');
      // barbeiro alvo precisa pertencer a um salão (profissional ou dono)
      const prof = db.professionals.find(p => p.user_id == targetUserId);
      const dono = db.barbershops.find(b => b.owner_user_id == targetUserId);
      if (!prof && !dono) err(400, 'Barbeiro não encontrado.');
      if (!targetDisplay) targetDisplay = (prof && prof.name) || (dono && dono.name) || '';
    } else if (targetType === 'cliente') {
      if (!isMembroEquipe(user)) err(403, 'Apenas a equipe do salão pode denunciar clientes.');
      const { shop } = exigirEquipe();
      targetBarbershopId = shop.id;
      if (!targetClientId) err(400, 'Informe o cliente denunciado.');
      const c = db.clients.find(x => x.id == targetClientId && x.barbershop_id === shop.id);
      if (!c) err(404, 'Cliente não encontrado.');
      targetUserId = c.user_id || null;
      targetDisplay = c.name;
    }

    /* impede auto-denúncia (não pode denunciar a si mesmo) */
    if (targetUserId && targetUserId === user.id) err(400, 'Você não pode denunciar a si mesmo.');

    const r = {
      id: DB.proximoId(),
      reporter_user_id: user.id,
      reporter_role: user.role,
      reporter_name: user.name,
      target_type: targetType,
      target_user_id: targetUserId,
      target_barbershop_id: targetBarbershopId,
      target_client_id: targetClientId,
      target_display: targetDisplay,
      reason: motivo,
      description: descricao,
      status: 'pendente',
      status_note: null,
      created_at: agoraISO(),
      updated_at: agoraISO()
    };
    db.reports = db.reports || [];
    db.reports.push(r);
    DB.salvar();
    _auditLog(user.id, 'denunciar_perfil', { target_type: targetType, target_id: targetUserId || targetBarbershopId || targetClientId, reason: motivo });
    return { ok: true, id: r.id, status: r.status };
  }

  /* Minhas denúncias (o denunciante vê o que enviou) */
  function minhasDenuncias() {
    const user = sessao();
    return (_db().reports || [])
      .filter(r => r.reporter_user_id === user.id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(denunciaPublica);
  }

  function denunciaPublica(r) {
    return {
      id: r.id,
      target_type: r.target_type,
      target_display: r.target_display,
      reason: r.reason,
      description: r.description,
      status: r.status,
      created_at: r.created_at
    };
  }

  /* ---------- bloqueio de cliente pelo salão (barbeiro/dono) ---------- */

  function _clienteBloqueado(shopId, clientId) {
    return !!(_db().blocked_clients || []).find(b =>
      b.barbershop_id == shopId && b.client_id == clientId);
  }

  function bloquearCliente(clientId) {
    const { shop } = exigirEquipe();
    const db = DB._d();
    const c = db.clients.find(x => x.id == clientId && x.barbershop_id === shop.id);
    if (!c) err(404, 'Cliente não encontrado.');
    if (!_clienteBloqueado(shop.id, c.id)) {
      db.blocked_clients = db.blocked_clients || [];
      db.blocked_clients.push({ barbershop_id: shop.id, client_id: c.id, created_at: agoraISO() });
    }
    DB.salvar();
    _auditLog(sessao().id, 'bloquear_cliente', { client_id: c.id, client_name: c.name });
    return { ok: true, bloqueado: true };
  }

  function desbloquearCliente(clientId) {
    const { shop } = exigirEquipe();
    const db = DB._d();
    const c = db.clients.find(x => x.id == clientId && x.barbershop_id === shop.id);
    if (!c) err(404, 'Cliente não encontrado.');
    db.blocked_clients = (db.blocked_clients || []).filter(b =>
      !(b.barbershop_id == shop.id && b.client_id == c.id));
    DB.salvar();
    _auditLog(sessao().id, 'desbloquear_cliente', { client_id: c.id, client_name: c.name });
    return { ok: true, bloqueado: false };
  }

  /* inclui o status de bloqueio na ficha pública do cliente (CRM) */
  function clienteBloqueado(clientId) {
    const { shop } = exigirEquipe();
    const c = _db().clients.find(x => x.id == clientId && x.barbershop_id === shop.id);
    if (!c) err(404, 'Cliente não encontrado.');
    return { blocked: _clienteBloqueado(shop.id, c.id) };
  }

  /* ---------- super-admin: moderação de denúncias ---------- */

  function saListarDenuncias(filtros) {
    filtros = filtros || {};
    const db = _db();
    let lista = db.reports || [];
    if (filtros.status && filtros.status !== 'todos') {
      lista = lista.filter(r => r.status === filtros.status);
    }
    if (filtros.tipo && filtros.tipo !== 'todos') {
      lista = lista.filter(r => r.target_type === filtros.tipo);
    }
    return lista
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(r => {
        const alvo = db.users.find(u => u.id === r.target_user_id);
        const loja = db.barbershops.find(b => b.id === r.target_barbershop_id);
        return {
          id: r.id,
          reporter_name: r.reporter_name,
          reporter_role: r.reporter_role,
          target_type: r.target_type,
          target_display: r.target_display,
          target_user_name: alvo ? alvo.name : null,
          target_barbershop_name: loja ? loja.name : null,
          reason: r.reason,
          description: r.description,
          status: r.status,
          status_note: r.status_note,
          created_at: r.created_at
        };
      });
  }

  function saResolverDenuncia(id, dados) {
    dados = dados || {};
    const db = _db();
    const r = (db.reports || []).find(x => x.id == id);
    if (!r) err(404, 'Denúncia não encontrada.');
    const novoStatus = String(dados.status || '');
    if (novoStatus && ['pendente', 'investigando', 'resolvido', 'rejeitado'].indexOf(novoStatus) === -1) {
      err(400, 'Status inválido.');
    }
    if (novoStatus) r.status = novoStatus;
    if (dados.status_note != null) r.status_note = String(dados.status_note).trim() || null;
    r.updated_at = agoraISO();
    DB.salvar();
    return {
      id: r.id, status: r.status, status_note: r.status_note,
      target_type: r.target_type, target_display: r.target_display
    };
  }

  /* ================= ASSINATURAS E PLANOS (RF-057..061, DT-12) ================= */

  /* Vitrine pública de planos. Respeita `active`: o super-admin desmarcar
     "Ativo na vitrine" precisa esconder o plano da loja. O Free nunca
     some — é o plano base de toda loja sem assinatura. */
  function listarPlanos() {
    return DB._d().plans
      .filter(p => p.active !== false || p.is_free)
      .slice()
      .sort((a, b) => a.price_monthly - b.price_monthly)
      .map(p => ({ ...p }));
  }

  function bonusPlano(plano) {
    return plano ? {
      id: plano.id, name: plano.name, price_monthly: plano.price_monthly,
      price_annual: plano.price_annual,
      price_compare: plano.price_compare != null ? Number(plano.price_compare) : null,
      max_professionals: plano.max_professionals,
      max_dependents: plano.max_dependents,
      features: plano.features,
      permissions: plano.permissions || [], is_free: !!plano.is_free,
      nivel_relatorio: plano.nivel_relatorio || null,
      relatorios_resumo: relatoriosResumoPorNivel(plano.nivel_relatorio || null)
    } : null;
  }

  function assinaturaPublica(sub) {
    const db = DB._d();
    const hoje = DB.hojeISO();
    const plano = db.plans.find(p => p.id === (sub && sub.plan_id));
    let liberado = false;
    try {
      liberado = sub && typeof window.API.acessoLiberado === 'function'
        ? window.API.acessoLiberado(sub.barbershop_id)
        : false;
    } catch (e) { liberado = false; }
    const efetivo = (liberado && plano) ? plano
      : (modoGratuito() ? planoGratuitoPlataforma() : (planoFree() || null));
    return {
      id: sub ? sub.id : null,
      plan: bonusPlano(plano),
      plano_efetivo: bonusPlano(efetivo),
      status: sub ? sub.status : null,
      trial_ends_at: sub ? sub.trial_ends_at : null,
      current_period_end: sub ? sub.current_period_end : null,
      trial_usado: !!(sub && sub.trial_usado),
      on_trial: !!(sub && sub.status === 'trial' && sub.trial_ends_at >= hoje),
      trial_disponivel: modoTrialAtivo(),
      days_left_in_trial: (sub && sub.trial_ends_at)
        ? Math.max(0, Math.round((DB.parseISO(sub.trial_ends_at) - DB.parseISO(hoje)) / 86400000))
        : 0
    };
  }

  function minhaAssinatura() {
    const { shop } = exigirDono();
    /* Sem plano gratuito: loja sem assinatura fica com plano_efetivo
       nulo até assinar (trial, PIX ou trocarPlano criam a assinatura). */
    const sub = DB._d().subscriptions.find(s => s.barbershop_id === shop.id);
    return assinaturaPublica(sub || null);
  }

  /**
   * RF-059 — "10 dias grátis" no plano escolhido (uma única vez por loja).
   * Ao assinar, o dono entra em trial com o plano selecionado; passados os
   * 10 dias, o job de cobrança (payments.js) gera automaticamente a cobrança
   * do plano e o acesso pago fica bloqueado até a confirmação do pagamento.
   */
  function assinarComTrial(planId) {
    const { shop } = exigirDono();
    if (!modoTrialAtivo()) {
      err(403, 'A promoção de 10 dias grátis está desativada. Assine diretamente um plano para liberar o acesso.');
    }
    const db = DB._d();
    const plano = db.plans.find(p => p.id == planId);
    if (!plano) err(404, 'Plano não encontrado.');
    if (plano.is_free) err(400, 'O plano Free não pode ser contratado.');
    /* [SEGURANÇA] `plans.active` era ignorado aqui: desmarcar "Ativo na
       vitrine" no painel do super-admin não impedia contratar o plano. */
    if (plano.active === false) err(400, 'Este plano não está disponível para contratação no momento.');
    const hoje = DB.hojeISO();

    const idx = db.subscriptions.findIndex(s => s.barbershop_id === shop.id);
    const subAtual = idx >= 0 ? db.subscriptions[idx] : null;
    if (subAtual && subAtual.status === 'trial' && subAtual.trial_ends_at >= hoje) {
      err(400, 'Você já está no período de 10 dias grátis.');
    }
    if (subAtual && subAtual.trial_usado) {
      err(409, 'Os 10 dias grátis já foram utilizados. Finalize o pagamento para ativar o plano.');
    }

    const sub = {
      id: subAtual ? subAtual.id : DB.proximoId(),
      barbershop_id: shop.id, plan_id: plano.id,
      status: 'trial', trial_ends_at: DB.addDiasISO(10),
      current_period_end: null, trial_usado: true,
      created_at: subAtual ? subAtual.created_at : agoraISO(), updated_at: agoraISO()
    };
    if (idx >= 0) db.subscriptions[idx] = sub;
    else db.subscriptions.push(sub);
    DB.salvar();
    return assinaturaPublica(sub);
  }

  function ativarTrial() {
    const db = DB._d();
    const salaopro = db.plans.find(p => String(p.name || '').toLowerCase() === 'salao');
    if (!salaopro) err(500, 'Plano Salão não encontrado.');
    return assinarComTrial(salaopro.id);
  }

  /**
   * RF-060 com regra explícita da v2 (DT-12):
   * troca dentro do trial MANTÉM o prazo original; fora dele vira ativa.
   */
  function trocarPlano(planId) {
    const { shop } = exigirDono();
    const db = DB._d();
    const plano = db.plans.find(p => p.id == planId);
    if (!plano) err(404, 'Plano não encontrado.');
    if (plano.is_free) err(400, 'O plano Free não pode ser contratado.');
    if (plano.active === false) err(400, 'Este plano não está disponível para contratação no momento.');

    const sub = db.subscriptions.find(s => s.barbershop_id === shop.id);
    if (sub && sub.trial_usado === false &&
        sub.trial_ends_at && sub.trial_ends_at < hoje) {
      /* [SEGURANÇA] Selo de trial gasto herdado do provisionamento antigo
         (provisionarSalao não gravava trial_usado). Sem isto o dono podia
         renovar os 10 dias quantas vezes quizesse. */
      sub.trial_usado = true;
      DB.salvar();
    }
    const hoje = DB.hojeISO();
    const emTrial = sub && sub.status === 'trial' && sub.trial_ends_at >= hoje;
    const pago = sub && sub.status === 'ativa' && sub.current_period_end >= hoje;

    /* Sem trial usado e sem período pago: entra nos 10 dias grátis. */
    if (!emTrial && !pago && (!sub || !sub.trial_usado)) {
      return assinarComTrial(plano.id);
    }
    /* Troca dentro do trial mantém o prazo (DT-12); troca com plano pago
       apenas muda o plano já contratado, sem conceder período grátis. */
    if (emTrial || pago) {
      sub.plan_id = plano.id;
      sub.updated_at = agoraISO();
      DB.salvar();
      return assinaturaPublica(sub);
    }
    err(402, 'Finalize o pagamento da cobrança para reativar o acesso.');
  }

  function cancelarAssinatura() {
    const { shop } = exigirDono();
    const sub = DB._d().subscriptions.find(s => s.barbershop_id === shop.id);
    if (!sub) err(404, 'Nenhuma assinatura encontrada.');
    sub.status = 'cancelada';
    sub.updated_at = agoraISO();
    DB.salvar();
    return assinaturaPublica(sub);
  }

  /* ================= UPLOADS E GALERIA (RF-062..065, RNF-11) ================= */

  function definirLogo(dataUrl) {
    // [SEGURANÇA] Valida tamanho do dataUrl para evitar payloads gigantes
    if (!dataUrl || typeof dataUrl !== 'string') err(400, 'Imagem inválida.');
    if (dataUrl.length > 1024 * 1024) err(400, 'Imagem muito grande (máx. 1MB após processamento).');
    if (!dataUrl.startsWith('data:image/')) err(400, 'Formato de imagem inválido.');
    const { shop } = exigirDono();
    shop.logo_url = dataUrl;
    shop.updated_at = agoraISO();
    DB.salvar();
    localStorage.setItem('barbershop', JSON.stringify(shop));
    return { logo_url: shop.logo_url };
  }

  function definirCapa(dataUrl) {
    // [SEGURANÇA] Valida tamanho do dataUrl para evitar payloads gigantes
    if (!dataUrl || typeof dataUrl !== 'string') err(400, 'Imagem inválida.');
    if (dataUrl.length > 1024 * 1024) err(400, 'Imagem muito grande (máx. 1MB após processamento).');
    if (!dataUrl.startsWith('data:image/')) err(400, 'Formato de imagem inválido.');
    const { shop } = exigirDono();
    const db = DB._d();
    let galleryId = null;
    if (!shop.cover_url) {
      const g = {
        id: DB.proximoId(), barbershop_id: shop.id,
        url: dataUrl, sort_order: 0, created_at: agoraISO()
      };
      db.gallery_images.push(g);
      galleryId = g.id;
    }
    shop.cover_url = dataUrl;
    shop.updated_at = agoraISO();
    DB.salvar();
    localStorage.setItem('barbershop', JSON.stringify(shop));
    return { cover_url: shop.cover_url, gallery_image_id: galleryId };
  }

  function galeriaDaLoja(shopId) {
    return DB._d().gallery_images
      .filter(g => g.barbershop_id == shopId)
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id));
  }

  /** Escrita restrita ao dono — corrige DT-08. */
  function adicionarGaleria(dataUrls) {
    // [SEGURANÇA] Valida dataUrl para evitar payloads gigantes
    if (!Array.isArray(dataUrls) || !dataUrls.length) err(400, 'Imagens inválidas.');
    (Array.isArray(dataUrls) ? dataUrls : [dataUrls]).forEach((url, i) => {
      if (typeof url !== 'string' || url.length > 1024 * 1024 || !url.startsWith('data:image/')) {
        err(400, 'Imagem ' + (i + 1) + ' inválida ou muito grande.');
      }
    });
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'galeria', 'Gerenciar galeria de fotos');
    const db = DB._d();

    // [SEGURANÇA] Limite de fotos por loja para evitar abuso de armazenamento
    const LIMITE_GALERIA = 20;
    const fotosAtuais = db.gallery_images.filter(g => g.barbershop_id === shop.id);
    if (fotosAtuais.length + dataUrls.length > LIMITE_GALERIA) {
      err(400, 'Limite de ' + LIMITE_GALERIA + ' fotos por loja atingido. Remova fotos antes de adicionar.');
    }

    const criadas = (Array.isArray(dataUrls) ? dataUrls : [dataUrls]).map(url => {
      const g = {
        id: DB.proximoId(), barbershop_id: shop.id, url,
        sort_order: db.gallery_images.filter(g2 => g2.barbershop_id === shop.id).length,
        created_at: agoraISO()
      };
      db.gallery_images.push(g);
      return g;
    });
    DB.salvar();
    return criadas;
  }

  function removerGaleria(imageId) {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'galeria', 'Gerenciar galeria de fotos');
    const db = DB._d();
    const g = db.gallery_images.find(g2 => g2.id == imageId && g2.barbershop_id === shop.id);
    if (!g) err(404, 'Imagem não encontrada.');
    db.gallery_images = db.gallery_images.filter(g2 => g2.id != imageId);
    if (shop.logo_url === g.url) shop.logo_url = null;
    if (shop.cover_url === g.url) shop.cover_url = null;   // RF-064
    DB.salvar();
    localStorage.setItem('barbershop', JSON.stringify(shop));
    return { ok: true };
  }

  /* ================= NOTIFICAÇÕES (RF-066..068) ================= */

  function notificar(n) {
    const db = DB._d();
    if (!n.user_id) return;
    /* limita a 100 notificações por usuário */
    const doUser = db.notifications.filter(x => x.user_id === n.user_id);
    if (doUser.length >= 100) {
      const ids = doUser.sort((a, b) => a.created_at.localeCompare(b.created_at))
                         .slice(0, doUser.length - 99).map(x => x.id);
      db.notifications = db.notifications.filter(x => !ids.includes(x.id));
    }
    db.notifications.push({
      id: DB.proximoId(),
      barbershop_id: n.barbershop_id || null,
      user_id: n.user_id,
      type: n.type,
      title: n.title,
      message: n.message,
      data: JSON.stringify(n.extra || {}),
      read: 0,
      created_at: agoraISO()
    });
  }

  function minhasNotificacoes(opts) {
    opts = opts || {};
    const user = sessao();
    const db = DB._d();
    let lista = db.notifications.filter(n => n.user_id === user.id);
    if (opts.unreadOnly) lista = lista.filter(n => !n.read);
    lista.sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limite = clampInt(opts.limit, 1, 100, 30);
    const page = clampInt(opts.page, 1, 9999, 1);
    return {
      items: lista.slice((page - 1) * limite, page * limite),
      unread: db.notifications.filter(n => n.user_id === user.id && !n.read).length
    };
  }

  function naoLidasCount() {
    const user = sessao();
    return DB._d().notifications.filter(n => n.user_id === user.id && !n.read).length;
  }

  function marcarNotificacaoLida(id) {
    const user = sessao();
    const n = DB._d().notifications.find(x => x.id == id && x.user_id === user.id);
    if (!n) err(404, 'Notificação não encontrada.');
    n.read = 1;
    DB.salvar();
    return { ok: true };
  }

  function marcarTodasLidas() {
    const user = sessao();
    DB._d().notifications.forEach(n => { if (n.user_id === user.id) n.read = 1; });
    DB.salvar();
    return { ok: true };
  }

  /**
   * RF-068 — lembretes calculados no load do painel:
   * varre agendamentos de amanhã ainda sem lembrete.
   */
  function gerarLembretesPendentes() {
    const { shop } = exigirDono();
    exigirFuncionalidade(shop.id, 'notificacoes', 'Lembretes automáticos');
    const db = DB._d();
    const amanha = DB.addDiasISO(1);
    let criados = 0;

    db.appointments
      .filter(a => a.barbershop_id === shop.id &&
        a.starts_at.startsWith(amanha + 'T') &&
        (a.status === 'pendente' || a.status === 'confirmado'))
      .forEach(a => {
        const jaTem = n => n.type === 'reminder' &&
          n.user_id === shop.owner_user_id &&
          String(n.data || '').includes('"appointment_id":' + a.id);
        if (!db.notifications.some(jaTem) && shop.owner_user_id) {
          notificar({
            user_id: shop.owner_user_id, barbershop_id: shop.id,
            type: 'reminder', title: 'Lembrete',
            message: 'Você tem um agendamento amanhã: ' + a.client_name +
              ' às ' + a.starts_at.slice(11) + '.',
            extra: { appointment_id: a.id }
          });
          criados++;
        }
        if (a.user_id) {
          const jaTemCli = n => n.type === 'reminder' && n.user_id === a.user_id &&
            String(n.data || '').includes('"appointment_id":' + a.id);
          if (!db.notifications.some(jaTemCli)) {
            notificar({
              user_id: a.user_id, barbershop_id: shop.id,
              type: 'reminder', title: 'Lembrete',
              message: 'Você tem um agendamento amanhã (' + nomeLoja(shop.id) +
                ') às ' + a.starts_at.slice(11) + '.',
              extra: { appointment_id: a.id }
            });
            criados++;
          }
        }
      });

    if (criados) DB.salvar();
    return { reminders_created: criados };
  }

  /* ================= ME (RF-007..010) ================= */

  function mePerfil() {
    const user = sessao();
    return { user: Auth.publicUser(user), barbershop: Auth.salaoDoUsuario(user) || null };
  }

  function atualizarMe(patch) {
    const user = sessao();
    const db = DB._d();
    let mudou = false;
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) err(400, 'Nome é obrigatório.');
      if (n.length > 120) err(400, 'Nome muito longo (máximo 120 caracteres).');
      if (n !== user.name) { user.name = n; mudou = true; }
    }
    if (patch.email !== undefined) {
      const em = String(patch.email).trim().toLowerCase();
      /* vazio = remover o e-mail da conta (fluxo LGPD), não gravar "" */
      if (em) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) err(400, 'E-mail inválido.');
        const outro = db.users.find(u =>
          u.id !== user.id && String(u.email || '').toLowerCase() === em);
        /* o índice email_hash é UNIQUE: aceitar duplicata aqui poisons
           toda a coleção users na persistência (não só este usuário) */
        if (outro) err(409, 'Este e-mail já está cadastrado em outra conta.');
        if (em !== String(user.email || '').toLowerCase()) { user.email = em; mudou = true; }
      } else if (user.email) {
        user.email = null; mudou = true;
      }
    }
    if (patch.phone !== undefined) {
      const tel = normalizarTelefone(patch.phone);
      if (tel) {
        if (tel.length < 10) err(400, 'Telefone inválido: mínimo de 10 dígitos.');
        if (tel.length > 13) err(400, 'Telefone inválido: máximo de 13 dígitos (com DDI).');
        const outro = db.users.find(u => u.id !== user.id && normalizarTelefone(u.phone) === tel);
        if (outro) err(409, 'Este telefone já está cadastrado.');
        if (tel !== user.phone) { user.phone = tel; mudou = true; }
      } else if (user.phone) {
        user.phone = null; mudou = true;
      }
    }
    /* Troca de senha (RF-010/RF-045). Só conta Dependente tem senha —
       dono e cliente entram por código/magic link. */
    let senhaTrocada = false;
    if (patch.senha !== undefined || patch.senha_atual !== undefined) {
      senhaTrocada = trocarSenhaDaConta(user, patch);
      mudou = true;
    }

    if (!mudou) return Auth.publicUser(user);
    /* rastro LGPD: a tela de segurança mostra "alterar_dados" e sem esta
       entrada a aba ficava permanentemente sem esse registro.
       _auditLog já chama DB.salvar() — não salvar duas vezes. */
    _auditLog(user.id, senhaTrocada ? 'alterar_senha' : 'alterar_dados', {
      campos: senhaTrocada
        ? ['senha']
        : Object.keys(patch || {}).filter(k => ['name', 'email', 'phone'].indexOf(k) !== -1)
    });
    localStorage.setItem('user', JSON.stringify(Auth.publicUser(user)));
    return Auth.publicUser(user);
  }

  /* Regras de senha: 8+ caracteres com letra e número. 6 caracteres sem
     complexidade é curto demais para uma conta que dá acesso à agenda e
     aos dados dos clientes da empresa. */
  function validarForcaSenha(senha) {
    const s = String(senha == null ? '' : senha);
    if (s.length < 8) err(400, 'A senha deve ter no mínimo 8 caracteres.');
    if (s.length > 200) err(400, 'Senha muito longa (máximo 200 caracteres).');
    if (!/[A-Za-z]/.test(s)) err(400, 'A senha deve conter ao menos uma letra.');
    if (!/[0-9]/.test(s)) err(400, 'A senha deve conter ao menos um número.');
    return s;
  }

  /** Troca a senha da conta dependente. Exige a senha atual: sem isso,
      quem herdar um dispositivo com sessão aberta troca a senha sem saber
      a original. Dono/cliente não têm senha — sinaliza com 400. */
  function trocarSenhaDaConta(user, patch) {
    if (user.role !== 'dependente') {
      err(400, 'Sua conta não usa senha — o acesso é por código enviado ao e-mail.');
    }
    const atual = String(patch.senha_atual == null ? '' : patch.senha_atual);
    const nova = validarForcaSenha(patch.senha);
    /* primeira senha (conta recém-criada sem hash) não exige a atual */
    if (user.password_hash && !Auth.verificarSenha(atual, user.password_hash)) {
      err(401, 'Senha atual incorreta.');
    }
    if (atual && nova === atual) {
      err(400, 'A nova senha deve ser diferente da atual.');
    }
    user.password_hash = Auth.hashSenha(nova);
    user.senha_trocada_em = agoraISO();
    DB.salvar();
    /* [SEGURANÇA] Senha trocada invalida as outras sessões: quem tinha a
       senha antiga não continua autenticado em outro dispositivo. */
    try {
      db.sessions = (DB._d().sessions || []).filter(s => s.user_id !== user.id);
      DB.salvar();
    } catch (e) { /* sem coleção de sessões: segue o fluxo normal */ }
    return true;
  }

  function atualizarPreferencias(prefs) {
    const user = sessao();
    user.prefs = Object.assign({}, user.prefs || {}, prefs || {});
    DB.salvar();
    localStorage.setItem('user', JSON.stringify(Auth.publicUser(user)));
    return user.prefs;
  }

  /** RF-010 — exclusão de conta com cascata completa.
      Exclusão é irreversível, então exigimos uma prova de posse. O e-mail
      é a via padrão; sem ele (LGPD permite remover o e-mail da conta),
      aceitamos a senha OU os últimos 4 dígitos do telefone — senão a
      conta ficava sem caminho nenhum para se apagar. */
  function gerarCodigoExclusao(dados) {
    dados = dados || {};
    const user = sessao();
    const emailOk = !!(user.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(user.email)));
    const temSenha = !!(user.password_hash && Auth.verificarSenha(
      String(dados.senha || ''), user.password_hash));
    const tel = normalizarTelefone(user.phone);
    const ultimos4 = String(dados.telefone || '').replace(/\D/g, '').slice(-4);
    const telOk = !!(tel && tel.length >= 4 && ultimos4.length === 4 && ultimos4 === tel.slice(-4));

    /* Sem e-mail válido, a senha ou o telefone viram a prova de posse.
       Sem nenhum dos três não há como confirmar — e sem confirmar, não há
       como excluir. */
    if (!emailOk && !temSenha && !telOk) {
      err(400, 'Confirme sua identidade para excluir a conta: informe a senha da conta ' +
        'ou os últimos 4 dígitos do telefone cadastrado.');
    }

    const db = DB._d();
    const code = String(Math.floor(1000 + Math.random() * 9000));
    db._delete_codes = (db._delete_codes || []).filter(c => c.user_id !== user.id);
    db._delete_codes.push({ user_id: user.id, code: code, attempts: 0, expires_at: Date.now() + 300000 });
    DB.salvar();

    let enviado = false;
    if (emailOk) {
      try {
        const p = Mailer.enviarCodigoExclusao(String(user.email), code);
        if (p && typeof p.then === 'function') p.then(function () { enviado = true; }).catch(function () {});
        else enviado = true;
      } catch (e) { console.error('[exclusao] e-mail indisponivel:', e && e.message); }
    }

    const mascarado = emailOk
      ? String(user.email).replace(/^(.)(.*)(@.*)$/, (m, a, b, d) => a + '****' + d)
      : null;

    /* Devolve o código quando não há para onde enviá-lo. Só acontece depois
       que a identidade já foi provada por senha/telefone, então exibir não
       abre brecha — é o que permite a conta sem e-mail se excluir. */
    const mostrarCodigo = !enviado;
    return {
      ok: true,
      hint: enviado
        ? 'Código enviado para ' + mascarado + '. Use nos próximos 5 minutos.'
        : 'Confirme o código abaixo para concluir a exclusão (válido por 5 minutos).',
      codigo: mostrarCodigo ? code : undefined
    };
  }

  function confirmarExclusao(code) {
    const user = sessao();
    const db = DB._d();
    const codes = (db._delete_codes || []).filter(c => c.user_id === user.id);
    const match = codes.find(c => c.code === code && Date.now() < c.expires_at);
    if (!match) {
      codes.forEach(c => { c.attempts = (c.attempts || 0) + 1; });
      const alvo = codes.find(c => c.attempts >= 5);
      if (alvo) db._delete_codes = db._delete_codes.filter(c => c !== alvo);
      DB.salvar();
      err(400, 'Código inválido ou expirado. Solicite um novo.');
    }
    db._delete_codes = db._delete_codes.filter(c => c.user_id !== user.id);
    DB.salvar();
    return excluirMinhaConta();
  }

  /** RF-010 — exclusão de conta com cascata completa (LGPD). */
  function excluirMinhaConta() {
    var user = sessao();
    var d = DB._d();
    _auditLog(user.id, 'excluir_conta');

    if (user.role === 'dono') {
      var loja = Auth.salaoDoUsuario(user);
      if (loja) deletarLojaCascade(loja);
    }

    /* cancelar agendamentos FUTUROS do cliente.
       O agendamento não tem campo `date`: a data vive em starts_at
       (YYYY-MM-DDTHH:MM). Comparar a.date nunca era verdadeiro, então a
       exclusão de conta deixava consultas futuras ativas.
       A comparação é com agora (mesmo fuso/ formato dos registros), e não
       com "hoje inteiro": um atendimento que já ocorreu hoje não deve ser
       marcado como cancelado. */
    var agora = DB.hojeISO() + 'T' + DB.minToHHMM(DB.agoraMinutos());
    (d.appointments || []).forEach(function(a) {
      if ((a.user_id === user.id || (d.clients || []).some(function(c) { return c.id === a.client_id && c.user_id === user.id; }))
          && String(a.starts_at || '') >= agora && a.status !== 'cancelado') {
        a.status = 'cancelado';
        a.cancelled_by = 'sistema';
        a.cancel_reason = 'Exclusão de conta (LGPD)';
      }
    });

    /* remover sessões, notificações, favoritos, magic tokens */
    d.sessions = (d.sessions || []).filter(function(s) { return s.user_id !== user.id; });
    d.notifications = (d.notifications || []).filter(function(n) { return n.user_id !== user.id; });
    d.favorites = (d.favorites || []).filter(function(f) { return f.user_id !== user.id; });
    d.magic_tokens = (d.magic_tokens || []).filter(function(t) { return t.user_id !== user.id; });

    /* anonimizar dados pessoais (mantém id, role, created_at) */
    user.name = '[REMOVIDO]';
    user.email = null;
    user.phone = null;
    user.prefs = null;
    user.consentimentos = null;
    user._removed_at = new Date().toISOString();
    user._removal_log = 'Conta excluída em ' + new Date().toISOString() + ' (LGPD)';

    DB.salvar();
    Auth.logout();
    return { ok: true, message: 'Conta excluída. Dados pessoais anonimizados conforme LGPD.' };
  }

  /* ================= FAVORITOS (UC-15 · DECISÃO v2: implementar) ================= */

  function alternarFavorito(shopId) {
    const user = sessao();
    const db = DB._d();
    if (!db.barbershops.some(b => b.id == shopId)) err(404, 'Salão não encontrado.');
    const existente = db.favorites.find(f => f.user_id === user.id && f.barbershop_id == shopId);
    if (existente) {
      db.favorites = db.favorites.filter(f => f.id !== existente.id);
      DB.salvar();
      return { favorito: false };
    }
    db.favorites.push({
      id: DB.proximoId(), user_id: user.id,
      barbershop_id: shopId, created_at: agoraISO()
    });
    DB.salvar();
    return { favorito: true };
  }

  function meusFavoritos() {
    const user = sessao();
    const db = DB._d();
    return db.favorites
      .filter(f => f.user_id === user.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(f => {
        const l = db.barbershops.find(b => b.id === f.barbershop_id);
        return l ? lojaPublica(l) : null;
      })
      .filter(Boolean);
  }

  /* ================= SUPORTE (página extra mantida) ================= */

  function criarTicket(salaoId, assunto, mensagem) {
    /* [SEGURANÇA] Só o dono pode abrir chamado e apenas para o PRÓPRIO
       salão — o salaoId do cliente é validado contra o salão da sessão
       (evita abrir chamado em nome de outra loja). */
    const { user, shop } = exigirDono();
    if (salaoId != null && String(salaoId) !== String(shop.id)) {
      err(403, 'Você só pode abrir chamado para o seu próprio salão.');
    }
    const texto = String(mensagem || '').trim();
    if (!texto) err(400, 'Escreva sua mensagem.');
    const t = {
      id: DB.proximoId(),
      salao_id: String(shop.id),
      user_id: user.id,
      subject: String(assunto || 'Outro').slice(0, 120),
      message: texto,
      status: 'aberto',
      created_at: agoraISO(),
      updated_at: agoraISO()
    };
    DB._d().tickets.push(t);
    DB.salvar();
    return t;
  }

  function ticketsDoSalao(salaoId) {
    /* [SEGURANÇA] Isolamento por loja: o dono só lê os chamados do seu
       próprio salão, independentemente do salaoId informado. */
    const { shop } = exigirDono();
    if (salaoId != null && String(salaoId) !== String(shop.id)) {
      err(403, 'Acesso restrito aos chamados do seu salão.');
    }
    return DB._d().tickets.filter(t => t.salao_id == shop.id).slice().reverse();
  }

  function nomeLoja(id) {
    const l = DB._d().barbershops.find(b => b.id == id);
    return l ? l.name : '';
  }

  /* Catálogo público: serviços ativos (alimenta filtros do catálogo). */
  function servicosPublicos() {
    return DB._d().services.filter(s => s.active)
      .map(s => ({ id: s.id, name: s.name }));
  }

  /* Avaliações do usuário logado (contador do perfil). */
  function minhasReviews() {
    const user = sessao();
    return DB._d().reviews.filter(r => r.user_id === user.id);
  }

  /* ================= REEMBOLSOS (CDC art. 49 · 7 dias) =================
     Ciclo de vida do pedido:
       PENDENTE_GMAIL → criado no envio do relatório pelo site.
                        OCULTO na lista do Super Admin (a listagem
                        filtra status = 'EM_ANALISE', então este
                        status nunca casa — o default
                        visible_to_admin = TRUE permanece honesto).
       EM_ANALISE     → o barbeiro confirmou o envio pelo Gmail
                        (confirmarEnvioGmail). Vira visível ao
                        Super Admin.
       REEMBOLSADO    → o Super Admin marcou "Realizado". Dispara
                        a notificação de sucesso ao barbeiro.
     ============================================================ */

  const REEMBOLSO_DIAS = 7;
  const REEMBOLSO_EMAIL = () =>
    String(process.env.REEMBOLSO_EMAIL || process.env.GMAIL_USER || 'suporte@cortecomigo.com.br').trim();

  /**
   * Chave Pix temporária/aleatória (EVP) OBRIGATÓRIA.
   * CPF é estritamente bloqueado — a checagem vem ANTES da do formato
   * para que um CPF sempre receba a mensagem específica (e nunca a
   * genérica de UUID). O regex de 11 dígitos seguidos cobre também o
   * CPF colado no meio de um texto ou com espaços, que escapariam dos
   * dois padrões ancorados.
   */
  function validarChavePix(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s) err(400, 'Informe a chave Pix temporária/aleatória para receber o reembolso.');
    /* Detecção de CPF: SOMENTE as formas de CPF (11 dígitos, com ou sem
       máscara/espaços). Não usa \d{11,} porque o último grupo de uma EVP
       válida tem 12 caracteres hex e pode ser 100% numérico — esse regex
       rejeitaria chaves Pix legítimas. */
    const soDigitos = s.replace(/[.\-\s]/g, '');
    const pareceCpf = /^\d{11}$/.test(s)
      || /^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(s)
      || (/^[\d.\-\s]+$/.test(s) && soDigitos.length === 11);
    if (pareceCpf) {
      err(400, 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
      err(400, 'Informe uma chave Pix temporária/aleatória (EVP) no formato UUID.');
    }
    return s.toLowerCase();
  }

  /* Predicado único de visibilidade para o Super Admin.
     `visible_to_admin` chega como boolean (memória/PostgreSQL) ou como
     0/1 (JSON cru); comparar com `=== 0` deixava passar a linha oculta. */
  function _reembolsoVisivelAoAdmin(r) {
    return !(r.visible_to_admin === false || r.visible_to_admin === 0
      || r.visible_to_admin === '0' || r.visible_to_admin === 'false'
      || r.visible_to_admin === null || r.visible_to_admin === undefined);
  }

  /* Data-base do prazo: o pagamento pago e NÃO estornado mais recente.
     Espelha backend/payments.js (estornarArrependimento), que já
     aplica os 7 dias do CDC art. 49 sobre `payments.paid_at`.
     Fallback: subscriptions.created_at (loja ainda sem cobrança). */
  function basePrazoReembolso(shopId) {
    const db = DB._d();
    const pagos = (db.payments || [])
      .filter(p => p.barbershop_id === shopId && p.status === 'paid' && !p.refunded_at && p.paid_at)
      .map(p => Date.parse(p.paid_at))
      .filter(ms => !isNaN(ms))
      .sort((a, b) => b - a);
    if (pagos.length) return pagos[0];
    const sub = (db.subscriptions || []).find(s => s.barbershop_id === shopId);
    if (sub && sub.created_at) {
      const ms = Date.parse(sub.created_at);
      if (!isNaN(ms)) return ms;
    }
    return null;
  }

  /**
   * Trava de 7 dias — calculada SEMPRE no servidor. A interface apenas
   * renderiza o resultado: ela não é fronteira de segurança.
   * Sem data-base (loja que nunca pagou) a resposta é fail-closed
   * (prazo encerrado), no mesmo espírito do boot de DB_ENCRYPT_KEY.
   */
  function prazoReembolso(shopId) {
    const baseMs = basePrazoReembolso(shopId);
    if (baseMs == null) {
      return {
        dentro_do_prazo: false, dias_restantes: 0, dias_limite: REEMBOLSO_DIAS,
        base_em: null, limite_em: null, email_contato: REEMBOLSO_EMAIL()
      };
    }
    const limiteMs = baseMs + REEMBOLSO_DIAS * 24 * 60 * 60 * 1000;
    const restante = limiteMs - Date.now();
    const diasRestantes = Math.max(0, Math.floor(restante / (24 * 60 * 60 * 1000)));
    return {
      dentro_do_prazo: restante >= 0,
      dias_restantes: diasRestantes,
      dias_limite: REEMBOLSO_DIAS,
      base_em: new Date(baseMs).toISOString(),
      limite_em: new Date(limiteMs).toISOString(),
      email_contato: REEMBOLSO_EMAIL()
    };
  }

  function reembolsoPublico(r) {
    return {
      id: r.id, user_id: r.user_id, barbershop_id: r.barbershop_id || null,
      temporary_pix_key: r.temporary_pix_key, reason: r.reason,
      status: r.status,
      created_at: r.created_at, updated_at: r.updated_at
    };
  }

  /* Situação da trava + último pedido em aberto (alimenta a tela do
     barbeiro sem recalcular data no cliente). */
  function reembolsoDisponivel() {
    const { user, shop } = exigirDono();
    const prazo = prazoReembolso(shop.id);
    const meus = (DB._d().reembolsos || []).filter(r => r.user_id === user.id);
    const aberto = meus
      .filter(r => r.status !== 'REEMBOLSADO')
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] || null;
    return Object.assign({}, prazo, {
      user_id: user.id,
      barbershop_id: shop.id,
      pedido_aberto: aberto ? reembolsoPublico(aberto) : null
    });
  }

  function solicitarReembolso(dados) {
    dados = dados || {};
    const { user, shop } = exigirDono();
    /* [SEGURANÇA] A trava de 7 dias é reavaliada AQUI (e não só na
       interface): o cliente pode chamar a API diretamente. */
    const prazo = prazoReembolso(shop.id);
    if (!prazo.dentro_do_prazo) {
      err(409, 'Tempo excedido para a realização do reembolso. O prazo limite para solicitação é de até 7 dias após a compra.');
    }
    const chave = validarChavePix(dados.temporary_pix_key);
    const motivo = String(dados.reason == null ? '' : dados.reason).trim();
    if (motivo.length < 10) err(400, 'Descreva o motivo do reembolso com pelo menos 10 caracteres.');
    if (motivo.length > 2000) err(400, 'O motivo do reembolso deve ter no máximo 2000 caracteres.');

    const db = DB._d();
    db.reembolsos = db.reembolsos || [];
    /* Um pedido aberto por vez: evita duplicidade quando o barbeiro
       clica em "Enviar" duas vezes. O REEMBOLSADO fecha o ciclo e
       libera um novo pedido. */
    const jaAberto = db.reembolsos.some(r =>
      r.user_id === user.id && r.status !== 'REEMBOLSADO' && r.visible_to_admin !== 0);
    if (jaAberto) err(409, 'Você já tem uma solicitação de reembolso em andamento.');

    const r = {
      id: DB.proximoId(),
      user_id: user.id,
      barbershop_id: shop.id,
      temporary_pix_key: chave,
      reason: motivo,
      status: 'PENDENTE_GMAIL',
      visible_to_admin: true,
      created_at: agoraISO(),
      updated_at: agoraISO()
    };
    db.reembolsos.push(r);
    DB.salvar();

    // Notificar super-admin por e-mail sobre nova solicitação
    try {
      const Mailer = require('./mailer');
      const plano = (db.plans || []).find(p => {
        const sub = (db.subscriptions || []).find(s => s.barbershop_id === shop.id);
        return sub && p.id === sub.plan_id;
      });
      Mailer.enviarNotificacaoReembolsoAdmin({
        usuario_nome: user.name,
        loja_nome: shop.name,
        plano_nome: plano ? plano.name : '—',
        plano_valor: plano ? plano.price_monthly : 0,
        chave_pix: chave,
        motivo: motivo
      }).catch(e => console.error('[api][reembolso] falha ao notificar admin:', e));
    } catch (e) { console.error('[api][reembolso] mailer indisponível:', e); }

    return reembolsoPublico(r);
  }

  /* Isolamento por usuário (o id do cliente NÃO é confiável) — mesmo
     padrão de ticketsDoSalao. */
  function meusReembolsos() {
    const { user } = exigirDono();
    return (DB._d().reembolsos || [])
      .filter(r => r.user_id === user.id)
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(reembolsoPublico);
  }

  /* Confirmação do barbeiro de que o relatório foi enviado pelo Gmail:
     PENDENTE_GMAIL → EM_ANALISE (passa a ser visível ao Super Admin). */
  function confirmarEnvioGmail(id) {
    const { user } = exigirDono();
    const r = (DB._d().reembolsos || []).find(x => x.id == id && x.user_id === user.id);
    if (!r) err(404, 'Solicitação de reembolso não encontrada.');
    if (r.status === 'REEMBOLSADO') {
      err(409, 'Este reembolso já foi concluído.');
    }
    if (r.status === 'PENDENTE_GMAIL') {
      r.status = 'EM_ANALISE';
      r.visible_to_admin = true;
      r.updated_at = agoraISO();
      DB.salvar();
    }
    return reembolsoPublico(r);
  }

  /* ---------- super-admin: pedidos de reembolso ---------- */

  function saListarReembolsos(filtros) {
    filtros = filtros || {};
    const db = _db();
    let lista = (db.reembolsos || [])
      .filter(r => _reembolsoVisivelAoAdmin(r))
      /* PENDENTE_GMAIL NUNCA aparece para o Super Admin: o barbeiro ainda
         não confirmou o envio do e-mail. A solicitação só entra na fila
         quando ele clica em "Já enviei o e-mail" (-> EM_ANALISE). */
      .filter(r => r.status !== 'PENDENTE_GMAIL');
    if (filtros.status && filtros.status !== 'todos') {
      lista = lista.filter(r => r.status === filtros.status);
    }
    return lista
      .slice()
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
      .map(r => {
        const u = (db.users || []).find(x => x.id === r.user_id);
        const loja = (db.barbershops || []).find(b => b.id === r.barbershop_id);
        const sub = (db.subscriptions || []).find(s => s.barbershop_id === r.barbershop_id);
        const plano = sub ? (db.plans || []).find(p => p.id === sub.plan_id) : null;
        return {
          id: r.id,
          status: r.status,
          usuario_nome: u ? u.name : '—',
          usuario_email: u ? u.email : '',
          usuario_telefone: u ? (u.phone || '') : '',
          loja_nome: loja ? loja.name : '',
          loja_cidade: loja ? (loja.city || '') : '',
          plano_nome: plano ? plano.name : '—',
          plano_valor_mensal: plano ? plano.price_monthly : 0,
          temporary_pix_key: r.temporary_pix_key,
          motivo: r.reason,
          criadoEm: r.created_at,
          atualizadoEm: r.updated_at
        };
      });
  }

  function saMarcarReembolsoRealizado(id) {
    const db = _db();
    const r = (db.reembolsos || []).find(x => x.id == id);
    if (!r) err(404, 'Pedido de reembolso não encontrado.');
    if (!_reembolsoVisivelAoAdmin(r)) err(404, 'Pedido de reembolso não encontrado.');
    if (r.status === 'REEMBOLSADO') {
      return { id: r.id, status: r.status, notificacao: false };
    }
    r.status = 'REEMBOLSADO';
    r.updated_at = agoraISO();
    /* GATILHO DE NOTIFICAÇÃO — avisa o barbeiro que o PIX saiu.
       notificar() não persiste sozinho: o DB.salvar() abaixo
       grava o pedido E a notificação no mesmo ciclo. */
    notificar({
      user_id: r.user_id,
      barbershop_id: r.barbershop_id,
      type: 'reembolso',
      title: 'Reembolso realizado',
      message: 'Seu reembolso foi realizado com sucesso! O valor foi transferido para a chave Pix cadastrada.',
      extra: { reimbursement_id: r.id }
    });
    DB.salvar();
    return { id: r.id, status: r.status, notificacao: true };
  }

  /* Soft delete de VISUALIZAÇÃO: apenas visible_to_admin = false.
     É estritamente proibido apagar a linha (DELETE FROM) — o histórico
     do pedido e a trilha de auditoria precisam ser preservados. */
  function saOcultarReembolso(id) {
    const r = (_db().reembolsos || []).find(x => x.id == id);
    if (!r) err(404, 'Pedido de reembolso não encontrado.');
    r.visible_to_admin = false;
    r.updated_at = agoraISO();
    DB.salvar();
    return { id: r.id, visible_to_admin: false };
  }

  /* ================= SUPER-ADMIN: SAÚDE DO SISTEMA (Situação) ================= */

  function classificarProblema(metrica, valor, thresholds) {
    if (valor >= thresholds.emergencia) return 'emergencia';
    if (valor >= thresholds.problema) return 'problema';
    if (valor >= thresholds.resolver) return 'resolver';
    return 'leve';
  }

  function saSituacao() {
    const db = _db();
    const agora = Date.now();
    const umDiaMs = 24 * 60 * 60 * 1000;
    const umaHoraMs = 60 * 60 * 1000;

    // Métricas de saúde
    const metricas = [];

    // 1. Memória do processo (Node.js)
    const mem = process.memoryUsage();
    const memUsageMB = Math.round(mem.heapUsed / 1024 / 1024);
    const memLimitMB = Math.round(mem.heapTotal / 1024 / 1024);
    const memPct = memLimitMB > 0 ? Math.round((memUsageMB / memLimitMB) * 100) : 0;
    metricas.push({
      nome: 'Memória (Heap)',
      valor: memPct,
      unidade: '%',
      descricao: `${memUsageMB} MB / ${memLimitMB} MB`,
      classificacao: classificarProblema('memoria', memPct, { resolver: 60, problema: 75, emergencia: 90 })
    });

    // 2. Pool de conexões PostgreSQL
    const pool = require('./pool').knex;
    const poolStats = {
      used: pool.client.pool ? pool.client.pool.numUsed() : 0,
      free: pool.client.pool ? pool.client.pool.numFree() : 0,
      pending: pool.client.pool ? pool.client.pool.numPendingAcquires() : 0,
      max: 10
    };
    const poolPct = poolStats.max > 0 ? Math.round((poolStats.used / poolStats.max) * 100) : 0;
    metricas.push({
      nome: 'Pool PostgreSQL',
      valor: poolPct,
      unidade: '%',
      descricao: `${poolStats.used}/${poolStats.max} conexões (${poolStats.pending} aguardando)`,
      classificacao: classificarProblema('pool', poolPct, { resolver: 50, problema: 70, emergencia: 85 })
    });

    // 3. Taxa de erro nas últimas 24h (audit_log)
    const logs24h = (db.audit_log || []).filter(l => Date.parse(l.timestamp) > agora - umDiaMs);
    const erros24h = logs24h.filter(l => l.acao && String(l.acao).startsWith('erro_')).length;
    const totalLogs24h = logs24h.length;
    const erroRate = totalLogs24h > 0 ? Math.round((erros24h / totalLogs24h) * 10000) / 100 : 0;
    metricas.push({
      nome: 'Taxa de Erro (24h)',
      valor: erroRate,
      unidade: '%',
      descricao: `${erros24h} erros em ${totalLogs24h} operações`,
      classificacao: classificarProblema('erros', erroRate, { resolver: 1, problema: 3, emergencia: 5 })
    });

    // 4. Assinaturas expiradas/trial vencido não renovadas
    const subsExpiradas = (db.subscriptions || []).filter(s => s.status === 'expirada' || (s.status === 'trial' && s.trial_ends_at && Date.parse(s.trial_ends_at) < agora)).length;
    metricas.push({
      nome: 'Assinaturas Expiradas',
      valor: subsExpiradas,
      unidade: 'lojas',
      descricao: `${subsExpiradas} lojas sem acesso ativo`,
      classificacao: classificarProblema('expiradas', subsExpiradas, { resolver: 5, problema: 15, emergencia: 30 })
    });

    // 5. Pagamentos pendentes há mais de 1h
    const pagamentosPendentes = (db.payments || []).filter(p => p.status === 'pending' && p.created_at && Date.parse(p.created_at) < agora - umaHoraMs).length;
    metricas.push({
      nome: 'Pagamentos Pendentes (>1h)',
      valor: pagamentosPendentes,
      unidade: 'pagamentos',
      descricao: `${pagamentosPendentes} pagamentos não confirmados`,
      classificacao: classificarProblema('pendentes', pagamentosPendentes, { resolver: 3, problema: 10, emergencia: 20 })
    });

    // 6. Reembolsos em análise há mais de 24h
    const reembolsosAtrasados = (db.reembolsos || []).filter(r => r.status === 'EM_ANALISE' && r.created_at && Date.parse(r.created_at) < agora - umDiaMs).length;
    metricas.push({
      nome: 'Reembolsos Atrasados (>24h)',
      valor: reembolsosAtrasados,
      unidade: 'pedidos',
      descricao: `${reembolsosAtrasados} pedidos sem resposta do admin`,
      classificacao: classificarProblema('reembolsos_atraso', reembolsosAtrasados, { resolver: 2, problema: 5, emergencia: 10 })
    });

    // 7. Tickets abertos sem resposta há mais de 24h
    const ticketsAtrasados = (db.tickets || []).filter(t => t.status === 'aberto' && t.created_at && Date.parse(t.created_at) < agora - umDiaMs).length;
    metricas.push({
      nome: 'Tickets Atrasados (>24h)',
      valor: ticketsAtrasados,
      unidade: 'tickets',
      descricao: `${ticketsAtrasados} tickets sem resposta`,
      classificacao: classificarProblema('tickets_atraso', ticketsAtrasados, { resolver: 3, problema: 8, emergencia: 15 })
    });

    // Classificação geral do sistema
    const piorClassificacao = ['emergencia', 'problema', 'resolver', 'leve'].find(c => metricas.some(m => m.classificacao === c)) || 'leve';

    return {
      status_geral: piorClassificacao,
      timestamp: new Date().toISOString(),
      metricas,
      resumo: {
        total_lojas: (db.barbershops || []).length,
        lojas_ativas: (db.subscriptions || []).filter(s => s.status === 'ativa').length,
        lojas_trial: (db.subscriptions || []).filter(s => s.status === 'trial').length,
        lojas_expiradas: (db.subscriptions || []).filter(s => s.status === 'expirada').length,
        usuarios_totais: (db.users || []).length,
        agendamentos_hoje: (db.appointments || []).filter(a => a.date === agoraISO().slice(0, 10)).length,
        receita_mes_atual: (db.payments || []).filter(p => p.status === 'paid' && p.paid_at && String(p.paid_at).startsWith(agoraISO().slice(0, 7))).reduce((s, p) => s + (Number(p.amount_cents) || 0) / 100, 0)
      }
    };
  }

  /* ================= SUPER-ADMIN: LOGS DE ERRO ================= */
  function saLogs(tipo, horas) {
    const db = _db();
    const corte = Date.now() - (horas * 60 * 60 * 1000);
    let logs = (db.audit_log || []).filter(l => l.timestamp && Date.parse(l.timestamp) > corte);
    if (tipo === 'erro') {
      logs = logs.filter(l => l.acao && String(l.acao).startsWith('erro_'));
    }
    return logs
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, 200)
      .map(l => ({
        id: l.id,
        timestamp: l.timestamp,
        acao: l.acao,
        user_id: l.user_id,
        ip: l.ip_address,
        extra: l.extra
      }));
  }

  /* ================= LGPD — Exportação de Dados ================= */


  function exportarMeusDados() {
    var user = sessao();
    var d = DB._d();
    var result = {
      dados_pessoais: {
        id: user.id,
        nome: user.name,
        email: user.email,
        telefone: user.phone,
        role: user.role,
        created_at: user.created_at,
        consentimentos: user.consentimentos || []
      },
      agendamentos: (d.appointments || []).filter(function(a) {
        return a.user_id === user.id || (d.clients || []).some(function(c) {
          return c.id === a.client_id && c.user_id === user.id;
        });
      }),
      avaliacoes: (d.reviews || []).filter(function(r) {
        return r.user_id === user.id;
      }),
      favoritos: (d.favorites || []).filter(function(f) {
        return f.user_id === user.id;
      })
    };
    if (user.role === 'dono') {
      var loja = Auth.salaoDoUsuario(user);
      if (loja) {
        result.loja = {
          id: loja.id,
          nome: loja.name,
          endereco: loja.address,
          cidade: loja.city,
          uf: loja.uf
        };
        result.servicos = (d.services || []).filter(function(s) { return s.barbershop_id === loja.id; });
        result.profissionais = (d.professionals || []).filter(function(p) { return p.barbershop_id === loja.id; });
      }
    }
    /* audit log */
    _auditLog(user.id, 'exportar_dados');
    return result;
  }

  function revogarConsentimento(tipo) {
    var user = sessao();
    var d = DB._d();
    if (!tipo) err(400, 'Tipo de consentimento obrigatório.');
    user.consentimentos = (user.consentimentos || []).map(function(c) {
      if (c.tipo === tipo && !c.revogado) {
        return { tipo: c.tipo, data: c.data, versao: c.versao, revogado: true, revogado_em: new Date().toISOString() };
      }
      return c;
    });
    _auditLog(user.id, 'revogar_consentimento', { tipo: tipo });
    DB.salvar();
    return { ok: true, consentimentos: user.consentimentos };
  }

  function solicitarExclusao(dados) {
    var email = String(dados.email || '').toLowerCase().trim();
    var motivo = String(dados.motivo || '').trim();
    if (!email) err(400, 'E-mail obrigatório.');
    var d = DB._d();
    d.tickets = d.tickets || [];
    d.tickets.push({
      id: DB.proximoId(),
      tipo: 'exclusao_lgpd',
      email: email,
      motivo: motivo,
      status: 'aberto',
      created_at: new Date().toISOString()
    });
    DB.salvar();
    return { ok: true, message: 'Solicitação registrada. Responderemos em até 15 dias úteis.' };
  }

/* Endpoint público (/lgpd): canal para exercer direito de acesso também
   de quem não tem conta. Valida e limita o tamanho dos campos para não
   virar canal de spam/abusar do e-mail do DPO.
   Rate limit: 5 req/min por IP (além do global). */
const _lgpdRate = new Map();
const LGPD_RATE_MAX = 5;
const LGPD_RATE_WINDOW = 60000;

function enviarSolicitacaoLGPD(dados) {
    const reqIp = (typeof window.__CC_REQUEST_IP === 'string') ? window.__CC_REQUEST_IP : '0.0.0.0';
    const now = Date.now();
    const rec = _lgpdRate.get(reqIp);
    if (rec && now < rec.reset && rec.count >= LGPD_RATE_MAX) {
      err(429, 'Muitas solicitações. Tente novamente em ' + Math.ceil((rec.reset - now) / 1000) + 's.');
    }
    if (!rec || now >= rec.reset) _lgpdRate.set(reqIp, { count: 1, reset: now + LGPD_RATE_WINDOW });
    else rec.count++;
    var nome = String(dados.nome || '').trim();
    var email = String(dados.email || '').trim().toLowerCase();
    var tipo = String(dados.tipo || '').trim();
    var telefone = String(dados.telefone || '').replace(/\D/g, '');
    var descricao = String(dados.descricao || '').trim();
    if (!nome || !email || !tipo || !descricao) err(400, 'Todos os campos obrigatórios devem ser preenchidos.');
    if (nome.length > 120) err(400, 'Nome muito longo (máximo 120 caracteres).');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) err(400, 'E-mail inválido.');
    if (telefone && (telefone.length < 10 || telefone.length > 13)) {
      err(400, 'Telefone inválido: use de 10 a 13 dígitos.');
    }
    if (descricao.length > 2000) err(400, 'Descrição muito longa (máximo 2000 caracteres).');
    var protocolo = 'LGPD-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2,4).toUpperCase();
    var d = DB._d();
    d.tickets = d.tickets || [];
    d.tickets.push({
      id: DB.proximoId(),
      tipo: 'lgpd_' + tipo,
      protocolo: protocolo,
      nome: nome,
      email: email,
      telefone: telefone || '',
      descricao: descricao,
      status: 'aberto',
      created_at: new Date().toISOString()
    });
    DB.salvar();
    /* enviar email para DPO */
    var dpoEmail = (typeof process !== 'undefined' && process.env && process.env.DPO_EMAIL) || 'dpo@cortecomigo.com';
    var Mailer;
    try { Mailer = require('./mailer'); } catch(e) {}
    if (Mailer && Mailer.enviarEmail) {
      /* escape dos campos: description/email vêm do formulário público */
      var _e = function (s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      };
      Mailer.enviarEmail({
        to: dpoEmail,
        subject: '[LGPD] Solicitação ' + protocolo + ' — ' + tipo,
        html: '<h2>Solicitação LGPD</h2>' +
              '<p><strong>Protocolo:</strong> ' + _e(protocolo) + '</p>' +
              '<p><strong>Nome:</strong> ' + _e(nome) + '</p>' +
              '<p><strong>E-mail:</strong> ' + _e(email) + '</p>' +
              (telefone ? '<p><strong>Telefone:</strong> ' + _e(telefone) + '</p>' : '') +
              '<p><strong>Tipo:</strong> ' + _e(tipo) + '</p>' +
              '<p><strong>Descrição:</strong></p><p>' + _e(descricao).replace(/\n/g, '<br>') + '</p>'
      }).catch(function() {});
    }
    return { ok: true, protocolo: protocolo, message: 'Solicitação registrada. Responderemos em até 15 dias úteis.' };
  }

  function logoutTodosDispositivos() {
    var user = sessao();
    _auditLog(user.id, 'logout_todos_dispositivos');
    Auth.logoutTodos(user.id);
    return { ok: true };
  }

  /* Funções internas fora do roteador RPC (usadas pelo job diário do server.js) */
  window.__CC_INTERNAL = window.__CC_INTERNAL || {};
  window.__CC_INTERNAL.gerarDiariosParaData = gerarDiariosParaData;
  window.__CC_INTERNAL.gerarLembretesAmanha = gerarLembretesAmanha;
  window.__CC_INTERNAL.notificar = notificar;

  /* ================= API pública ================= */

  return {
    err,

    // lojas
    listarLojasPublicas, getLoja, minhaLoja, atualizarLoja, excluirLoja,
    lojasProximas, ratingDeLoja, lojaPublica, registrarVisualizacao,

    // serviços
    servicosDaLoja, criarServico, atualizarServico, excluirServico, servicosPublicos,

    // profissionais
    profissionaisDaLoja, criarProfissional, atualizarProfissional,
    desativarProfissional, precoEfetivo,

    // dependentes / funcionários
    meuCodigoEmpresa, listarDependentes, criarDependente, excluirDependente,
    loginDependente, criarContaDependente, vincularDependente,
    sairDeDependente, desvincularDependente,

    // horários
    horariosDaLoja, salvarHorariosLoja, atualizarLinhaHorario,
    listarExcecoes, criarExcecao, excluirExcecao,

    // disponibilidade
    disponibilidade, profissionalParaSlot, verificarHorarioLivre,

    // agendamentos
    criarAgendamento, listarAgendamentos, atualizarAgendamento,
    excluirAgendamento, meusAgendamentos, agendamentoPublico,
    getAgendamento: id => {
      const user = sessao();
      const a = DB._d().appointments.find(x => x.id == id);
      if (!a) err(404, 'Agendamento não encontrado.');
      const lojaAg = DB._d().barbershops.find(b => b.id === a.barbershop_id);
      const ehEquipe = !!lojaAg && (
        lojaAg.owner_user_id === user.id ||
        ((user.role === 'barbeiro' || user.role === 'dependente') &&
          (Auth.salaoDoUsuario(user) || {}).id === lojaAg.id)
      );
      const ehCliente = a.user_id === user.id;
      if (!ehEquipe && !ehCliente) err(403, 'Você não tem permissão sobre este agendamento.');
      return agendamentoPublico(a);
    },

    // clientes
    listarClientes, getCliente, criarCliente, atualizarCliente, agendamentosDoCliente,

    // dashboard
    dashboardStats, exportarCSV, gerarRelatorio, gerarRelatorioDiario,

    // busca
    buscar, sugestoes,

    // reviews
    reviewsDaLoja, criarReview, minhasReviews,

    // denúncias e bloqueios
    denunciarPerfil, minhasDenuncias,
    bloquearCliente, desbloquearCliente, clienteBloqueado,

    // assinatura
    listarPlanos, minhaAssinatura, trocarPlano, cancelarAssinatura, ativarTrial,
    assinarComTrial,

    // uploads / galeria
    definirLogo, definirCapa,
    galeriaDaLoja, adicionarGaleria, removerGaleria,

    // notificações
    minhasNotificacoes, naoLidasCount, marcarNotificacaoLida,
    marcarTodasLidas, gerarLembretesPendentes,

    // me
    mePerfil, atualizarMe, atualizarPreferencias, excluirMinhaConta,

    // LGPD
    exportarMeusDados, revogarConsentimento, solicitarExclusao,
    enviarSolicitacaoLGPD, meusLogsDeAcesso, logoutTodosDispositivos,
    gerarCodigoExclusao, confirmarExclusao,
    _auditLog,

    // favoritos
    alternarFavorito, meusFavoritos,

    // suporte
    criarTicket, ticketsDoSalao,

    // reembolsos (CDC art. 49)
    reembolsoDisponivel, solicitarReembolso, meusReembolsos, confirmarEnvioGmail,

    // magic link / lembretes
    verificarMagicLink, gerarLembretesAmanha,

    // plataforma / assinatura (só o flag público; setters são internos)
    modoGratuito,
    /* Plumbing interno entre módulos (payments.js precisa do plano
       efetivo para cobrar price_per_employee). Não é usado pelo frontend. */
    planoEfetivo,

    // super-admin
    superAdminLogin, superAdminAuth, superAdminLogout,
    saListarLojas, saListarUsuarios, saDetalheLoja,
    saAtualizarPlano, saExcluirLoja, saDashboard, saRelatorios,
    saSituacao, saLogs,
    saTickets, saResponderTicket,
    saListarReembolsos, saMarcarReembolsoRealizado, saOcultarReembolso,
    saListarDenuncias, saResolverDenuncia,
    saListarPlanos, saAtualizarPrecosPlano, saCriarPlano, saEditarPlano, saExcluirPlano,
    saObterConfig, saDefinirSiteGratis, saDefinirTrial
  };
})();
