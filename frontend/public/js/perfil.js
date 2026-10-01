/* ============================================================
   Corte Comigo – public/js/perfil.js
   Perfil do cliente: estatísticas reais, próximos/histórico,
   favoritos (UC-15), avaliações (RF-056) e configurações.
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  /* captura magic link token da URL */
  var params = new URLSearchParams(window.location.search);
  var magicToken = params.get('token');
  if (magicToken) {
    localStorage.removeItem('cc_magic_token');
    window.location.href = '/admin/?token=' + magicToken;
    return;
  }

  const usuario = exigirLogin(['cliente', 'dependente', 'barbeiro']);
  if (!usuario) return;

  /* sincroniza com o servidor antes de renderizar: o cache do navegador
     pode estar defasado (causa de "salvei mas ao recarregar voltou o antigo") */
  try {
    const fresco = API.mePerfil().user;
    if (fresco && fresco.id === usuario.id) {
      Object.assign(usuario, fresco);
      Auth.sincronizarUsuario(usuario);
    }
  } catch (e) { /* sessão inválida: segue com o cache */ }

  /* ---------- abas ---------- */
  const tabsPerfil = document.querySelectorAll('.profile-tab');
  const conteudosPerfil = document.querySelectorAll('.profile-tab-content');
  tabsPerfil.forEach(tab => {
    tab.addEventListener('click', () => {
      tabsPerfil.forEach(t => t.classList.remove('active'));
      conteudosPerfil.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab)?.classList.add('active');
      if (tab.dataset.tab === 'favoritos') renderFavoritos();
    });
  });

  /* ---------- cabeçalho ---------- */
  const avatar = document.getElementById('pf-avatar');
  if (avatar) avatar.textContent = DB.iniciais(usuario.name);
  const h1 = document.getElementById('pf-nome');
  if (h1) h1.textContent = usuario.name;
  const metaEl = document.getElementById('pf-meta');
  if (metaEl) metaEl.textContent =
    (usuario.phone ? String(usuario.phone).replace(/^(\d{2})(\d{2})(\d{5})(\d{4})$/, '($1) $2-$3-$4') || usuario.phone : '—') +
    (usuario.email ? ' · ' + usuario.email : '');
  const desde = document.getElementById('pf-desde');
  if (desde && usuario.created_at) {
    const [y, m] = String(usuario.created_at).slice(0, 7).split('-');
    const meses = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
    desde.textContent = (usuario.role === 'dependente' ? 'Conta criada em ' : 'Cliente desde ') +
      (meses[Number(m) - 1] || m) + ' de ' + y;
  }

  /* ---------- dados ---------- */
  let ags = [];
  try { ags = API.meusAgendamentos(); } catch (e) { /* noop */ }
  const hojeISO = DB.hojeISO();

  const validos = ags.filter(a => a.status !== 'cancelado');
  const gastos = ags.filter(a => a.status === 'concluido')
    .reduce((acc, a) => acc + Number(a.price_total || 0), 0);
  let minhaContagemReviews = 0;
  try { minhaContagemReviews = API.minhasReviews().length; } catch (e) { /* sessão inválida */ }

  setText('st-total', validos.length);
  setText('st-gasto', DB.fmtBRL(gastos));
  setText('st-avaliacoes', minhaContagemReviews);

  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }

  /* marca reviews já feitas por agendamento (controle local da demo) */
  const CHAVE_REVIEWS = 'cc_reviews_feitos';
  function reviewsFeitos() {
    try { return JSON.parse(localStorage.getItem(CHAVE_REVIEWS) || '{}'); }
    catch (e) { return {}; }
  }
  function marcarReviewFeita(agId) {
    const m = reviewsFeitos();
    m[agId] = true;
    localStorage.setItem(CHAVE_REVIEWS, JSON.stringify(m));
  }

  /* ---------- próximos ---------- */
  const tbProx = document.getElementById('tb-proximos');

  function renderProximos() {
    if (!tbProx) return;
    const prox = ags.filter(a =>
      a.date >= hojeISO && (a.status === 'pendente' || a.status === 'confirmado'));

    /* banner lembrete 24h */
    const banner = document.getElementById('banner-lembrete');
    if (banner) {
      const em24h = prox.find(a => {
        const ms = new Date(a.date + 'T' + a.time).getTime() - Date.now();
        return ms > 0 && ms < 86400000;
      });
      if (em24h) {
        banner.style.display = 'block';
        banner.textContent = 'Lembrete: você tem agendamento amanhã às ' + em24h.time +
          ' no ' + em24h.barbershop_name + ' (' + em24h.services.map(s => s.name).join(', ') + ').';
      } else if (banner) {
        banner.style.display = 'none';
      }
    }

    if (!prox.length) {
      tbProx.innerHTML = '<tr><td colspan="6"><div class="empty-state"><h3>Nada agendado por aqui</h3><p>Escolha um salão no catálogo e marque seu próximo horário.</p></div></td></tr>';
      return;
    }

    tbProx.innerHTML = prox.map(a =>
      '<tr>' +
        '<td>' + esc(DB.fmtDataBR(a.date)) + '</td>' +
        '<td class="mono">' + esc(a.time) + '</td>' +
        '<td>' + esc(a.barbershop_name) + '</td>' +
        '<td>' + esc(a.services.map(s => s.name).join(' + ') || '—') + '</td>' +
        '<td>' + badgeStatus(a.status) + '</td>' +
        '<td style="white-space:nowrap;">' +
          '<button class="btn btn-outline btn-acao" data-acao="reagendar" data-id="' + esc(a.id) + '" ' +
            'data-shop="' + esc(a.barbershop_id) + '" data-date="' + esc(a.date) + '" data-time="' + esc(a.time) + '">Alterar</button> ' +
          '<button class="btn btn-danger btn-cancelar" data-id="' + esc(a.id) + '">Cancelar</button>' +
        '</td>' +
      '</tr>'
    ).join('');
  }

  tbProx?.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-cancelar');
    if (!btn) return;
    if (!confirm('Cancelar este agendamento?')) return;
    try {
      API.atualizarAgendamento(btn.dataset.id, { status: 'cancelado' });
      showToast('Agendamento cancelado.', 'success');
      recarregar();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  /* ---------- reagendamento (P3-1) ---------- */
  const modalReag = document.getElementById('modal-reagendar');
  const inputReagData = document.getElementById('reagendar-data');
  const selReagHora = document.getElementById('reagendar-hora');
  let agParaReagendar = null;

  tbProx?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-acao="reagendar"]');
    if (!btn || !modalReag) return;
    agParaReagendar = { id: btn.dataset.id, shopId: btn.dataset.shop };
    inputReagData.value = btn.dataset.date || '';
    inputReagData.min = hojeISO;
    carregarSlotsReagendar(btn.dataset.date);
    abrirModal(modalReag);
  });

  inputReagData?.addEventListener('change', () => {
    if (inputReagData.value) carregarSlotsReagendar(inputReagData.value);
  });

  function carregarSlotsReagendar(dateISO) {
    if (!selReagHora || !agParaReagendar) return;
    selReagHora.innerHTML = '<option value="">Carregando…</option>';
    try {
      const disp = API.disponibilidade(agParaReagendar.shopId, dateISO);
      selReagHora.innerHTML = disp.available_slots.length
        ? disp.available_slots.map(h => '<option value="' + esc(h) + '">' + esc(h) + '</option>').join('')
        : '<option value="">Nenhum horário livre</option>';
    } catch (e) {
      selReagHora.innerHTML = '<option value="">Erro ao carregar</option>';
    }
  }

  document.getElementById('btn-fechar-reagendar')
    ?.addEventListener('click', () => fecharModal(modalReag));
  modalReag?.addEventListener('click', e => { if (e.target === modalReag) fecharModal(modalReag); });

  document.getElementById('form-reagendar')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!agParaReagendar) return;
    const novaData = inputReagData.value;
    const novaHora = selReagHora.value;
    if (!novaData || !novaHora) { showToast('Selecione data e horário.', 'error'); return; }
    try {
      API.atualizarAgendamento(agParaReagendar.id, { date: novaData, start_time: novaHora });
      showToast('Horário alterado com sucesso!');
      fecharModal(modalReag);
      recarregar();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  /* ---------- histórico ---------- */
  const tbHist = document.getElementById('tb-historico');

  function renderHistorico() {
    if (!tbHist) return;
    const passados = ags.filter(a =>
      a.status === 'concluido' || a.status === 'nao_compareceu' ||
      (a.date < hojeISO && a.status !== 'cancelado'));

    if (!passados.length) {
      tbHist.innerHTML = '<tr><td colspan="6"><div class="empty-state"><h3>Sem histórico ainda</h3><p>Seus atendimentos concluídos aparecem aqui.</p></div></td></tr>';
      return;
    }

    tbHist.innerHTML = passados.map(a => {
      const jaAvaliado = !!reviewsFeitos()[a.id];
      let acao = '';
      if (jaAvaliado) acao = '<button class="btn btn-outline" disabled>Avaliado</button>';
      else if (a.status === 'concluido') {
        acao = '<button class="btn btn-outline btn-avaliar" data-id="' + esc(a.id) +
          '" data-shop="' + esc(a.barbershop_id) + '">Avaliar</button>';
      }
      return '<tr>' +
        '<td>' + esc(DB.fmtDataBR(a.date)) + '</td>' +
        '<td>' + esc(a.barbershop_name) + '</td>' +
        '<td>' + esc(a.services.map(s => s.name).join(' + ') || '—') + '</td>' +
        '<td>' + esc(a.professional_name || '—') + '</td>' +
        '<td class="mono">' + esc(DB.fmtBRL(a.price_total)) + '</td>' +
        '<td>' + acao + '</td>' +
      '</tr>';
    }).join('');
  }

  function recarregar() {
    try { ags = API.meusAgendamentos(); } catch (e) { /* noop */ }
    renderProximos();
    renderHistorico();
    setText('st-total', ags.filter(a => a.status !== 'cancelado').length);
  }

  renderProximos();
  renderHistorico();

  /* ---------- modal de avaliação (RF-056 · POST autenticado) ---------- */
  const modalAv = document.getElementById('modal-avaliacao');
  const stars = document.querySelectorAll('#star-rating .star');
  const avNota = document.getElementById('av-nota');
  let agParaAvaliar = null;

  document.body.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-avaliar');
    if (!btn || !modalAv) return;
    agParaAvaliar = { id: btn.dataset.id, shop: btn.dataset.shop };
    avNota.value = '0';
    stars.forEach(s => s.classList.remove('active'));
    abrirModal(modalAv);
  });

  stars.forEach(star => {
    star.addEventListener('click', () => {
      const v = Number(star.dataset.value);
      avNota.value = v;
      stars.forEach(s => s.classList.toggle('active', Number(s.dataset.value) <= v));
    });
  });

  document.getElementById('btn-fechar-modal-avaliacao')
    ?.addEventListener('click', () => fecharModal(modalAv));
  modalAv?.addEventListener('click', e => { if (e.target === modalAv) fecharModal(modalAv); });

  document.getElementById('form-avaliacao')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nota = Number(avNota.value);
    if (!nota) { showToast('Escolha uma nota de 1 a 5 estrelas.', 'error'); return; }
    if (!agParaAvaliar) return;

    try {
      API.criarReview(agParaAvaliar.shop, {
        rating: nota,
        comment: document.getElementById('av-comentario')?.value || ''
      });
      marcarReviewFeita(agParaAvaliar.id);
      minhaContagemReviews++;
      setText('st-avaliacoes', minhaContagemReviews);
      showToast('Avaliação enviada! Obrigado.');
      fecharModal(modalAv);
      renderHistorico();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  /* ---------- favoritos (UC-15) ---------- */
  function renderFavoritos() {
    const box = document.getElementById('lista-favoritos');
    const vazio = document.getElementById('favoritos-vazio');
    if (!box) return;

    let favs = [];
    try { favs = API.meusFavoritos(); } catch (e) { /* noop */ }

    box.style.display = favs.length ? '' : 'none';
    if (vazio) vazio.style.display = favs.length ? 'none' : '';

    box.innerHTML = favs.map(l =>
      cardSalao(l)
    ).join('');

    box.querySelectorAll('.btn-fav-remover').forEach(btn => {
      btn.addEventListener('click', () => {
        try {
          API.alternarFavorito(btn.dataset.shop);
          showToast('Removido dos favoritos.', 'success');
          renderFavoritos();
        } catch (err2) {
          showToast(msgErro(err2), 'error');
        }
      });
    });
  }

  function cardSalao(l) {
    const capa = l.logo_url || l.cover_url; // foto de perfil manda no card
    const capaStyle = capa ? ' style="background:#000 url(&quot;' + esc(capa) + '&quot;) center/cover no-repeat;"' : '';
    return '<div class="fav-card">' +
      '<a href="/salao?id=' + encodeURIComponent(l.id) + '" class="salon-card">' +
        '<div class="salon-card-cover"' + capaStyle + '></div>' +
        '<div class="salon-card-body">' +
          '<div class="salon-name">' + esc(l.name) + '</div>' +
          '<div class="salon-meta"><span class="rating">★ ' +
            esc(Number(l.rating_avg || 0).toFixed(1)) + '</span> · ' +
            esc((l.city || '') + (l.uf ? ', ' + l.uf : '')) + '</div>' +
        '</div>' +
      '</a>' +
      '<button class="btn btn-danger btn-fav-remover" data-shop="' + esc(l.id) + '">Remover</button>' +
    '</div>';
  }

  /* ---------- dependência de empresa (dependente) ---------- */
  const cardDep = document.getElementById('card-dependencia');
  const vincDiv = document.getElementById('dependencia-vinculado');
  const pendDiv = document.getElementById('dependencia-pendente');

  if (usuario.role === 'dependente' && cardDep) {
    cardDep.style.display = '';
    const lojaDep = Auth.salaoDoUsuario(usuario);

    if (lojaDep) {
      vincDiv.style.display = '';
      pendDiv.style.display = 'none';
      const nomeEmp = document.getElementById('dep-empresa-nome');
      if (nomeEmp) nomeEmp.textContent = lojaDep.name;

      document.getElementById('btn-deixar-dependente')
        ?.addEventListener('click', () => {
          if (!confirm('Deixar de ser dependente de "' + lojaDep.name + '"? Sua conta continua existindo como cliente.')) return;
          try {
            API.sairDeDependente();
            showToast('Você deixou de ser dependente. Sua conta agora é de cliente.', 'success');
            setTimeout(() => { window.location.href = '/perfil'; }, 900);
          } catch (err2) {
            showToast(msgErro(err2), 'error');
          }
        });
    } else {
      vincDiv.style.display = 'none';
      pendDiv.style.display = '';
      document.getElementById('btn-vincular-perfil')
        ?.addEventListener('click', () => {
          const campo = document.getElementById('perfil-dep-codigo');
          try {
            API.vincularDependente({ codigo_unico: campo.value });
            showToast('Vínculo realizado com sucesso!', 'success');
            setTimeout(() => { window.location.href = '/perfil'; }, 900);
          } catch (err2) {
            showToast(msgErro(err2), 'error');
            campo.select();
          }
        });
    }
  }

  /* ---------- configurações da conta ---------- */
  const fDados = document.getElementById('form-perfil-dados');
  if (fDados) {
    const inpNome = fDados.querySelector('[name=nome]');
    const inpTel = fDados.querySelector('[name=telefone]');
    const inpEmail = fDados.querySelector('[name=email]');
    if (inpNome) inpNome.value = usuario.name || '';
    if (inpTel) inpTel.value = usuario.phone || '';
    if (inpEmail) inpEmail.value = usuario.email || '';
    fDados.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const nome = (inpNome ? inpNome.value : '').trim();
      const email = (inpEmail ? inpEmail.value : '').trim();
      const tel = (inpTel ? inpTel.value : '').trim();

      /* valida no cliente para não gastar ida ao servidor com dado
         obviamente inválido (o back também valida) */
      if (!nome) { showToast('Informe seu nome.', 'error'); return; }
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        showToast('E-mail inválido. Deixe em branco para remover da conta.', 'error');
        return;
      }
      const digitos = tel.replace(/\D/g, '');
      if (tel && (digitos.length < 10 || digitos.length > 13)) {
        showToast('Telefone inválido: use de 10 a 13 dígitos.', 'error');
        return;
      }
      try {
        const u = API.atualizarMe({ name: nome, phone: tel, email: email });
        Object.assign(usuario, u);
        Auth.sincronizarUsuario(usuario); // cache local acompanha o servidor
        h1.textContent = u.name;
        avatar.textContent = DB.iniciais(u.name);
        if (inpTel) inpTel.value = u.phone || '';
        if (inpEmail) inpEmail.value = u.email || '';
        showToast('Dados pessoais atualizados!');
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    });
  }

  const fPrefs = document.getElementById('form-perfil-preferencias');
  if (fPrefs) {
    const prefs = usuario.prefs || {};
    fPrefs.querySelector('[name=notif_email]').value = prefs.notif_email || 'sim';
    fPrefs.querySelector('[name=notif_sms]').value = prefs.notif_sms || 'não';
    fPrefs.querySelector('[name=lembrete]').value = prefs.lembrete || '30';
    fPrefs.addEventListener('submit', (ev) => {
      ev.preventDefault();
      try {
        const prefsRet = API.atualizarPreferencias({
          notif_email: fPrefs.querySelector('[name=notif_email]').value,
          notif_sms: fPrefs.querySelector('[name=notif_sms]').value,
          lembrete: fPrefs.querySelector('[name=lembrete]').value
        });
        usuario.prefs = Object.assign({}, usuario.prefs || {}, prefsRet || {});
        Auth.sincronizarUsuario(usuario); // cache local acompanha o servidor
        showToast('Preferências salvas!');
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    });
  }

  document.getElementById('btn-sair-perfil')?.addEventListener('click', () => {
    Auth.logout();
    showToast('Você saiu da sua conta.');
    setTimeout(() => { window.location.href = '/catalogo'; }, 600);
  });

  /* ---------- desvincular conta (soft disconnect) ---------- */
  const btnDesvincularConta = document.getElementById('btn-desvincular-conta');
  if (btnDesvincularConta) {
    btnDesvincularConta.addEventListener('click', () => {
      if (!confirm('Tem certeza que deseja desconectar esta conta da empresa? Sua conta continuará existindo, mas perderá o vínculo com o salão. Você poderá logar novamente depois.')) return;
      try {
        const r = API.desvincularMinhaConta();
        showToast(r && r.message ? r.message : 'Conta desconectada.');
        Auth.limparSessao();
        setTimeout(() => { window.location.href = '/catalogo'; }, 1200);
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    });
  }

  /* ---------- exclusão de conta com código (P3-3) ---------- */
  const modalExcluirCli = document.getElementById('modal-excluir-cliente');
  const stepCli1 = document.getElementById('excluir-cli-step-1');
  const stepCli2 = document.getElementById('excluir-cli-step-2');
  const inputCodigoCli = document.getElementById('input-codigo-excluir-cli');
  const btnGerarCli = document.getElementById('btn-gerar-codigo-excluir-cli');
  const btnConfirmarCli = document.getElementById('btn-confirmar-excluir-cli');
  const btnCancelarExcluirCli = document.getElementById('btn-cancelar-excluir-cli');

  document.getElementById('btn-excluir-conta-cliente')?.addEventListener('click', () => {
    if (!modalExcluirCli) return;
    stepCli1.style.display = 'block';
    stepCli2.style.display = 'none';
    if (inputCodigoCli) inputCodigoCli.value = '';
    if (btnConfirmarCli) btnConfirmarCli.disabled = true;
    abrirModal(modalExcluirCli);
  });

  btnGerarCli?.addEventListener('click', () => {
    const senha = document.getElementById('input-senha-exclusao')?.value || '';
    const telefone = document.getElementById('input-tel-exclusao')?.value || '';
    try {
      const r = API.gerarCodigoExclusao({ senha, telefone });
      stepCli1.style.display = 'none';
      stepCli2.style.display = 'block';
      showToast(r && r.hint ? r.hint : 'Código enviado. Digite abaixo.');
      if (inputCodigoCli) inputCodigoCli.focus();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  inputCodigoCli?.addEventListener('input', () => {
    /* só dígitos: o botão ficava habilitado com "abcd" e o back devolvia
       "código inválido" sem explicar nada */
    const v = inputCodigoCli.value.replace(/\D/g, '');
    if (v !== inputCodigoCli.value) inputCodigoCli.value = v;
    if (btnConfirmarCli) btnConfirmarCli.disabled = v.length !== 4;
  });

  btnConfirmarCli?.addEventListener('click', () => {
    const code = (inputCodigoCli?.value || '').replace(/\D/g, '').trim();
    if (code.length !== 4) {
      showToast('Digite os 4 dígitos do código.', 'error');
      return;
    }
    try {
      API.confirmarExclusao(code);
      Auth.limparSessao();
      showToast('Conta excluída.', 'success');
      setTimeout(() => { window.location.href = '/catalogo'; }, 1200);
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  btnCancelarExcluirCli?.addEventListener('click', () => fecharModal(modalExcluirCli));
  modalExcluirCli?.addEventListener('click', e => { if (e.target === modalExcluirCli) fecharModal(modalExcluirCli); });

  /* LGPD — Exportar dados */
  var btnExportar = document.getElementById('btn-exportar-dados');
  if (btnExportar) {
    btnExportar.onclick = function() {
      btnExportar.disabled = true;
      try {
        var r = API.exportarMeusDados();
        var blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = 'cortecomigo-meus-dados-' + new Date().toISOString().slice(0,10) + '.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast('Arquivo gerado. Confira seus downloads.', 'success');
      } catch (e) {
        showToast(msgErro(e), 'error');
      } finally {
        btnExportar.disabled = false;
      }
    };
  }

  /* LGPD — Sair de todos dispositivos */
  var btnSairTodos = document.getElementById('btn-sair-todos');
  if (btnSairTodos) {
    btnSairTodos.onclick = function() {
      if (!confirm('Sair de todos os dispositivos? Você precisará fazer login novamente.')) return;
      try {
        API.logoutTodosDispositivos();
        showToast('Sessões encerradas.', 'success');
        Auth.logout();
        setTimeout(function() { window.location.href = '/catalogo'; }, 800);
      } catch (e) { showToast(msgErro(e), 'error'); }
    };
  }

  /* ---------- tab segurança ---------- */
  var tabSeguranca = document.querySelector('.profile-tab[data-tab="seguranca"]');
  if (tabSeguranca) {
    tabSeguranca.addEventListener('click', function() {
      tabsPerfil.forEach(function(t) { t.classList.remove('active'); });
      conteudosPerfil.forEach(function(c) { c.classList.remove('active'); });
      tabSeguranca.classList.add('active');
      var secContent = document.getElementById('tab-seguranca');
      if (secContent) secContent.classList.add('active');
      carregarLogsAcesso();
    });
  }

  function carregarLogsAcesso() {
    var box = document.getElementById('logs-acesso');
    if (!box) return;
    try {
      var logs = API.meusLogsDeAcesso();
      if (!logs || !logs.length) {
        box.innerHTML = '<p style="color:var(--text-muted);">Nenhum registro recente.</p>';
        return;
      }
      var acoes = {
        login_sucesso: 'Login realizado',
        logout_todos_dispositivos: 'Logout de todos os dispositivos',
        exportar_dados: 'Exportação de dados',
        excluir_conta: 'Exclusão de conta',
        revogar_consentimento: 'Revogação de consentimento',
        alterar_dados: 'Alteração de dados pessoais'
      };
      box.innerHTML = logs.slice(0, 10).map(function(log) {
        var nomeAcao = acoes[log.acao] || log.acao;
        var data = log.timestamp ? log.timestamp.replace('T', ' ').slice(0, 19) : '';
        return '<div style="padding:10px 0;border-bottom:1px solid #1a1a1a;">' +
          '<strong style="color:#f0f0f0;">' + esc(nomeAcao) + '</strong>' +
          '<br><small style="color:var(--text-muted);">' + esc(data) + '</small>' +
          '</div>';
      }).join('');
    } catch(e) {
      box.innerHTML = '<p style="color:var(--text-muted);">Erro ao carregar logs.</p>';
    }
  }

  /* ---------- sair todos dispositivos (tab segurança) ---------- */
  var btnSairTodosSeg = document.getElementById('btn-sair-todos-seg');
  if (btnSairTodosSeg) {
    btnSairTodosSeg.addEventListener('click', function() {
      if (!confirm('Sair de todos os dispositivos? Você precisará logar novamente.')) return;
      try {
        API.logoutTodosDispositivos();
        Auth.logout();
        showToast('Sessões encerradas.');
        setTimeout(function() { window.location.href = '/catalogo'; }, 800);
      } catch(e) { showToast(msgErro(e), 'error'); }
    });
  }

  renderFavoritos();
});
