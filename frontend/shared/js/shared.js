/* ============================================================
   Corte Comigo – shared.js
   Toast, Modais, Tema claro/escuro, Sessão (Auth), navegação
   pública, sino de notificações e formatadores compartilhados.
   Requer db.js, auth.js e local-api.js carregados antes.
   ============================================================ */

/* ---------------- TOAST (seguro, sem innerHTML do texto) ---------------- */

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;

  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('width', '16');
  icon.setAttribute('height', '16');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('fill', 'none');
  icon.setAttribute('stroke', 'currentColor');
  icon.setAttribute('stroke-width', '2.2');
  icon.innerHTML = type === 'success'
    ? '<path d="M20 6L9 17l-5-5"/>'
    : '<circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/>';

  const span = document.createElement('span');
  span.textContent = message;

  toast.appendChild(icon);
  toast.appendChild(span);
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}

/* ---------------- MODAIS ---------------- */

function abrirModal(modal) {
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('modal-open'));
}

function fecharModal(modal) {
  modal.classList.remove('modal-open');
  setTimeout(() => { modal.style.display = 'none'; }, 200);
}

function setupModal(triggerId, modalId, closeId) {
  const trigger = document.getElementById(triggerId);
  const modal = document.getElementById(modalId);
  const closeBtn = closeId ? document.getElementById(closeId) : null;
  if (!trigger || !modal) return;

  trigger.addEventListener('click', (e) => {
    e.preventDefault();
    abrirModal(modal);
  });

  if (closeBtn) closeBtn.addEventListener('click', () => fecharModal(modal));
  modal.addEventListener('click', (e) => {
    if (e.target === modal) fecharModal(modal);
  });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-open').forEach(m => fecharModal(m));
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (sidebar?.classList.contains('open')) {
      sidebar.classList.remove('open');
      overlay?.classList.remove('visible');
    }
    document.querySelectorAll('.notif-panel.open').forEach(p => p.classList.remove('open'));
  }
});

/* ---------------- TEMA CLARO / ESCURO ---------------- */

const CC = {
  temaAtual() {
    return localStorage.getItem('cc_tema') || 'dark';
  },
  aplicarTema(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('cc_tema', t); } catch (e) { /* noop */ }
  },
  alternarTema() {
    this.aplicarTema(this.temaAtual() === 'dark' ? 'light' : 'dark');
  },
  /* Plano EFETIVO da loja (pago/trial vigente ou Free) via RPC */
  plano() {
    try {
      const sub = API.minhaAssinatura();
      return sub.plano_efetivo || sub.plan || null;
    } catch (e) { return null; }
  },
  /* A loja tem a funcionalidade? (leitura é sempre livre) */
  temFunc(chave) {
    if (!chave) return true;
    const p = this.plano();
    if (!p) return false;
    if (Array.isArray(p.permissions) && p.permissions.length) return p.permissions.includes(chave);
    return false;
  }
};

function criarBotaoTema() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.setAttribute('aria-label', 'Alternar entre modo claro e escuro');
  btn.title = 'Claro / Escuro';
  btn.innerHTML =
    '<svg class="icon-sol" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
    '<svg class="icon-lua" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/></svg>';
  btn.addEventListener('click', () => CC.alternarTema());
  return btn;
}

function montarTema() {
  CC.aplicarTema(CC.temaAtual());

  const navPublico = document.querySelector('.public-nav');
  if (navPublico) {
    navPublico.insertBefore(criarBotaoTema(), navPublico.firstChild);
    return;
  }

  const sidebarTools = document.querySelector('.sidebar-tools');
  if (sidebarTools) {
    sidebarTools.appendChild(criarBotaoTema());
    return;
  }

  /* Painel Super Admin: coloca o botão de tema dentro do cabeçalho, junto
     aos demais botões do canto direito — evita flutuar sobre eles. */
  const saHeader = document.querySelector('.sa-header');
  if (saHeader) {
    let extra = saHeader.querySelector('.sa-header-extra');
    if (!extra) {
      extra = document.createElement('div');
      extra.className = 'sa-header-extra';
      saHeader.appendChild(extra);
    }
    extra.appendChild(criarBotaoTema());
    return;
  }

  const topo = document.createElement('div');
  topo.className = 'login-topbar';
  topo.appendChild(criarBotaoTema());
  document.body.appendChild(topo);
}

