/* ============================================================
   Corte Comigo – public/js/catalogo.js
   Catálogo público com busca server-like (RF-050..054) + paginação.
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('grid-saloes');
  const estadoVazio = document.getElementById('estado-vazio');
  const busca = document.getElementById('busca-salao');
  const filtroCidade = document.getElementById('filtro-cidade');
  const filtroServico = document.getElementById('filtro-servico');
  const sugestoesBox = document.getElementById('sugestoes');
  const pagination = document.getElementById('pagination');
  if (!grid) return;

  let currentPage = 1;
  const LIMIT = 12;

  function intAbreviado(n) {
    n = Number(n || 0);
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.', ',') + ' mil';
    return String(n);
  }

  function cardLoja(l) {
    const capa = l.logo_url || l.cover_url;
    const capaStyle = capa ? ' style="background:#000 url("' + esc(capa) + '") center/cover no-repeat;"' : '';
    const tags = (l.tags || []).map(t => '<span class="tag">' + esc(t) + '</span>').join('');
    const match = l.type === 'service' && l.matched_service
      ? '<div class="salon-match">Serviço: <strong>' + esc(l.matched_service.name) + '</strong></div>'
      : (l.type === 'professional' && l.matched_professional
        ? '<div class="salon-match">Profissional: <strong>' + esc(l.matched_professional.name) + '</strong></div>'
        : '');
    const rating = Number(l.rating_avg || 0).toFixed(1);
    const stats = [
      l.views ? intAbreviado(l.views) + ' visualizações' : '',
      l.total_agendamentos ? intAbreviado(l.total_agendamentos) + ' agendamentos' : ''
    ].filter(Boolean).join(' · ');

    return '<a href="/salao?id=' + l.id + '" class="salon-card">' +
      '<div class="salon-card-cover"' + capaStyle + '></div>' +
      '<div class="salon-card-body">' +
        '<div class="salon-name">' + esc(l.name) + '</div>' +
        '<div class="salon-meta"><span class="rating">★ ' + rating + '</span>' +
          (l.rating_count ? ' (' + l.rating_count + ')' : '') +
          ' · ' + esc((l.city || 'Cidade não informada') + (l.uf ? ', ' + l.uf : '')) + '</div>' +
        (stats ? '<div class="salon-stats">' + esc(stats) + '</div>' : '') +
        match +
        '<div class="tag-list">' + tags + '</div>' +
        '<span class="btn btn-outline">Ver barbearia</span>' +
      '</div>' +
    '</a>';
  }

  /* ---------- filtros dinâmicos (cidades e serviços reais) ---------- */
  function popularFiltros() {
    let lojas = [];
    try { lojas = API.buscar({ type: 'shops', limit: 100 }).items; } catch (e) { return; }

    if (filtroCidade) {
      const cidades = Array.from(new Set(
        lojas.filter(l => l.city).map(l => JSON.stringify({ city: l.city.toLowerCase(), label: l.city + (l.uf ? ', ' + l.uf : '') }))
      )).map(s => JSON.parse(s)).sort((a, b) => a.label.localeCompare(b.label));

      filtroCidade.innerHTML = '<option value="">Todas as cidades</option>' +
        cidades.map(c => '<option value="' + esc(c.city) + '">' + esc(c.label) + '</option>').join('');
    }

    if (filtroServico) {
      const nomes = new Set();
      lojas.forEach(l => (l.tags || []).forEach(t => nomes.add(t)));
      try {
        API.servicosPublicos().forEach(s => nomes.add(s.name));
      } catch (e) { /* noop */ }
      const ordenados = Array.from(nomes).sort((a, b) => a.localeCompare(b));
      filtroServico.innerHTML = '<option value="">Todos os serviços</option>' +
        ordenados.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    }
  }

  /* ---------- listagem ---------- */
  function render() {
    const termo = busca?.value.trim() || '';
    const cidade = filtroCidade?.value || '';
    const servico = filtroServico?.value || '';

    let res;
    try {
      res = API.buscar({
        type: servico ? 'services' : 'shops',
        q: servico || termo,
        city: cidade,
        limit: LIMIT,
        page: currentPage,
        sort: termo ? 'relevance' : 'rating'
      });
    } catch (e) {
      showToast(msgErro(e), 'error');
      return;
    }

    grid.innerHTML = res.items.map(cardLoja).join('');
    if (estadoVazio) estadoVazio.style.display = res.items.length ? 'none' : '';

    renderPagination(res.total);
  }

  function renderPagination(total) {
    if (!pagination) return;
    const totalPages = Math.ceil(total / LIMIT);
    if (totalPages <= 1) {
      pagination.innerHTML = '';
      return;
    }

    let html = '';
    // Previous button
    html += '<button class="page-btn" data-page="' + (currentPage - 1) + '"' + (currentPage === 1 ? ' disabled' : '') + '>‹ Anterior</button>';

    // Page numbers (show up to 5 pages centered on current)
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) {
      startPage = Math.max(1, endPage - 4);
    }
    for (let p = startPage; p <= endPage; p++) {
      html += '<button class="page-btn' + (p === currentPage ? ' active' : '') + '" data-page="' + p + '">' + p + '</button>';
    }

    // Next button
    html += '<button class="page-btn" data-page="' + (currentPage + 1) + '"' + (currentPage === totalPages ? ' disabled' : '') + '>Próxima ›</button>';

    pagination.innerHTML = html;

    // Event listeners
    pagination.querySelectorAll('.page-btn:not(.active):not([disabled])').forEach(btn => {
      btn.addEventListener('click', () => {
        currentPage = parseInt(btn.dataset.page, 10);
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  /* ---------- autocomplete (RF-054) ---------- */
  function renderSugestoes() {
    if (!sugestoesBox) return;
    const q = busca.value.trim();
    if (q.length < 2) { sugestoesBox.innerHTML = ''; sugestoesBox.hidden = true; return; }

    let sugs = [];
    try { sugs = API.sugestoes(q).suggestions; } catch (e) { /* noop */ }
    if (!sugs.length) { sugestoesBox.innerHTML = ''; sugestoesBox.hidden = true; return; }

    sugestoesBox.hidden = false;
    sugestoesBox.innerHTML = sugs.map((s, i) =>
      '<button type="button" class="suggestion-item" data-texto="' + esc(s.text) + '">' +
        '<strong>' + esc(s.text) + '</strong>' +
        '<small>' + (s.type === 'service' ? 'Serviço · ' : '') + esc(s.sub || '') + '</small>' +
      '</button>').join('');

    sugestoesBox.querySelectorAll('.suggestion-item').forEach(btn => {
      btn.addEventListener('click', () => {
        busca.value = btn.dataset.texto;
        sugestoesBox.hidden = true;
        currentPage = 1;
        render();
      });
    });
  }

  busca?.addEventListener('input', debounce(() => { renderSugestoes(); currentPage = 1; render(); }, 250));
  busca?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sugestoesBox) sugestoesBox.hidden = true;
  });
  document.addEventListener('click', (e) => {
    if (sugestoesBox && !sugestoesBox.contains(e.target) && e.target !== busca) {
      sugestoesBox.hidden = true;
    }
  });
  filtroCidade?.addEventListener('change', () => { currentPage = 1; render(); });
  filtroServico?.addEventListener('change', () => { currentPage = 1; render(); });

  popularFiltros();
  render();

  /* geolocation: lojas perto de mim (consentimento em banner no rodapé) */
  var btnGeo = document.getElementById('btn-proximas');
  var consentBanner = document.getElementById('consent-banner');
  var CHAVE_GEO = 'cc_geo_consent';
  var CHAVE_GEO_NEGADO = 'cc_geo_negar';

  function buscarLojas() {
    btnGeo.disabled = true;
    btnGeo.textContent = 'Buscando...';
    navigator.geolocation.getCurrentPosition(function(pos) {
      try {
        var res = API.lojasProximas({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          raio: 30
        });
        grid.innerHTML = res.items.map(cardLoja).join('');
        if (estadoVazio) estadoVazio.style.display = res.items.length ? 'none' : '';
        showToast(res.items.length + ' barbearia(s) encontrada(s) perto de você!');
      } catch (e) {
        showToast(msgErro(e), 'error');
      }
      btnGeo.disabled = false;
      btnGeo.textContent = 'Lojas perto de mim';
    }, function(err) {
      showToast('Não foi possível obter sua localização.', 'error');
      btnGeo.disabled = false;
      btnGeo.textContent = 'Lojas perto de mim';
    }, { timeout: 10000 });
  }

  function mostrarBannerConsentimento() {
    if (consentBanner) {
      consentBanner.hidden = false;
      requestAnimationFrame(() => consentBanner.classList.add('show'));
    }
  }

  function esconderBannerConsentimento() {
    if (consentBanner) {
      consentBanner.classList.remove('show');
      setTimeout(() => { consentBanner.hidden = true; }, 300);
    }
  }

  document.getElementById('btn-aceitar-geo')?.addEventListener('click', function() {
    esconderBannerConsentimento();
    localStorage.setItem(CHAVE_GEO, '1');
    buscarLojas();
  });

  document.getElementById('btn-negar-geo')?.addEventListener('click', function() {
    esconderBannerConsentimento();
    localStorage.setItem(CHAVE_GEO_NEGADO, '1');
    showToast('Acesso à localização negado. Use a busca por cidade.', 'error');
  });

  if (btnGeo) {
    btnGeo.addEventListener('click', function() {
      if (!navigator.geolocation) {
        showToast('Geolocalização não suportada.', 'error');
        return;
      }
      if (localStorage.getItem(CHAVE_GEO)) {
        buscarLojas();
      } else if (localStorage.getItem(CHAVE_GEO_NEGADO)) {
        mostrarBannerConsentimento();
      } else {
        mostrarBannerConsentimento();
      }
    });
  }
});