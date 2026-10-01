/* ============================================================
   Corte Comigo – super-admin/js/situacao-sa.js
   Situação do Sistema: health monitoring com classificação
   Requer super-auth.js carregado antes.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {
  if (!saAuth.check()) return;

  var tbodyMetricas = document.getElementById('tbody-metricas');
  var tbodyErros = document.getElementById('tbody-erros');
  var badgeGeral = document.getElementById('status-geral-badge');
  var ultimaAtualizacaoEl = document.getElementById('ultima-atualizacao');
  var btnAtualizar = document.getElementById('btn-atualizar');
  var botoesFiltro = document.querySelectorAll('#sa-filtros .sa-filtro-btn');

  // Resumo cards
  var resumoCards = {
    lojas: document.getElementById('resumo-lojas'),
    ativas: document.getElementById('resumo-ativas'),
    trial: document.getElementById('resumo-trial'),
    expiradas: document.getElementById('resumo-expiradas'),
    usuarios: document.getElementById('resumo-usuarios'),
    agendamentos: document.getElementById('resumo-agendamentos'),
    receita: document.getElementById('resumo-receita')
  };

  var filtroAtual = 'todos';
  var metricasData = [];

  /* ---------- badge helpers ---------- */
  function badgeClassificacao(cls) {
    var map = {
      emergencia: ['badge-emergencia', 'Emergência'],
      problema: ['badge-problema', 'Problema'],
      resolver: ['badge-resolver', 'Resolver'],
      leve: ['badge-leve', 'Leve']
    };
    var par = map[cls] || ['badge-leve', 'Leve'];
    var span = document.createElement('span');
    span.className = 'badge ' + par[0];
    span.textContent = par[1];
    return span;
  }

  function badgeStatusGeral(cls) {
    var map = {
      emergencia: ['badge-emergencia', 'EMERGÊNCIA'],
      problema: ['badge-problema', 'PROBLEMA'],
      resolver: ['badge-resolver', 'ATENÇÃO'],
      leve: ['badge-leve', 'NORMAL']
    };
    var par = map[cls] || ['badge-leve', 'NORMAL'];
    var span = document.createElement('span');
    span.className = 'badge ' + par[0];
    span.textContent = par[1];
    return span;
  }

  function formatarDataBR(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString('pt-BR');
  }

  function formatarMoeda(valor) {
    return 'R$ ' + Number(valor || 0).toFixed(2).replace('.', ',');
  }

  /* ---------- carregar situação ---------- */
  function carregar() {
    fetch('/api/super-admin/situacao', { headers: saAuth.headers() })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { saAuth.logout(); return; }
        return res.json();
      })
      .then(function (data) {
        if (!data || data.error) {
          if (data && data.error) showToast(data.error, 'error');
          return;
        }
        metricasData = data.metricas || [];
        renderResumo(data.resumo || {});
        renderMetricas();
        renderBadgeGeral(data.status_geral || 'leve');
        ultimaAtualizacaoEl.textContent = 'Atualizado: ' + formatarDataBR(data.timestamp);
      })
      .catch(function () {
        showToast('Erro ao carregar situação.', 'error');
      });
  }

  /* ---------- carregar erros recentes ---------- */
  function carregarErros() {
    fetch('/api/super-admin/logs?tipo=erro&horas=24', { headers: saAuth.headers() })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || data.error) return;
        renderErros(data.data || []);
      })
      .catch(function () { /* noop */ });
  }

  function renderResumo(r) {
    if (resumoCards.lojas) resumoCards.lojas.textContent = r.total_lojas || 0;
    if (resumoCards.ativas) resumoCards.ativas.textContent = r.lojas_ativas || 0;
    if (resumoCards.trial) resumoCards.trial.textContent = r.lojas_trial || 0;
    if (resumoCards.expiradas) resumoCards.expiradas.textContent = r.lojas_expiradas || 0;
    if (resumoCards.usuarios) resumoCards.usuarios.textContent = r.usuarios_totais || 0;
    if (resumoCards.agendamentos) resumoCards.agendamentos.textContent = r.agendamentos_hoje || 0;
    if (resumoCards.receita) resumoCards.receita.textContent = formatarMoeda(r.receita_mes_atual);
  }

  function renderMetricas() {
    if (!tbodyMetricas) return;
    var lista = metricasData.filter(function (m) {
      return filtroAtual === 'todos' || m.classificacao === filtroAtual;
    });

    if (!lista.length) {
      tbodyMetricas.innerHTML = '<tr><td colspan="4" class="sa-vazio">Nenhuma métrica encontrada.</td></tr>';
      return;
    }

    tbodyMetricas.innerHTML = '';
    lista.forEach(function (m) {
      var tr = document.createElement('tr');
      tr.style.cursor = 'default';

      var tdNome = document.createElement('td');
      tdNome.style.fontWeight = '600';
      tdNome.textContent = m.nome;

      var tdValor = document.createElement('td');
      tdValor.style.fontFamily = 'monospace';
      tdValor.textContent = m.valor + (m.unidade ? ' ' + m.unidade : '');

      var tdDesc = document.createElement('td');
      tdDesc.style.color = 'var(--text-muted)';
      tdDesc.style.fontSize = '13px';
      tdDesc.textContent = m.descricao;

      var tdClass = document.createElement('td');
      tdClass.appendChild(badgeClassificacao(m.classificacao));

      tr.appendChild(tdNome);
      tr.appendChild(tdValor);
      tr.appendChild(tdDesc);
      tr.appendChild(tdClass);

      // Highlight row by classification
      var colors = {
        emergencia: 'rgba(231, 76, 60, 0.08)',
        problema: 'rgba(243, 156, 18, 0.08)',
        resolver: 'rgba(241, 196, 15, 0.08)',
        leve: 'rgba(39, 174, 96, 0.08)'
      };
      tr.style.backgroundColor = colors[m.classificacao] || 'transparent';

      tbodyMetricas.appendChild(tr);
    });
  }

  function renderBadgeGeral(cls) {
    if (!badgeGeral) return;
    badgeGeral.innerHTML = '';
    badgeGeral.appendChild(badgeStatusGeral(cls));
  }

  function renderErros(logs) {
    if (!tbodyErros) return;
    if (!logs.length) {
      tbodyErros.innerHTML = '<tr><td colspan="3" class="sa-vazio">Nenhum erro nas últimas 24h.</td></tr>';
      return;
    }
    tbodyErros.innerHTML = '';
    logs.slice(0, 50).forEach(function (l) {
      var tr = document.createElement('tr');
      var tdTime = document.createElement('td');
      tdTime.className = 'sa-data';
      tdTime.textContent = formatarDataBR(l.timestamp);
      var tdAcao = document.createElement('td');
      tdAcao.textContent = l.acao || '—';
      var tdExtra = document.createElement('td');
      tdExtra.className = 'sa-msg-trunc';
      tdExtra.textContent = l.extra ? JSON.stringify(l.extra).slice(0, 200) : '—';
      tdExtra.title = l.extra ? JSON.stringify(l.extra) : '';
      tr.appendChild(tdTime);
      tr.appendChild(tdAcao);
      tr.appendChild(tdExtra);
      tbodyErros.appendChild(tr);
    });
  }

  /* ---------- filtros ---------- */
  if (botoesFiltro.length) {
    botoesFiltro.forEach(function (btn) {
      btn.addEventListener('click', function () {
        botoesFiltro.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        filtroAtual = btn.getAttribute('data-filtro');
        renderMetricas();
      });
    });
  }

  if (btnAtualizar) {
    btnAtualizar.addEventListener('click', function () {
      btnAtualizar.disabled = true;
      btnAtualizar.textContent = 'Atualizando...';
      carregar();
      carregarErros();
      setTimeout(function () {
        btnAtualizar.disabled = false;
        btnAtualizar.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg> Atualizar';
      }, 1000);
    });
  }

  /* ---------- auto-refresh a cada 60s ---------- */
  setInterval(function () {
    carregar();
    carregarErros();
  }, 60000);

  /* ---------- logout ---------- */
  var btnSair = document.getElementById('btn-sair');
  if (btnSair) {
    btnSair.addEventListener('click', function (e) {
      e.preventDefault();
      saAuth.logout();
    });
  }

  /* ---------- init ---------- */
  carregar();
  carregarErros();
});