/* ---------------- HELPERS ---------------- */

/* Escapa texto para uso seguro em innerHTML (dados vêm do localStorage) */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s === null || s === undefined ? '' : String(s);
  return d.innerHTML;
}

function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

function debounce(fn, ms) {
  let t;
  return function (...args) {
    clearTimeout(t);
    t = setTimeout(() => fn.apply(this, args), ms);
  };
}

function aguardarSkeleton(el) {
  if (!el) return;
  el.classList.add('skeleton');
  el.innerHTML = '<tr><td colspan="10" style="height:60px"></td></tr>';
}

/* Extrai a mensagem de erro de exceções {status, error} da LocalAPI */
function msgErro(e) {
  if (e && e.error) return e.error;
  if (typeof e === 'string' && e) return e;
  return 'Ocorreu um erro. Tente novamente.';
}

/* "2026-08-22T14:30" -> "22/08/2026 às 14:30" */
function fmtDataHoraBR(isoLocal) {
  if (!isoLocal) return '';
  const [data, hora] = String(isoLocal).split('T');
  return DB.fmtDataBR(data) + (hora ? ' às ' + hora.slice(0, 5) : '');
}

/* 90 -> "1h30", 45 -> "45min" */
function fmtDuracao(min) {
  min = Number(min || 0);
  if (min < 60) return min + 'min';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? h + 'h' + DB.pad2(m) : h + 'h';
}

/* Rótulos e classes dos status de agendamento */
const STATUS_AG = {
  pendente:        { label: 'Pendente',        cls: 'st-pendente' },
  confirmado:      { label: 'Confirmado',      cls: 'st-confirmado' },
  concluido:       { label: 'Concluído',       cls: 'st-concluido' },
  nao_compareceu:  { label: 'Não compareceu',  cls: 'st-falta' },
  cancelado:       { label: 'Cancelado',       cls: 'st-cancelado' }
};

function badgeStatus(status) {
  const s = STATUS_AG[status] || { label: status, cls: '' };
  return '<span class="badge-status ' + s.cls + '">' + esc(s.label) + '</span>';
}

