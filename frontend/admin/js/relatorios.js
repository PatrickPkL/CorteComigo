/* ============================================================
   Corte Comigo – admin/js/relatorios.js
   Relatórios:
   · Modo PLATAFORMA (super-admin logado): números de todas as
     lojas, assinaturas por plano e séries mensais do site.
   · Modo SALÃO (dono/profissional): dados do próprio salão.
   Atualização automática em tempo real (polling).
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const TOKEN_SA = localStorage.getItem('cc_superadmin_token') ||
    localStorage.getItem('cc_super_admin_token');
  const modoPlataforma = !!TOKEN_SA;

  const usuario = modoPlataforma ? null : exigirLogin('dono');
  const loja = modoPlataforma
    ? null
    : (usuario ? Auth.salaoDoUsuario(usuario) : null);

  if (!modoPlataforma) {
    if (!usuario) return;
    if (!loja) {
      showToast('Nenhum salão vinculado a esta conta.', 'error');
      setTimeout(() => { window.location.href = '/login'; }, 1200);
      return;
    }
  }

  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
  function setDelta(id, texto, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = 'stat-delta' + (cls ? ' ' + cls : '');
    el.textContent = texto;
  }

  /* ---------- eixos ---------- */
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
    'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  function rotuloMes(key) {
    if (!key || key.length < 7) return key || '';
    const m = parseInt(key.slice(5, 7), 10) - 1;
    const a = parseInt(key.slice(0, 4), 10);
    return MESES[m] + '/' + String(a).slice(2);
  }

  function ultimosMeses(n) {
    const out = [];
    const agora = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(agora.getFullYear(), agora.getMonth() - i, 1);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      out.push({ key, rotulo: rotuloMes(key) });
    }
    return out;
  }

  function ultimosDias(n) {
    const out = [];
    const agora = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(agora.getFullYear(), agora.getMonth(), agora.getDate() - i);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      out.push({ key, rotulo: String(d.getDate()) });
    }
    return out;
  }

  function agregarPorMes(mapChave, meses) {
    return meses.map(m => mapChave[m.key] || 0);
  }

  /* ---------- cores do tema ---------- */
  function corVar(nome, fallback) {
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue(nome).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }

  const C = {
    muted: corVar('--text-muted', '#6B6558'),
    line: corVar('--line', '#DCD4C2'),
    brass: corVar('--brass', '#B8863B'),
    brassSoft: corVar('--brass-soft', '#D9B87A'),
    success: corVar('--success', '#4C7A5E'),
    danger: corVar('--danger', '#A1433C'),
    paper: corVar('--paper-soft', '#F5F1E7')
  };

  /* ---------- desenho básico (DPI) ---------- */
  function prepCanvas(cv) {
    const dpr = window.devicePixelRatio || 1;
    const cw = cv.clientWidth || cv.parentElement.clientWidth || 400;
    const ch = cv.clientHeight || 240;
    cv.width = Math.round(cw * dpr);
    cv.height = Math.round(ch * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    return { ctx, cw, ch };
  }

  function arredondarEixo(max) {
    if (!max || max <= 0) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(max)));
    const m = max / p;
    if (m <= 1) return p;
    if (m <= 2) return 2 * p;
    if (m <= 5) return 5 * p;
    return 10 * p;
  }

  function gradeHorizontal(ctx, cw, padL, padT, w, h, maxRounded) {
    ctx.strokeStyle = C.line;
    ctx.fillStyle = C.muted;
    ctx.lineWidth = 1;
    ctx.font = '10px "JetBrains Mono", monospace';
    for (let i = 0; i <= 4; i++) {
      const y = padT + h - (i / 4) * h;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + w, y); ctx.stroke();
      ctx.fillText(String(Math.round((maxRounded * i) / 4)), 4, y + 4);
    }
  }

  /* ---------- gráfico de barras ---------- */
  function desenharBarras(cv, rotulos, valores, cor) {
    const { ctx, cw, ch } = prepCanvas(cv);
    const padL = 34, padR = 6, padT = 12, padB = 24;
    const w = cw - padL - padR, h = ch - padT - padB;
    const max = Math.max.apply(null, valores.concat([1]));
    const maxRounded = arredondarEixo(max);
    gradeHorizontal(ctx, cw, padL, padT, w, h, maxRounded);

    const n = rotulos.length;
    const slot = n ? w / n : 1;
    const bw = Math.max(4, Math.min(slot * 0.55, 26));
    valores.forEach((v, i) => {
      const bh = (v / maxRounded) * h;
      const x = padL + slot * i + (slot - bw) / 2;
      const y = padT + h - bh;
      ctx.fillStyle = cor;
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, bw, bh, 3);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, bw, bh);
      }
      if (bh > 14 && v > 0) {
        ctx.fillStyle = C.paper;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillText(String(v), x + (bw - ctx.measureText(String(v)).width) / 2, y + 10);
      }
      ctx.fillStyle = C.muted;
      ctx.font = '10px "JetBrains Mono", monospace';
      ctx.fillText(rotulos[i], padL + slot * i + (slot - ctx.measureText(rotulos[i]).width) / 2, padT + h + 16);
    });
  }

  /* ---------- gráfico de linhas (área) ---------- */
  function desenharLinhas(cv, rotulos, valores, cor) {
    const { ctx, cw, ch } = prepCanvas(cv);
    const padL = 30, padR = 6, padT = 12, padB = 24;
    const w = cw - padL - padR, h = ch - padT - padB;
    const max = Math.max.apply(null, valores.concat([1]));
    const maxRounded = arredondarEixo(max);
    gradeHorizontal(ctx, cw, padL, padT, w, h, maxRounded);

    const n = rotulos.length;
    const passo = n > 1 ? w / (n - 1) : 0;
    const pts = valores.map((v, i) => ({
      x: padL + passo * i,
      y: padT + h - (v / maxRounded) * h,
      v
    }));

    const grad = ctx.createLinearGradient(0, padT, 0, padT + h);
    grad.addColorStop(0, cor + '66');
    grad.addColorStop(1, cor + '00');
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.lineTo(pts[pts.length - 1].x, padT + h);
    ctx.lineTo(pts[0].x, padT + h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.strokeStyle = cor;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();

    ctx.fillStyle = cor;
    pts.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2);
      ctx.fill();
    });

    const step = Math.max(1, Math.ceil(n / 8));
    ctx.fillStyle = C.muted;
    ctx.font = '10px "JetBrains Mono", monospace';
    rotulos.forEach((r, i) => {
      if (i % step) return;
      ctx.fillText(r, pts[i].x - ctx.measureText(r).width / 2, padT + h + 16);
    });
  }

  /* ---------- barras empilhadas por plano (plataforma) ---------- */
  function desenharPlanos(cv, planos) {
    const { ctx, cw, ch } = prepCanvas(cv);
    const padL = 34, padR = 6, padT = 12, padB = 26;
    const w = cw - padL - padR, h = ch - padT - padB;
    const comPlano = planos.filter(p => p.total > 0);
    const max = Math.max.apply(null, comPlano.map(p => p.total).concat([1]));
    const maxRounded = arredondarEixo(max);
    gradeHorizontal(ctx, cw, padL, padT, w, h, maxRounded);

    if (!comPlano.length) {
      ctx.fillStyle = C.muted;
      ctx.font = '13px "Work Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Nenhuma assinatura ativa ainda.', cw / 2, ch / 2);
      ctx.textAlign = 'start';
      return;
    }

    const n = comPlano.length;
    const slot = w / n;
    const bw = Math.max(10, Math.min(slot * 0.6, 44));

    comPlano.forEach((p, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const bh = (p.total / maxRounded) * h;
      const y0 = padT + h;
      const segs = [
        { n: p.ativas, cor: C.success },
        { n: p.trial, cor: C.brass },
        { n: p.canceladas, cor: C.danger }
      ];
      let y = y0;
      segs.forEach(s => {
        if (!s.n) return;
        const sh = Math.round((s.n / p.total) * bh);
        if (sh < 3) return;
        y -= sh;
        ctx.fillStyle = s.cor;
        if (typeof ctx.roundRect === 'function' && s.n === p.ativas) {
          ctx.beginPath(); ctx.roundRect(x, y, bw, sh, 3); ctx.fill();
        } else {
          ctx.fillRect(x, y, bw, sh);
        }
      });
      if (bh > 4) {
        ctx.fillStyle = C.paper;
        ctx.font = '9px "JetBrains Mono", monospace';
        ctx.fillText(String(p.total), x + (bw - ctx.measureText(String(p.total)).width) / 2, y0 - bh + 10);
      }
      ctx.fillStyle = C.muted;
      ctx.font = '10px "JetBrains Mono", monospace';
      const nome = p.name.length > 12 ? p.name.slice(0, 12) + '…' : p.name;
      ctx.fillText(nome, padL + slot * i + (slot - ctx.measureText(nome).width) / 2, padT + h + 16);
    });
  }

  function mensagemVazia(cv, texto) {
    const { ctx, cw, ch } = prepCanvas(cv);
    ctx.fillStyle = C.muted;
    ctx.font = '13px "Work Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(texto, cw / 2, ch / 2);
    ctx.textAlign = 'start';
  }

  function marcarAtualizacao() {
    setText('ult-atual', 'atualizado ' + new Date().toLocaleTimeString('pt-BR'));
  }

  function nossoDolar(v) {
    return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 });
  }

  /* ============================================================
     MODO PLATAFORMA (super-admin)
     ============================================================ */
  async function carregarPlataforma() {
    try {
      const resp = await fetch('/api/super-admin/relatorios', {
        headers: { 'authorization': TOKEN_SA, 'content-type': 'application/json' }
      });
      const json = await resp.json().catch(() => ({ ok: false }));
      if (!json || !json.ok || !json.data) throw new Error('sem acesso');
      renderizarPlataforma(json.data);
      marcarAtualizacao();
    } catch (e) {
      setText('lbl-subtitulo', 'Falha ao carregar dados da plataforma. Verifique o acesso de super-admin.');
    }
  }

  function renderizarPlataforma(d) {
    setText('lbl-eyebrow', 'Análise da plataforma · todas as lojas');
    setText('lbl-subtitulo', 'Números reais de todo o site, em tempo real.');

    const meses = d.meses || [];
    const totais = d.totais || {};
    const serie = s => (s || []).filter(x => x && meses.indexOf(x.mes) >= 0).map(x => x.valor);

    /* cards */
    const clientesSite = (d.series.clientes_por_mes || []).reduce((a, x) => a + x.valor, 0);
    const agendSite = (d.series.uso_por_mes || []).reduce((a, x) => a + x.valor, 0);

    setText('lbl-clientes', 'Clientes na plataforma');
    setText('stat-clientes', clientesSite);
    setDelta('stat-clientes-delta', clientesSite > 0
      ? '+ ' + clientesSite + ' no total · ' + (d.meses.length || 12) + ' meses'
      : 'nenhum cliente cadastrado');

    setText('lbl-agendamentos', 'Agendamentos · plataforma');
    setText('stat-agendamentos', agendSite);
    setDelta('stat-agendamentos-delta',
      'hoje: ' + (totais.agendamentos_hoje || 0) + ' · total: ' + (totais.total_agendamentos || 0));

    const ass = d.assinaturas || {};
    setText('lbl-assinatura', 'Assinaturas ativas');
    setText('stat-assinatura', ass.ativas || 0);
    setDelta('stat-assinatura-delta',
      'trial: ' + (ass.trial || 0) + ' · canceladas: ' + (ass.canceladas || 0) +
      ' · proj. mensal: ' + nossoDolar(ass.receita_mensal_projetada));

    setText('lbl-logins', 'Logins · 30 dias');
    setText('stat-logins', totais.logins_30d || 0);
    setDelta('stat-logins-delta', 'logins na plataforma');

    /* charts */
    setText('lbl-chart-uso', 'Uso da plataforma');
    setText('lbl-chart-uso-sub', 'Agendamentos em todas as lojas (12 meses)');
    const cvUso = document.getElementById('chart-uso');
    if (cvUso) {
      const v = serie(d.series.uso_por_mes);
      desenharBarras(cvUso, meses.map(rotuloMes), v, C.brass);
    }

    setText('lbl-chart-logins', 'Fluxo de logins');
    setText('lbl-chart-logins-sub', 'Logins na plataforma por mês (12 meses)');
    const cvLogins = document.getElementById('chart-logins');
    if (cvLogins) {
      const v = serie(d.series.logins_por_mes);
      desenharLinhas(cvLogins, meses.map(rotuloMes), v, C.success);
    }

    setText('lbl-chart-clientes', 'Novos clientes');
    setText('lbl-chart-clientes-sub', 'Clientes cadastrados no site por mês (12 meses)');
    const cvCx = document.getElementById('chart-clientes');
    if (cvCx) {
      const v = serie(d.series.clientes_por_mes);
      desenharBarras(cvCx, meses.map(rotuloMes), v, C.brassSoft);
    }

    /* assinaturas por plano */
    setText('lbl-planos-sub', 'Quantidade de lojas por plano, com o status de cada assinatura.');
    const cvPlanos = document.getElementById('chart-planos');
    if (cvPlanos) desenharPlanos(cvPlanos, d.planos || []);
    renderTabelaPlanos(d.planos || [], d.sem_plano || 0);
  }

  function renderTabelaPlanos(planos, semPlano) {
    const tbody = document.getElementById('planos-tbody');
    if (!tbody) return;
    const vazio = document.getElementById('planos-vazio');
    if (vazio) vazio.hidden = true;

    const maxTotal = Math.max(1, Math.max.apply(null, planos.map(p => p.total).concat([1])));
    const maisUsado = planos.reduce((a, p) => (p.total > (a ? a.total : 0) ? p : a), null);

    let html = planos.map(p => {
      const pct = Math.round((p.total / maxTotal) * 100);
      const top = maisUsado && p.plan_id === maisUsado.plan_id && p.total > 0;
      return '<tr class="' + (top ? 'plan-top' : '') + '">' +
        '<td>' + (p.name || '—') + (top ? ' <span class="plan-badge">mais usado</span>' : '') + '</td>' +
        '<td>' + nossoDolar(p.price_monthly) + '</td>' +
        '<td>' + p.ativas + '</td>' +
        '<td>' + p.trial + '</td>' +
        '<td>' + p.canceladas + '</td>' +
        '<td><div class="plan-total"><span style="width:' + pct + '%"></span></div>' + p.total + '</td>' +
        '</tr>';
    }).join('');

    const totalGeral = planos.reduce((a, p) => a + p.total, 0);
    html += '<tr class="plan-final">' +
      '<td>Total (com plano)</td><td>—</td>' +
      '<td>' + planos.reduce((a, p) => a + p.ativas, 0) + '</td>' +
      '<td>' + planos.reduce((a, p) => a + p.trial, 0) + '</td>' +
      '<td>' + planos.reduce((a, p) => a + p.canceladas, 0) + '</td>' +
      '<td>' + totalGeral + '</td></tr>';

    if (semPlano > 0) {
      html += '<tr class="plan-final"><td>Sem plano</td><td>—</td><td colspan="4">' + semPlano + ' loja(s) sem assinatura</td></tr>';
    }
    tbody.innerHTML = html;
  }

  /* ============================================================
     MODO SALÃO (dono/profissional)
     ============================================================ */
  let stats = null;
  let logs = [];
  let assinatura = null;
  let clientes = [];
  let planos = [];

  /* Relatório (RF-070): a resposta vem filtrada pelo backend conforme
     o plano (todos os planos pagos liberam o nível completo). O frontend
     apenas renderiza os campos que chegaram. */
  let relatorio = null;
  let relatorioErro = null;
  let relatorioDiario = null;
  let relatorioDiarioErro = null;

  function consultarTudo() {
    try { stats = API.dashboardStats('year'); } catch (e) { stats = null; }
    try { logs = API.meusLogsDeAcesso() || []; } catch (e) { logs = []; }
    try { assinatura = API.minhaAssinatura(); } catch (e) { assinatura = null; }
    relatorio = null;
    relatorioErro = null;
    try { relatorio = API.gerarRelatorio('year'); } catch (e) { relatorioErro = e; }
    relatorioDiario = null;
    relatorioDiarioErro = null;
    try { relatorioDiario = API.gerarRelatorioDiario(); } catch (e) { relatorioDiarioErro = e; }
    planos = [];
    try { planos = API.listarPlanos() || []; } catch (e) { planos = []; }
    clientes = [];
    try {
      for (let p = 1; p <= 10; p++) {
        const r = API.listarClientes({ page: p, limit: 200 });
        clientes = clientes.concat(r.items || []);
        if (!r.items || r.items.length < r.limit) break;
      }
    } catch (e) { /* sem acesso às listas */ }
  }

  function prepararModoSalao() {
    /* O card "Assinaturas por plano" é dado de plataforma (super-admin).
       Para o dono ele não existe: é removido por completo e a linha
       colapsa para 1 coluna, deixando "Novos clientes" na largura toda. */
    const cardPlanos = document.getElementById('card-planos');
    if (cardPlanos && cardPlanos.parentNode) cardPlanos.parentNode.removeChild(cardPlanos);
    const row = document.getElementById('row-clientes-planos');
    if (row) row.style.gridTemplateColumns = '1fr';

    const tabs = document.getElementById('rel-tabs');
    if (tabs) tabs.hidden = false;
  }

  /* ---------- cards do relatório escalonado ---------- */
  function criarCard(label, valor, delta) {
    const card = document.createElement('div');
    card.className = 'card';
    const lbl = document.createElement('span');
    lbl.className = 'stat-label';
    lbl.textContent = label;
    const v = document.createElement('div');
    v.className = 'stat-value';
    v.textContent = valor;
    card.appendChild(lbl);
    card.appendChild(v);
    if (delta != null && delta !== '') {
      const d = document.createElement('div');
      d.className = 'stat-delta';
      d.textContent = delta;
      card.appendChild(d);
    }
    return card;
  }

  function criarTituloSecao(texto) {
    const h = document.createElement('h3');
    h.className = 'section-title';
    h.textContent = texto;
    return h;
  }

  /* Tabela de horários de pico (todos os planos pagos) */
  function criarTabelaHorariosPico(faixas) {
    const table = document.createElement('table');
    table.className = 'plans-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Faixa</th><th>Agendamentos</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    faixas.forEach(h => {
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.textContent = h.faixa;
      const td2 = document.createElement('td');
      td2.textContent = h.count;
      tr.appendChild(td1);
      tr.appendChild(td2);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* Exporta CSV dos valores já liberados pelo backend (client-side) */
  function exportarCSVRelatorio(dados) {
    const linhas = [
      ['Métrica', 'Valor'],
      ['Faturamento Total', nossoDolar(dados.faturamento)],
      ['Total Agendamentos', dados.totalAgendamentos !== undefined ? dados.totalAgendamentos : '-'],
      ['Ticket Médio', dados.ticketMedio !== undefined ? nossoDolar(dados.ticketMedio) : '-'],
      ['Semana — início', (dados.semanal && dados.semanal.inicio) || '-'],
      ['Semana — fim', (dados.semanal && dados.semanal.fim) || '-'],
      ['Semana — faturamento', dados.semanal ? nossoDolar(dados.semanal.faturamento) : '-'],
      ['Semana — delta %', (dados.semanal && dados.semanal.delta_faturamento_pct != null) ? dados.semanal.delta_faturamento_pct : '-'],
      ['Mês', (dados.mensal && dados.mensal.mes) || '-'],
      ['Mês — faturamento', dados.mensal ? nossoDolar(dados.mensal.faturamento) : '-'],
      ['Mês — delta %', (dados.mensal && dados.mensal.delta_faturamento_pct != null) ? dados.mensal.delta_faturamento_pct : '-'],
      ['Melhor dia', (dados.melhorDia && dados.melhorDia.data) || '-'],
      ['Melhor dia — faturamento', dados.melhorDia ? nossoDolar(dados.melhorDia.faturamento) : '-'],
      ['Serviço Mais Realizado', (dados.servicoMaisRealizado && dados.servicoMaisRealizado.nome) || '-'],
      ['Profissional Mais Rentável', (dados.profissionalMaisRentavel && dados.profissionalMaisRentavel.nome) || '-']
    ];
    (dados.horariosPico || []).forEach(h => {
      linhas.push(['Pico ' + h.faixa, h.count]);
    });
    const csv = linhas.map(l => l.map(String).join(';')).join('\r\n');
    const nome = 'relatorio-' + (dados.start_date || new Date().toISOString().slice(0, 10)) + '.csv';
    if (dados.atendimentosDetalhados && dados.atendimentosDetalhados.length) {
      const detalhe = dados.atendimentosDetalhados.map(a =>
        [a.data, a.hora, a.cliente, a.profissional, a.servicos, nossoDolar(a.valor)].join(';'));
      const bloco = [['Data', 'Hora', 'Cliente', 'Profissional', 'Serviços', 'Valor'].join(';')].concat(detalhe);
      baixarArquivo(nome, '\uFEFF' + [csv].concat(bloco).join('\r\n'));
      return;
    }
    baixarArquivo(nome, '\uFEFF' + csv);
  }

  /* Exporta um relatório específico já liberado pelo plano (fail-closed) */
  function exportarCSVRelatorioPorTipo(chave) {
    const dados = relatorio;
    if (!dados || relatorioErro) return;
    const q = (v) => String(v == null ? '' : v);
    const hoje = String(dados.end_date || new Date().toISOString().slice(0, 10));
    let blocos = [];
    let nome = 'relatorio-' + hoje + '.csv';
    switch (chave) {
      case 'semanal': {
        const s = dados.semanal;
        nome = 'relatorio-semanal-' + (s && s.fim || hoje) + '.csv';
        blocos.push(['Métrica', 'Valor']);
        if (s) {
          blocos.push(['Semana — início', q(s.inicio)], ['Semana — fim', q(s.fim)],
            ['Faturamento', nossoDolar(s.faturamento)],
            ['Agendamentos concluídos', q(s.agendamentos ?? '')],
            ['Delta vs semana anterior (%)', s.delta_faturamento_pct == null ? '—' : q(s.delta_faturamento_pct)]);
        }
        break;
      }
      case 'mensal': {
        const m = dados.mensal;
        nome = 'relatorio-mensal-' + ((m && m.mes) || hoje) + '.csv';
        blocos.push(['Métrica', 'Valor']);
        if (m) {
          blocos.push(['Mês', q(m.mes)], ['Período', q(m.inicio) + ' a ' + q(m.fim)],
            ['Faturamento', nossoDolar(m.faturamento)],
            ['Agendamentos concluídos', q(m.agendamentos ?? '')],
            ['Delta vs mês anterior (%)', m.delta_faturamento_pct == null ? '—' : q(m.delta_faturamento_pct)]);
        }
        break;
      }
      case 'melhorDia': {
        nome = 'relatorio-melhor-dia-' + ((dados.melhorDia && dados.melhorDia.data) || hoje) + '.csv';
        blocos.push(['Métrica', 'Valor']);
        if (dados.melhorDia) {
          blocos.push(['Melhor dia', q(dados.melhorDia.data)],
            ['Faturamento', nossoDolar(dados.melhorDia.faturamento)],
            ['Agendamentos', q(dados.melhorDia.agendamentos ?? '')]);
        }
        blocos.push([], ['Dia', 'Faturamento', 'Agendamentos']);
        (dados.melhorDiaSerie || []).forEach(d =>
          blocos.push([q(d.data), nossoDolar(d.faturamento), q(d.agendamentos ?? '')]));
        break;
      }
      case 'detalhado': {
        const lista = dados.atendimentosDetalhados || [];
        nome = 'relatorio-detalhado-' + hoje + '.csv';
        blocos.push(['Data', 'Hora', 'Cliente', 'Profissional', 'Serviços', 'Valor']);
        lista.forEach(a =>
          blocos.push([q(a.data), q(a.hora), q(a.cliente), q(a.profissional), q(a.servicos), nossoDolar(a.valor)]));
        break;
      }
      default:
        return;
    }
    var csv = '';
    for (var i = 0; i < blocos.length; i++) {
      if (blocos[i].length) csv += blocos[i].map(q).join(';') + '\r\n';
    }
    baixarArquivo(nome, '\uFEFF' + csv);
  }

  /* Aba RELATÓRIOS — gráficos reais calculados a partir dos dados do salão */
  function renderizarRelatorios() {
    const container = document.getElementById('pt-relatorios');
    if (!container) return;
    container.innerHTML = '';

    if (relatorioErro || !relatorio || !relatorio.nivel) {
      const motivo = relatorioErro && (relatorioErro.error || relatorioErro.message);
      container.innerHTML = motivo
        ? '<div class="rel-block-note">' + esc(motivo) +
          ' <a href="/assinatura">Ver planos</a></div>'
        : '<div class="rel-block-note">Relatórios estão bloqueados no seu plano. ' +
          'Assine ou faça upgrade na aba <a href="/assinatura">Assinatura</a> para liberar.</div>';
      return;
    }

    let desenhou = false;

    /* Faturamento por mês (agrega a série diária do período) */
    const serie = relatorio.melhorDiaSerie || [];
    if (serie.length) {
      const porMes = {};
      serie.forEach(d => {
        const k = String(d.data || '').slice(0, 7);
        if (!k) return;
        porMes[k] = (porMes[k] || 0) + Number(d.faturamento || 0);
      });
      const chaves = Object.keys(porMes).sort().slice(-12);
      const rot = chaves.map(rotuloMes);
      const val = chaves.map(k => Math.round(porMes[k] * 100) / 100);
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Faturamento por mês'));
      const cv = document.createElement('canvas');
      cv.className = 'chart-box chart-box-chart';
      card.appendChild(cv);
      container.appendChild(card);
      desenharBarras(cv, rot, val, C.brass);
      desenhou = true;
    }

    /* Atendimentos por faixa de horário (dados reais do período) */
    const pico = relatorio.horariosPico || [];
    if (pico.length) {
      const ordenado = pico.slice().sort((a, b) => String(a.faixa).localeCompare(String(b.faixa)));
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Atendimentos por faixa de horário'));
      const cv = document.createElement('canvas');
      cv.className = 'chart-box chart-box-chart';
      card.appendChild(cv);
      container.appendChild(card);
      desenharBarras(cv, ordenado.map(p => p.faixa), ordenado.map(p => p.count), C.brassSoft);
      desenhou = true;
    }

    if (!desenhou) {
      const nota = document.createElement('p');
      nota.className = 'chart-caption';
      nota.textContent = 'Ainda não há faturamento concluído no período para exibir gráficos. ' +
        'Eles aparecem automaticamente conforme os atendimentos forem concluídos.';
      container.appendChild(nota);
    }
  }

  /* [SEGURANÇA] Renderiza APENAS os campos que o backend liberou
     para o plano (fail-closed). Plano sem assinatura recebe o banner. */
  function renderizarRelatorio() {
    const container = document.getElementById('pt-geral');
    if (!container) return;
    container.innerHTML = '';
    if (relatorioErro || !relatorio || !relatorio.nivel) {
      const motivo = relatorioErro && (relatorioErro.error || relatorioErro.message);
      container.innerHTML = motivo
        ? '<div class="rel-block-note">' + esc(motivo) +
          ' <a href="/assinatura">Ver planos</a></div>'
        : '<div class="rel-block-note">Relatórios estão bloqueados no seu plano. ' +
          'Assine ou faça upgrade na aba <a href="/assinatura">Assinatura</a> para liberar.</div>';
      return;
    }
    const dados = relatorio;

    const grade = document.createElement('div');
    grade.className = 'card-row cols-2';

    grade.appendChild(criarCard('Faturamento Total', nossoDolar(dados.faturamento),
      'período: ' + dados.start_date + ' a ' + dados.end_date));

    if (dados.totalAgendamentos !== undefined) {
      grade.appendChild(criarCard('Total de Agendamentos', dados.totalAgendamentos,
        'agendamentos concluídos no período'));
    }

    if (dados.semanal) {
      grade.appendChild(criarCard('Semana atual (resultado)', nossoDolar(dados.semanal.faturamento),
        dados.semanal.delta_faturamento_pct == null
          ? 'semana anterior sem faturamento'
          : (dados.semanal.delta_faturamento_pct >= 0 ? '+' : '') +
            dados.semanal.delta_faturamento_pct + '% vs semana anterior'));
    }

    if (dados.ticketMedio !== undefined) {
      grade.appendChild(criarCard('Ticket Médio', nossoDolar(dados.ticketMedio),
        'faturamento ÷ agendamentos'));
    }

    if (dados.mensal) {
      grade.appendChild(criarCard('Resultado mensal (' + dados.mensal.mes + ')',
        nossoDolar(dados.mensal.faturamento),
        (dados.mensal.delta_faturamento_pct == null
          ? 'mês anterior sem faturamento'
          : (dados.mensal.delta_faturamento_pct >= 0 ? '+' : '') +
            dados.mensal.delta_faturamento_pct + '% vs ' + dados.mensal.mes_anterior) +
          ' · ' + dados.mensal.agendamentos + ' atendimento(s)'));
    }

    container.appendChild(grade);

    /* Gráfico do dia com mais lucro (Salão e superiores) */
    if (dados.melhorDia && dados.melhorDiaSerie && dados.melhorDiaSerie.length) {
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Dia com mais lucro'));
      const nota = document.createElement('p');
      nota.className = 'chart-caption';
      nota.textContent = 'Melhor dia: ' + dados.melhorDia.data.slice(8, 10) + '/' +
        dados.melhorDia.data.slice(5, 7) + ' — ' + nossoDolar(dados.melhorDia.faturamento) +
        ' (' + dados.melhorDia.agendamentos + ' atendimento(s)).';
      card.appendChild(nota);
      const cv = document.createElement('canvas');
      cv.id = 'melhor-dia-chart';
      cv.className = 'chart-box chart-box-chart';
      card.appendChild(cv);
      container.appendChild(card);
      requestAnimationFrame(() => {
        const serie = dados.melhorDiaSerie;
        desenharBarras(cv,
          serie.map(d => d.data.slice(8, 10) + '/' + d.data.slice(5, 7)),
          serie.map(d => d.faturamento), C.brass);
      });
    }

    /* Bloco completo de relatórios (todos os planos pagos) */
    if (dados.servicoMaisRealizado) {
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Serviço Mais Realizado'));
      card.appendChild(criarCard(dados.servicoMaisRealizado.nome,
        dados.servicoMaisRealizado.count + ' atendimento(s)', ''));
      container.appendChild(card);
    }
    if (dados.profissionalMaisRentavel) {
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Profissional Mais Rentável'));
      card.appendChild(criarCard(dados.profissionalMaisRentavel.nome,
        nossoDolar(dados.profissionalMaisRentavel.receita) + ' em ' +
        dados.profissionalMaisRentavel.atendimentos + ' atendimento(s)', ''));
      container.appendChild(card);
    }

    if (dados.comparacaoPeriodos) {
      const cmp = dados.comparacaoPeriodos;
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Comparação com período anterior'));
      card.appendChild(criarCard('Faturamento', nossoDolar(cmp.faturamento_anterior),
        cmp.delta_faturamento_pct == null
          ? 'período anterior sem faturamento'
          : (cmp.delta_faturamento_pct >= 0 ? '+' : '') + cmp.delta_faturamento_pct + '% vs anterior'));
      card.appendChild(criarCard('Agendamentos', cmp.agendamentos_anterior,
        cmp.delta_agendamentos_pct == null
          ? 'período anterior sem agendamentos'
          : (cmp.delta_agendamentos_pct >= 0 ? '+' : '') + cmp.delta_agendamentos_pct + '% vs anterior'));
      container.appendChild(card);
    }

    if (dados.atendimentosDetalhados && dados.atendimentosDetalhados.length) {
      const card = document.createElement('div');
      card.className = 'card';
      card.appendChild(criarTituloSecao('Atendimentos detalhados — o cliente de cada corte'));
      card.appendChild(criarTabelaDetalhes(dados.atendimentosDetalhados));
      container.appendChild(card);
    }

    /* Exportar CSV — liberado para todos os planos pagos */
    if (dados.exportar_csv) {
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;';
      const strong = document.createElement('strong');
      strong.textContent = 'Exportar dados do relatório';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-brass';
      btn.textContent = 'Exportar CSV';
      btn.onclick = () => exportarCSVRelatorio(dados);
      card.appendChild(strong);
      card.appendChild(btn);
      container.appendChild(card);
    }
  }

  function criarTabelaDetalhes(itens) {
    const table = document.createElement('table');
    table.className = 'rel-table';
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Data</th><th>Hora</th><th>Cliente</th><th>Profissional</th><th>Serviços</th><th>Valor</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    itens.forEach(a => {
      const tr = document.createElement('tr');
      const val = (t) => { const td = document.createElement('td'); td.textContent = t; return td; };
      tr.appendChild(val(a.data));
      tr.appendChild(val(a.hora));
      tr.appendChild(val(a.cliente));
      tr.appendChild(val(a.profissional));
      tr.appendChild(val(a.servicos));
      const tv = val(nossoDolar(a.valor));
      tv.className = 'mono';
      tr.appendChild(tv);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  /* Aba DIÁRIO (00:00) — padrão de todos os planos pagos */
  function renderizarRelatorioDiario() {
    const container = document.getElementById('pt-diario');
    if (!container) return;
    container.innerHTML = '';
    if (relatorioDiarioErro || !relatorioDiario) {
      const motivo = relatorioDiarioErro && (relatorioDiarioErro.error || relatorioDiarioErro.message);
      container.innerHTML = motivo
        ? '<div class="rel-block-note">' + esc(motivo) +
          ' <a href="/assinatura">Ver planos</a></div>'
        : '<div class="rel-block-note">O relatório diário (00:00) faz parte dos planos pagos. ' +
          'Assine um plano na aba <a href="/assinatura">Assinatura</a> para liberar.</div>';
      return;
    }
    const d = relatorioDiario;
    const nota = document.createElement('p');
    nota.className = 'rel-block-note';
    nota.textContent = d.gerado_em
      ? 'Gerado automaticamente às 00:00 (' + String(d.gerado_em).slice(0, 10) + '). Resultado padrão de todos os planos.'
      : 'Snapshot das 00:00 ainda não gerado hoje — mostrando o cálculo em tempo real.';
    container.appendChild(nota);

    const grade = document.createElement('div');
    grade.className = 'card-row cols-3';
    grade.appendChild(criarCard('Faturamento do dia ' + d.data.slice(8, 10) + '/' + d.data.slice(5, 7),
      nossoDolar(d.faturamento), 'lucro do dia (cortes concluídos)'));
    grade.appendChild(criarCard('Atendimentos', d.agendamentos,
      'cortes concluídos no dia'));
    grade.appendChild(criarCard('Ticket médio', nossoDolar(d.ticket),
      d.faixa_pico ? 'pico: ' + d.faixa_pico : 'sem pico identificado'));
    container.appendChild(grade);
  }

  /* Aba HORÁRIOS — horários de pico (todos os planos pagos) */
  function renderizarHorarios() {
    const container = document.getElementById('pt-horarios');
    if (!container) return;
    container.innerHTML = '';
    const faixas = (relatorio && relatorio.horariosPico) || [];
    if (relatorioErro || !relatorio || !relatorio.nivel || !faixas.length) {
      const motivo = relatorioErro && (relatorioErro.error || relatorioErro.message);
      container.innerHTML = motivo
        ? '<div class="rel-block-note">' + esc(motivo) +
          ' <a href="/assinatura">Ver planos</a></div>'
        : '<div class="rel-block-note">Sem dados de horários de pico no período. ' +
          'Conclua atendimentos para visualizar as faixas mais movimentadas. ' +
          'Na dúvida, veja os detalhes na aba <a href="/assinatura">Assinatura</a>.</div>';
      return;
    }
    const card = document.createElement('div');
    card.className = 'card';
    card.appendChild(criarTituloSecao('Horários de pico'));
    const sub = document.createElement('p');
    sub.className = 'chart-caption';
    sub.textContent = 'Faixas de 1h com mais atendimentos concluídos no período.';
    card.appendChild(sub);
    card.appendChild(criarTabelaHorariosPico(faixas));
    container.appendChild(card);
  }

  /* Aba BENEFÍCIOS — mostra o que cada plano proporciona */
  function renderizarBeneficios() {
    const container = document.getElementById('pt-beneficios');
    if (!container) return;
    container.innerHTML = '';
    const efetivo = assinatura && assinatura.plano_efetivo;
    const atualId = efetivo ? efetivo.id : null;
    const titulo = document.createElement('h3');
    titulo.className = 'section-title';
    titulo.textContent = efetivo
      ? 'O que o seu plano inclui (' + esc(efetivo.name) + ')'
      : 'O que cada plano inclui';
    container.appendChild(titulo);

    if (efetivo && efetivo.relatorios_resumo && efetivo.relatorios_resumo.length) {
      const ul = document.createElement('ul');
      ul.className = 'rel-beneficio-list';
      efetivo.relatorios_resumo.forEach(t => {
        const li = document.createElement('li');
        li.textContent = t;
        ul.appendChild(li);
      });
      container.appendChild(ul);
    }

    if (!planos.length) return;
    const compare = document.createElement('h4');
    compare.className = 'section-title';
    compare.style.cssText = 'margin-top:22px;';
    compare.textContent = 'Compare os planos';
    container.appendChild(compare);

    const ordenados = planos.slice().sort((a, b) => a.price_monthly - b.price_monthly);
    ordenados.forEach(p => {
      const bloco = document.createElement('div');
      bloco.className = 'rel-plano-mini' + (String(p.id) === String(atualId) ? ' atual' : '');
      const nome = document.createElement('h4');
      nome.textContent = esc(p.name) + (String(p.id) === String(atualId) ? '  (seu plano)' : '');
      bloco.appendChild(nome);
      const preco = document.createElement('div');
      preco.className = 'rel-plano-preco';
      const limite = p.max_professionals == null
        ? 'Profissionais ilimitados'
        : (p.max_professionals > 0 ? 'Até ' + p.max_professionals + ' profissional(is)' : 'Perfil da loja');
      preco.textContent = nossoDolar(p.price_monthly) + '/mês · ' + limite;
      bloco.appendChild(preco);
      const ul = document.createElement('ul');
      ul.className = 'rel-beneficio-list';
      const resumo = (p && p.relatorios_resumo) || [];
      resumo.concat(p.features || []).forEach(t => {
        const li = document.createElement('li');
        li.textContent = t;
        ul.appendChild(li);
      });
      bloco.appendChild(ul);
      container.appendChild(bloco);
    });
  }

  function ativarAba(nome) {
    const tabs = document.querySelectorAll('#rel-tabs .rel-tab');
    tabs.forEach(tb => tb.classList.toggle('active', tb.dataset.tab === nome));
    ['diario', 'geral', 'horarios', 'relatorios', 'beneficios'].forEach(id => {
      const el = document.getElementById('pt-' + id);
      if (el) el.hidden = (id !== nome);
    });
  }

  function renderizarSalao() {
    const meses = ultimosMeses(12);

    renderizarRelatorio();
    renderizarRelatorioDiario();
    renderizarHorarios();
    renderizarRelatorios();
    renderizarBeneficios();

    const totalClientes = clientes.length;
    const clientesPorMes = {};
    clientes.forEach(c => {
      const k = String(c.created_at || '').slice(0, 7);
      if (k) clientesPorMes[k] = (clientesPorMes[k] || 0) + 1;
    });
    const novosAno = agregarPorMes(clientesPorMes, meses).reduce((a, b) => a + b, 0);

    const usoPorDia = (stats && stats.series_by_day) || {};
    const usoPorMes = {};
    Object.keys(usoPorDia).forEach(day => {
      const k = day.slice(0, 7);
      usoPorMes[k] = (usoPorMes[k] || 0) + usoPorDia[day];
    });
    const totalUso = Object.values(usoPorMes).reduce((a, b) => a + b, 0);

    const logins = logs.filter(l => String(l.acao || '').indexOf('login') === 0);
    const loginsPorDia = {};
    logins.forEach(l => {
      const k = String(l.timestamp || '').slice(0, 10);
      if (k) loginsPorDia[k] = (loginsPorDia[k] || 0) + 1;
    });
    const totalLogins = logins.length;

    setText('stat-clientes', totalClientes);
    setDelta('stat-clientes-delta', novosAno + ' novo(s) nos últimos 12 meses');

    setText('stat-agendamentos', totalUso);
    if (stats && stats.summary) {
      setDelta('stat-agendamentos-delta',
        stats.summary.concluded + ' concluído(s) · ' +
        stats.summary.cancelled + ' cancelado(s) · ' +
        stats.summary.completion_rate_pct + '% de conclusão');
    } else {
      setDelta('stat-agendamentos-delta', 'sem dados no período');
    }

    if (assinatura) {
      const plano = assinatura.plan ? assinatura.plan.name : '—';
      let status = String(assinatura.status || '');
      if (status === 'trial') status = 'Trial';
      setText('stat-assinatura', plano + (status ? ' · ' + status : ''));
      const delta = assinatura.on_trial
        ? (assinatura.days_left_in_trial + ' dia(s) restantes no trial')
        : (status === 'ativa' && assinatura.current_period_end
          ? 'Válida até ' + String(assinatura.current_period_end).slice(0, 10)
          : 'Plano ' + status);
      setDelta('stat-assinatura-delta', delta);
    } else {
      setText('stat-assinatura', '—');
      setDelta('stat-assinatura-delta', 'sem assinatura encontrada');
    }

    setText('stat-logins', totalLogins);
    const melhorDia = Object.keys(loginsPorDia).sort((a, b) => loginsPorDia[b] - loginsPorDia[a])[0];
    setDelta('stat-logins-delta', totalLogins > 0
      ? (melhorDia ? 'Pico: ' + melhorDia.slice(8, 10) + '/' + melhorDia.slice(5, 7) + ' · ' + loginsPorDia[melhorDia] + ' login(s)' : 'últimos 30 dias')
      : 'últimos 30 dias · sem registros');

    const valoresUso = agregarPorMes(usoPorMes, meses);
    const cvUso = document.getElementById('chart-uso');
    if (cvUso) {
      if (totalUso > 0) desenharBarras(cvUso, meses.map(m => m.rotulo), valoresUso, C.brass);
      else mensagemVazia(cvUso, 'Sem agendamentos no período.');
    }

    const dias = ultimosDias(30);
    const valoresLogins = dias.map(d => loginsPorDia[d.key] || 0);
    const cvLogins = document.getElementById('chart-logins');
    if (cvLogins) {
      if (totalLogins > 0) desenharLinhas(cvLogins, dias.map(d => d.rotulo), valoresLogins, C.success);
      else mensagemVazia(cvLogins, 'Sem registros de login no período.');
    }

    const valoresCx = agregarPorMes(clientesPorMes, meses);
    const cvCx = document.getElementById('chart-clientes');
    if (cvCx) {
      if (totalClientes > 0) desenharBarras(cvCx, meses.map(m => m.rotulo), valoresCx, C.brassSoft);
      else mensagemVazia(cvCx, 'Sem clientes cadastrados.');
    }
  }

  /* ============================================================
     INICIALIZAÇÃO
     ============================================================ */
  const intervalo = modoPlataforma ? 30000 : 60000;

  if (modoPlataforma) {
    carregarPlataforma();
    setInterval(carregarPlataforma, intervalo);
  } else {
    prepararModoSalao();
    consultarTudo();
    renderizarSalao();
    marcarAtualizacao();
    ativarAba('diario');
    document.getElementById('rel-tabs')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.rel-tab');
      if (!btn) return;
      renderizarRelatorio();
      renderizarRelatorioDiario();
      renderizarHorarios();
      renderizarRelatorios();
      renderizarBeneficios();
      ativarAba(btn.dataset.tab);
      if (btn.dataset.tab === 'relatorios') renderizarRelatorios();
    });
    setInterval(() => {
      consultarTudo();
      renderizarSalao();
      marcarAtualizacao();
    }, intervalo);
  }

  document.getElementById('btn-atualizar')?.addEventListener('click', () => {
    if (modoPlataforma) carregarPlataforma();
    else { consultarTudo(); renderizarSalao(); }
    marcarAtualizacao();
    showToast('Relatório atualizado.');
  });

  let timerRedraw = null;
  window.addEventListener('resize', () => {
    clearTimeout(timerRedraw);
    timerRedraw = setTimeout(() => {
      if (modoPlataforma) carregarPlataforma();
      else renderizarSalao();
    }, 150);
  });
});