/* Download de arquivo texto (usado na exportação CSV) */
function baixarArquivo(nome, conteudo, mime) {
  const blob = new Blob([conteudo], { type: mime || 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = nome;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- SESSÃO / GUARDS ---------------- */

function usuarioLogado() { return Auth.usuarioAtual(); }

/* Redireciona se não houver sessão com um dos papéis exigidos.
   role: 'dono' (painel admin), 'cliente' (perfil público) ou uma lista
   ex.: ['dono','barbeiro'] — páginas liberadas para a equipe. */
function exigirLogin(role) {
  const papeis = Array.isArray(role) ? role : [role];
  const u = Auth.usuarioAtual();

  if (u && u.role === 'barbeiro' && !papeis.includes('barbeiro')) {
    sessionStorage.setItem('cc_flash', JSON.stringify({
      texto: 'Acesso restrito: sua conta permite apenas as abas Agendamentos e Clientes.',
      tipo: 'error'
    }));
    window.location.replace('/agendamentos');
    return null;
  }
  if (u && u.role === 'dependente' && !papeis.includes('dependente')) {
    sessionStorage.setItem('cc_flash', JSON.stringify({
      texto: 'Acesso restrito: a conta Dependente permite apenas Agendamentos e Clientes (relatórios são bloqueados).',
      tipo: 'error'
    }));
    window.location.replace('/agendamentos');
    return null;
  }

  if (!u || !papeis.includes(u.role)) {
    const aqui = window.location.pathname.split('/').pop();
    sessionStorage.setItem('cc_flash', JSON.stringify({
      texto: papeis.includes('dono')
        ? 'Faça login como dono de salão para acessar o painel.'
        : 'Faça login para acessar seu perfil.',
      tipo: 'error'
    }));
    const naAdmin = window.location.pathname.includes('/admin/');
    const destino = '/login?next=' + encodeURIComponent(aqui) +
      '&role=' + papeis.join(',');
    window.location.replace(destino);
    return null;
  }
  return u;
}

/* Mensagens flash entre páginas (ex.: bloqueio de guard) */
function mostrarFlash() {
  try {
    const raw = sessionStorage.getItem('cc_flash');
    if (!raw) return;
    sessionStorage.removeItem('cc_flash');
    const f = JSON.parse(raw);
    if (f && f.texto) showToast(f.texto, f.tipo || 'error');
  } catch (e) { /* noop */ }
}

/* Para onde o usuário vai depois do login (honra ?next=) */
function rotaAdmin(pagina) {
  const nome = String(pagina || '').split('/').pop().replace(/\.html$/, '');
  if (!nome || nome === 'index') return '/painel';
  return '/' + nome;
}

function destinoPosLogin(usuario) {
  const next = getParam('next');
  const ehAdmin = (pagina) => {
    const n = String(pagina || '').split('/').pop().replace(/\.html$/, '');
    return ['painel', 'index', 'agendamentos', 'clientes', 'servicos',
      'profissionais', 'assinatura', 'configuracoes', 'suporte',
      'funcionarios', 'horarios', 'relatorios'].includes(n);
  };

  /* barbeiro ajudante (RBAC): apenas Agendamentos e Clientes */
  if (usuario.role === 'barbeiro') {
    if (next && ['agendamentos', 'clientes'].includes(String(next).split('/').pop().replace(/\.html$/, ''))) return rotaAdmin(next);
    return '/agendamentos';
  }

  /* dependente/funcionário (RBAC): agenda + clientes; relatórios bloqueados */
  if (usuario.role === 'dependente') {
    if (next && ['agendamentos', 'clientes'].includes(String(next).split('/').pop().replace(/\.html$/, ''))) return rotaAdmin(next);
    return '/agendamentos';
  }

  if (next) {
    if (usuario.role === 'dono' && ehAdmin(next)) return rotaAdmin(next);
    if (usuario.role === 'cliente' && !ehAdmin(next)) {
      return next.startsWith('/') ? next : '/' + next;
    }
  }
  return usuario.role === 'dono' ? '/painel' : '/perfil';
}

/* Dependente com conta criada por autoatendimento mas ainda SEM vínculo
   (link_pendente): bloqueia a página e leva a informar o Código Único
   da empresa. Retorna true quando exibiu a tela (o caller não segue). */
function telaVinculoPendente() {
  const u = Auth.usuarioAtual();
  if (!u || u.role !== 'dependente') return false;
  if (Auth.salaoDoUsuario(u)) return false;

  const raiz = document.querySelector('.main') || document.body;
  raiz.innerHTML = '';
  raiz.style.cssText = 'display:flex; align-items:flex-start; justify-content:center; padding:32px 16px;';

  const card = document.createElement('div');
  card.className = 'card';
  card.style.cssText = 'width:100%; max-width:440px; padding:24px;';
  card.innerHTML =
    '<h2 style="margin-top:0;">Vincular ao salão</h2>' +
    '<p style="color:var(--text-muted); font-size:14px; margin-bottom:16px;">' +
    'Sua conta ainda não está vinculada a nenhuma empresa. Informe o ' +
    '<strong>Código Único</strong> que você recebeu do dono do salão para ' +
    'começar a usar agenda e clientes.</p>';

  const form = document.createElement('form');
  form.innerHTML =
    '<div class="field">' +
      '<label for="vinculo-codigo">Código Único da empresa</label>' +
      '<input type="text" id="vinculo-codigo" placeholder="Ex: 7KXQ9M2A" required ' +
      'style="text-transform:uppercase; font-family:monospace; letter-spacing:2px;">' +
    '</div>' +
    '<button type="submit" class="btn btn-primary" style="width:100%; justify-content:center;">Vincular</button>' +
    '<p style="text-align:center; margin-top:14px; font-size:13.5px;">' +
      '<a href="#" id="btn-sair-vinculo" style="color:var(--brass);">Sair e entrar com outra conta</a>' +
    '</p>';

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const campo = form.querySelector('#vinculo-codigo');
    try {
      API.vincularDependente({ codigo_unico: campo.value });
      showToast('Vínculo realizado com sucesso!', 'success');
      setTimeout(() => { window.location.reload(); }, 700);
    } catch (erro) {
      showToast(msgErro(erro), 'error');
      campo.select();
    }
  });

  const sair = form.querySelector('#btn-sair-vinculo');
  sair.addEventListener('click', (e) => {
    e.preventDefault();
    Auth.logout();
    showToast('Você saiu da sua conta.');
    setTimeout(() => { window.location.href = '/login'; }, 600);
  });

  card.appendChild(form);
  raiz.appendChild(card);
  return true;
}

/* Área de autenticação no header público (#nav-auth) */
function renderNavAuth() {
  const slot = document.getElementById('nav-auth');
  if (!slot) return;

  const u = Auth.usuarioAtual();
  slot.innerHTML = '';

  if (u) {
    const sair = document.createElement('a');
    sair.href = '#';
    sair.textContent = 'Sair';
    sair.addEventListener('click', (e) => {
      e.preventDefault();
      Auth.logout();
      showToast('Você saiu da sua conta.');
      setTimeout(() => { window.location.href = '/catalogo'; }, 600);
    });
    slot.appendChild(sair);

    const minhaConta = document.createElement('a');
    minhaConta.href = u.role === 'dono' ? '/painel' : '/perfil';
    minhaConta.className = 'btn btn-brass btn-sm-header';
    minhaConta.textContent = u.role === 'dono' ? 'Painel' : 'Meu perfil';
    slot.appendChild(minhaConta);
  } else {
    const entrar = document.createElement('a');
    entrar.href = '/login';
    entrar.className = 'btn btn-brass btn-sm-header';
    entrar.id = 'btn-minha-conta';
    entrar.textContent = 'Minha conta';
    slot.appendChild(entrar);
  }
}

/* ---------------- SINO DE NOTIFICAÇÕES (admin) ---------------- */

function atualizarBadgeNotif() {
  const badge = document.getElementById('bell-badge');
  if (!badge) return;
  try {
    const n = API.naoLidasCount();
    badge.hidden = !n;
    badge.textContent = n > 99 ? '99+' : String(n);
  } catch (e) { badge.hidden = true; }
}

function renderPainelNotificacoes() {
  const painel = document.getElementById('painel-notificacoes');
  if (!painel) return;
  let itens = [];
  try { itens = API.minhasNotificacoes({ limit: 30 }).items; } catch (e) { /* noop */ }

  painel.innerHTML = '';

  if (!itens.length) {
    const vazio = document.createElement('div');
    vazio.className = 'notif-empty';
    vazio.textContent = 'Nenhuma notificação por aqui.';
    painel.appendChild(vazio);
    return;
  }

  itens.forEach(n => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'notif-item' + (n.read ? ' lida' : '');
    item.innerHTML =
      '<strong>' + esc(n.title) + '</strong>' +
      esc(n.message) +
      '<span class="notif-quando">' + esc(DB.fmtDataBR(String(n.created_at).slice(0, 10))) + '</span>';
    item.addEventListener('click', () => {
      try {
        if (!n.read) { API.marcarNotificacaoLida(n.id); n.read = 1; }
      } catch (e) { /* noop */ }
      item.classList.add('lida');
      atualizarBadgeNotif();
      const ev = new CustomEvent('cc:notif-click', { detail: n });
      document.dispatchEvent(ev);
    });
    painel.appendChild(item);
  });

  const marcarTodas = document.createElement('button');
  marcarTodas.type = 'button';
  marcarTodas.className = 'notif-marcar-todas';
  marcarTodas.textContent = 'Marcar todas como lidas';
  marcarTodas.addEventListener('click', () => {
    try {
      API.marcarTodasLidas();
      painel.querySelectorAll('.notif-item').forEach(i => i.classList.add('lida'));
      atualizarBadgeNotif();
      showToast('Notificações marcadas como lidas.');
    } catch (e) { showToast(msgErro(e), 'error'); }
  });
  painel.appendChild(marcarTodas);
}

function montarNotificacoes() {
  const bell = document.getElementById('btn-notificacoes');
  const painel = document.getElementById('painel-notificacoes');
  if (!bell || !painel) return;

  /* RF-068: gera lembretes dos agendamentos de amanhã ao abrir o painel */
  try { API.gerarLembretesPendentes(); } catch (e) { /* noop */ }
  atualizarBadgeNotif();

  bell.addEventListener('click', () => {
    const aberto = painel.classList.toggle('open');
    if (aberto) renderPainelNotificacoes();
  });
}

/* ---------------- SHELL DO PAINEL ADMIN (sidebar comum) ---------------- */

/* Banner de upgrade: páginas com body[data-required-feature] bloqueiam o
   uso quando o plano efetivo não inclui a funcionalidade. Consultas
   continuam livres; as escritas são barradas também no backend. */
function aplicarBannerPlano() {
  const bodyEl = document.body;
  const req = bodyEl && bodyEl.getAttribute('data-required-feature');
  const u = Auth.usuarioAtual();
  if (!req || !u || u.role !== 'dono') return;
  if (CC.temFunc(req)) return;

  const existente = document.getElementById('banner-upgrade-plano');
  if (existente || !document.querySelector('.main')) return;

  const plano = CC.plano();
  const nomePlano = (plano && plano.name) || 'sem plano';
  const av = document.createElement('div');
  av.id = 'banner-upgrade-plano';
  av.className = 'card';
  av.style.cssText = 'border-color:var(--warn-text);margin-bottom:18px;display:flex;gap:12px;' +
    'align-items:center;flex-wrap:wrap;';
  av.innerHTML =
    '<strong style="color:var(--warn-text);">Funcionalidade bloqueada no plano ' + esc(nomePlano) + '.</strong>' +
    '<span style="color:var(--text-muted);font-size:14px;">' +
    'Você pode consultar tudo aqui, mas para criar e editar é preciso um dos planos pagos.</span>' +
    '<a href="/assinatura" class="btn btn-brass" style="margin-left:auto;">Ver planos</a>';
  document.querySelector('.main').prepend(av);
}

/* Elementos interativos com [data-feature] ficam desabilitados se a loja
   não tem a funcionalidade (complemento visual do gate de backend) */
function aplicarGatesDeFuncionalidade() {
  const u = Auth.usuarioAtual();
  if (!u || u.role !== 'dono') return;
  const plano = CC.plano();
  if (!plano) return;
  const perms = plano.permissions || [];
  document.querySelectorAll('[data-feature]').forEach(el => {
    const chave = el.getAttribute('data-feature');
    if (chave && !perms.includes(chave)) {
      el.classList.add('cc-bloqueado');
      el.disabled = true;
      if (!el.title) el.title = 'Plano ' + plano.name + ' — assine para liberar.';
    }
  });
}

function montarShellAdmin() {
  const u = Auth.usuarioAtual();
  if (!u || (u.role !== 'dono' && u.role !== 'barbeiro' && u.role !== 'dependente')) return;
  const loja = Auth.salaoDoUsuario(u);

  const avatar = document.getElementById('sb-avatar');
  const nomeEl = document.getElementById('sb-nome');
  const planoEl = document.getElementById('sb-plano');
  if (u.role === 'barbeiro') {
    if (avatar) avatar.textContent = DB.iniciais(u.name);
    if (nomeEl) nomeEl.textContent = u.name;
    if (planoEl) planoEl.textContent = 'Perfil: barbeiro';
  } else if (u.role === 'dependente') {
    if (avatar) avatar.textContent = DB.iniciais(u.name);
    if (nomeEl) nomeEl.textContent = u.name;
    if (planoEl) planoEl.textContent = (loja ? loja.name : 'Funcionário');
  } else {
    if (avatar && loja) avatar.textContent = DB.iniciais(loja.name);
    if (nomeEl && loja) nomeEl.textContent = loja.name;
    if (planoEl) {
      try {
        const sub = API.minhaAssinatura();
        const p = sub.plano_efetivo || sub.plan;
        planoEl.textContent = 'Plano ' + (p ? p.name : '—') +
          (sub.on_trial ? ' · trial' : '');
      } catch (e) { planoEl.textContent = ''; }
    }
    aplicarBannerPlano();
    aplicarGatesDeFuncionalidade();
  }

  const btnSair = document.getElementById('btn-sair');
  if (btnSair && !btnSair.dataset.ccBound) {
    btnSair.dataset.ccBound = '1'; // montarShellAdmin roda no load e a cada troca de plano
    btnSair.addEventListener('click', () => {
      Auth.logout();
      showToast('Você saiu da sua conta.');
      setTimeout(() => { window.location.href = '/login'; }, 600);
    });
  }

  /* Acesso da conta para barbeiro/dependente: o botão de exclusão fica no
     perfil público (/perfil) — o painel não expõe zona de risco para eles. */
  const chip = document.querySelector('.user-chip');
  if (chip && (u.role === 'barbeiro' || u.role === 'dependente') && !chip.dataset.ccBound) {
    chip.dataset.ccBound = '1';
    chip.style.cursor = 'pointer';
    chip.addEventListener('click', () => { window.location.href = '/perfil'; });
  }
}

/* RBAC do ajudante e do dependente: mantém na sidebar apenas
   Agendamentos e Clientes (Relatórios e demais áreas ficam ocultos).
   O barbeiro também vê Funcionários para desligar dependentes. */
function aplicarRBACSidebar() {
  const u = Auth.usuarioAtual();
  if (!u || (u.role !== 'barbeiro' && u.role !== 'dependente')) return;

  const permitidas = ['agendamentos', 'clientes'];
  if (u.role === 'barbeiro') permitidas.push('funcionarios');
  document.querySelectorAll('.sidebar .nav-item').forEach(item => {
    const a = item.querySelector('a');
    const href = ((a && a.getAttribute('href')) || '').split('/').pop();
    if (!permitidas.includes(href)) item.remove();
  });

  /* remove rótulos de grupos que ficaram sem itens */
  document.querySelectorAll('.sidebar .nav-group-label').forEach(label => {
    let node = label.nextElementSibling;
    let temItens = false;
    while (node && !node.classList.contains('nav-group-label')) {
      if (node.classList.contains('nav-list') && node.querySelector('.nav-item')) temItens = true;
      node = node.nextElementSibling;
    }
    if (!temItens) label.remove();
  });

  /* RBAC aplicado: revela a navegação já filtrada (remove o "escudo" anti-flash) */
  document.documentElement.classList.remove('cc-rbac-pending');
}

/* ---------------- BOOT ---------------- */

document.addEventListener('DOMContentLoaded', () => {
  montarTema();
  mostrarFlash();
  renderNavAuth();
  montarNotificacoes();
  if (typeof Auth !== 'undefined') {
    montarShellAdmin();
    aplicarRBACSidebar();
  }

  const hamburger = document.getElementById('hamburger');
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (hamburger && sidebar) {
    hamburger.addEventListener('click', () => {
      sidebar.classList.toggle('open');
      overlay?.classList.toggle('visible');
    });
  }
  if (overlay) {
    overlay.addEventListener('click', () => {
      sidebar.classList.remove('open');
      overlay.classList.remove('visible');
    });
  }
});
