/* ============================================================
   Corte Comigo – public/js/salao-publico.js
   Página pública do salão: funcionamento real (RF-028..031),
   galeria, avaliações e agendamento com slots reais da engine
   + escolha automática de profissional (DT-03/DT-04).
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const lojaId = params.get('id') || '';

  let loja;
  try { loja = API.getLoja(lojaId); }
  catch (e) { window.location.href = '/catalogo'; return; }

  /* contagem de visualização do perfil (exibida discretamente nos
     cards do catálogo) — best-effort, nunca quebra a página */
  try { API.registrarVisualizacao(lojaId); } catch (e) { /* noop */ }

  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

  /* ---------- cabeçalho ---------- */
  document.title = loja.name + ' · Corte Comigo';

  document.getElementById('salao-nome').textContent = loja.name;
  const meta = document.getElementById('salao-meta');
  if (meta) {
    meta.innerHTML =
      '<span class="rating">★ ' + Number(loja.rating_avg || 0).toFixed(1) + '</span>' +
      (loja.rating_count ? ' (' + loja.rating_count + ' avaliações)' : '') +
      ' · ' + esc([loja.address, loja.city && loja.city + (loja.uf ? '/' + loja.uf : '')].filter(Boolean).join(' – ') || 'Endereço não informado') +
      (loja.phone ? ' · <span class="mono">' + esc(loja.phone) + '</span>' : '');
  }
  const tagList = document.getElementById('salao-tags');
  if (tagList) tagList.innerHTML = (loja.tags || []).map(t => '<span class="tag">' + esc(t) + '</span>').join('');

  /* ---------- funcionamento a partir de working_hours (RF-028) ---------- */
  const funcEl = document.getElementById('salao-funcionamento');
  if (funcEl) {
    let linhas = [];
    try { linhas = API.horariosDaLoja(loja.id, true); } catch (e) { /* noop */ }
    const abertos = linhas.filter(l => l.is_open);
    funcEl.innerHTML = abertos.length
      ? agruparHorarios(abertos)
      : '<em>Horários sob consulta</em>';
  }

  function agruparHorarios(abertos) {
    return abertos
      .slice()
      .sort((a, b) => ((a.day_of_week + 6) % 7) - ((b.day_of_week + 6) % 7))
      .map(l => '<div>' + DIAS[l.day_of_week] + ' <span class="mono">' +
        esc(l.start_time) + '–' + esc(l.end_time) +
        (l.lunch_start ? ' (almoço ' + esc(l.lunch_start) + '–' + esc(l.lunch_end) + ')' : '') +
        '</span></div>')
      .join('');
  }

  /* ---------- galeria ---------- */
  let fotos = [];
  try { fotos = API.galeriaDaLoja(loja.id); } catch (e) { /* noop */ }
  const track = document.getElementById('gallery-track');
  if (track) {
    /* sem fotos na galeria, mostra a capa/logo escolhida pelo salão;
       sem nenhuma imagem, aí sim usa o placeholder */
    const capaLoja = loja.logo_url || loja.cover_url; // perfil primeiro
    const slides = fotos.length
      ? fotos
      : (capaLoja ? [{ url: capaLoja }] : [{ url: null }]);
    track.innerHTML = slides.map(f => {
      /* &quot; e obrigatorio: aspas cruas aqui fechariam o atributo style
         no meio da URL e a foto ficaria preta */
      const estilo = f.url
        ? 'background:#000 url(&quot;' + f.url + '&quot;) center/cover no-repeat;'
        : 'background:linear-gradient(135deg,#2c2f36,#4a3f35);';
      return '<div class="gallery-slide"><div class="gallery-photo" style="' + estilo + '"><span>' +
        esc(f.url ? '' : loja.name) + '</span></div></div>';
    }).join('');

    let slide = 0;
    const total = slides.length;
    const counter = document.getElementById('gallery-counter');

    function update() {
      track.style.transform = 'translateX(-' + (slide * 100) + '%)';
      if (counter) counter.textContent = total ? (slide + 1) + ' / ' + total : '0 / 0';
    }
    document.getElementById('gallery-prev')?.addEventListener('click', () => {
      slide = slide > 0 ? slide - 1 : total - 1; update();
    });
    document.getElementById('gallery-next')?.addEventListener('click', () => {
      slide = slide < total - 1 ? slide + 1 : 0; update();
    });
    const viewport = document.getElementById('gallery-viewport');
    let tx = 0;
    viewport?.addEventListener('touchstart', e => { tx = e.changedTouches[0].screenX; }, { passive: true });
    viewport?.addEventListener('touchend', e => {
      const diff = tx - e.changedTouches[0].screenX;
      if (Math.abs(diff) > 50) {
        slide = diff > 0 ? (slide < total - 1 ? slide + 1 : 0) : (slide > 0 ? slide - 1 : total - 1);
        update();
      }
    }, { passive: true });
    update();
  }

  /* ---------- profissionais ---------- */
  let profissionais = [];
  try { profissionais = API.profissionaisDaLoja(loja.id, true); } catch (e) { /* noop */ }
  let horasProf = [];
  try { horasProf = API.horariosDaLoja(loja.id); } catch (e) { /* noop */ }

  const listaProfs = document.getElementById('lista-profissionais-publica');
  if (listaProfs) {
    listaProfs.innerHTML = profissionais.map(p => {
      const dias = horasProf.filter(w => w.professional_id === p.id && w.is_open)
        .map(w => w.day_of_week).sort((a, b) => a - b);
      const linha = horasProf.find(w => w.professional_id === p.id);
      const diasTxt = dias.length
        ? DIAS[dias[0]] + (dias.length > 1 ? '–' + DIAS[dias[dias.length - 1]] : '')
        : '';
      const horarioTxt = linha
        ? diasTxt + ' · ' + linha.start_time + '–' + linha.end_time
        : '';
      return '<div class="prof-card-public">' +
        '<div class="prof-avatar"' +
          (p.color ? ' style="background:' + esc(p.color) + '22;color:' + esc(p.color) + ';border-color:' + esc(p.color) + '66;"' : '') + '>' +
          esc(DB.iniciais(p.name)) + '</div>' +
        '<div>' +
          '<div class="prof-name">' + esc(p.name) + '</div>' +
          (p.bio ? '<div class="prof-role">' + esc(p.bio) + '</div>' : '') +
          (horarioTxt ? '<div class="prof-hours">' + esc(horarioTxt) + '</div>' : '') +
        '</div>' +
      '</div>';
    }).join('') ||
    '<div class="empty-state" style="grid-column:1/-1;"><h3>Agendamento direto com o salão</h3><p>Este salão ainda não cadastrou profissionais — você ainda pode agendar pelos horários do estabelecimento.</p></div>';
  }

  /* ---------- serviços ---------- */
  let servicos = [];
  try { servicos = API.servicosDaLoja(loja.id, true); } catch (e) { /* noop */ }

  const listaSvc = document.getElementById('lista-servicos-publica');
  if (listaSvc) {
    listaSvc.innerHTML = servicos.map(s =>
      '<div class="service-row-public" data-servico-id="' + s.id + '">' +
        '<div>' +
          '<div class="svc-name">' + esc(s.name) +
            (s.category ? ' <small style="color:var(--text-muted)">· ' + esc(s.category) + '</small>' : '') + '</div>' +
          '<div class="svc-duration">' + fmtDuracao(s.duration_min) +
            (s.description ? ' · ' + esc(s.description) : '') + '</div>' +
        '</div>' +
        '<div class="svc-right">' +
          '<span class="svc-price mono">' + DB.fmtBRL(s.price) + '</span>' +
          '<button class="btn btn-brass btn-agendar">Agendar</button>' +
        '</div>' +
      '</div>'
    ).join('') ||
    '<div class="empty-state"><h3>Nenhum serviço cadastrado</h3><p>Este salão ainda não cadastrou serviços.</p></div>';
  }

  /* ---------- avaliações (RF-055) ----------
     Bloco logo após a escolha do profissional: mostra as estrelas do
     salão e a quantidade de comentários já na abertura. Ao clicar,
     abre a lista de comentários e o formulário (clientes logados). */
  const reviewsStars = document.getElementById('reviews-stars');
  const reviewsNota = document.getElementById('reviews-nota');
  const reviewsCount = document.getElementById('reviews-count');
  const toggle = document.getElementById('reviews-toggle');
  const panels = document.getElementById('reviews-panel');

  let reviewsGerais = [];

  function estrelasCheias(nota) {
    const n = Math.max(0, Math.min(5, Math.round(Number(nota) || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  function rotuloToggle() {
    const total = reviewsGerais.length;
    return total
      ? 'Ver ' + total + (total === 1 ? ' avaliação' : ' avaliações') + ' e comentar'
      : 'Ver avaliações e comentar';
  }

  function atualizarResumo() {
    const total = reviewsGerais.length;
    const media = total
      ? reviewsGerais.reduce((s, r) => s + (Number(r.rating) || 0), 0) / total
      : Number(loja.rating_avg || 0);
    if (reviewsStars) reviewsStars.textContent = estrelasCheias(media);
    if (reviewsNota) reviewsNota.textContent = total ? media.toFixed(1) : '—';
    if (reviewsCount) reviewsCount.textContent = total + (total === 1 ? ' comentário' : ' comentários');
    if (toggle && panels && panels.hidden) toggle.textContent = rotuloToggle();
  }

  function carregarReviews() {
    try { reviewsGerais = API.reviewsDaLoja(loja.id); } catch (e) { reviewsGerais = []; }
    atualizarResumo();
  }

  function renderLista() {
    const box = document.getElementById('lista-reviews');
    if (!box) return;
    if (!reviewsGerais.length) {
      box.innerHTML = '<p class="reviews-empty" style="text-align:center; padding:24px; color:var(--text-muted);">Ainda sem avaliações — seja o primeiro a avaliar!</p>';
      return;
    }
    box.innerHTML = reviewsGerais.slice(0, 10).map(r => {
      const n = Math.max(1, Math.min(5, Number(r.rating) || 0));
      const estrelas = '★'.repeat(n) + '☆'.repeat(5 - n);
      return '<div class="review-item" style="border-bottom:1px solid var(--line); padding:16px 0;">' +
        '<div class="review-top" style="display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:8px;">' +
          '<strong style="font-size:15px;">' + esc(r.client_name) + '</strong>' +
          '<span class="rating" style="color:#f5c518; font-size:18px; letter-spacing:2px;">' + estrelas + '</span>' +
          '<small style="color:var(--text-muted); margin-left:auto;">' + DB.fmtDataBR(String(r.created_at).slice(0, 10)) + '</small>' +
        '</div>' +
        (r.comment ? '<p style="color:var(--text); line-height:1.6; margin:0;">' + esc(r.comment) + '</p>' : '') +
      '</div>';
    }).join('');
  }

  function renderFormulario() {
    const boxForm = document.getElementById('review-form-box');
    if (!boxForm) return;
    const u = Auth.usuarioAtual();
    if (!u) {
      boxForm.innerHTML = '<p class="review-convite" style="text-align:center; padding:20px;">' +
        'Já visitou este salão? <a href="/login?next=' + encodeURIComponent('/salao?id=' + loja.id) + '" style="color:var(--brass); font-weight:600;">Entre na sua conta</a> e deixe sua avaliação.' +
        '</p>';
      return;
    }
    boxForm.innerHTML =
      '<h4 class="review-form-title" style="margin-bottom:16px;">Deixe sua avaliação</h4>' +
      '<form class="review-form" id="review-form">' +
        '<div class="review-estrelas" id="review-estrelas" style="display:flex; gap:8px; justify-content:center; margin-bottom:16px;">' +
          [5, 4, 3, 2, 1].map(n =>
            '<button type="button" class="estrela" data-nota="' + n + '" aria-label="' + n + ' estrela(s)" style="font-size:28px; background:none; border:none; color:#ddd; cursor:pointer; transition:transform .15s, color .15s;">★</button>').join('') +
          '<span class="review-valor" id="review-valor" style="margin-left:12px; font-size:14px; color:var(--text-muted); align-self:center;">Toque nas estrelas</span>' +
        '</div>' +
        '<div class="field" style="margin-bottom:16px;">' +
          '<textarea id="review-comentario" rows="4" maxlength="300" placeholder="Como foi sua experiência? O que gostou? O que pode melhorar? (opcional, máx. 300 caracteres)" style="min-height:100px;"></textarea>' +
          '<div class="review-char-count" id="review-char-count" style="text-align:right; font-size:12px; color:var(--text-muted); margin-top:4px;">0/300</div>' +
        '</div>' +
        '<button type="submit" class="btn btn-brass" style="width:100%; padding:14px; font-size:15px;">Enviar avaliação</button>' +
      '</form>';

    const estrelasEl = boxForm.querySelector('#review-estrelas');
    const valorEl = boxForm.querySelector('#review-valor');
    const texto = boxForm.querySelector('#review-comentario');
    const contadorChars = boxForm.querySelector('#review-char-count');
    let nota = 0;

    estrelasEl.querySelectorAll('.estrela').forEach(b => {
      b.addEventListener('click', () => {
        nota = Number(b.dataset.nota);
        estrelasEl.querySelectorAll('.estrela').forEach(x =>
          x.classList.toggle('ativa', Number(x.dataset.nota) <= nota));
        estrelasEl.querySelectorAll('.estrela.ativa').forEach(s => s.style.color = '#f5c518');
        estrelasEl.querySelectorAll('.estrela:not(.ativa)').forEach(s => s.style.color = '#ddd');
        valorEl.textContent = nota + ' de 5';
        valorEl.style.color = '#f5c518';
      });
      b.addEventListener('mouseenter', () => {
        const hoverNota = Number(b.dataset.nota);
        estrelasEl.querySelectorAll('.estrela').forEach(x =>
          x.style.color = Number(x.dataset.nota) <= hoverNota ? '#f5c518' : '#ddd');
      });
      b.addEventListener('mouseleave', () => {
        estrelasEl.querySelectorAll('.estrela').forEach(x =>
          x.style.color = x.classList.contains('ativa') ? '#f5c518' : '#ddd');
      });
    });
    texto.addEventListener('input', () => {
      contadorChars.textContent = texto.value.length + '/300';
    });
    boxForm.querySelector('#review-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!nota) { showToast('Escolha uma nota de 1 a 5 estrelas.', 'error'); return; }
      const comentario = (texto.value || '').trim();
      try {
        API.criarReview(loja.id, { rating: nota, comment: comentario });
        showToast('Avaliação enviada! Obrigado.');
        carregarReviews();
        renderLista();
        renderFormulario();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    });
  }

  carregarReviews();
  if (toggle && !toggle.dataset.ccOn) {
    toggle.dataset.ccOn = '1';
    toggle.addEventListener('click', () => {
      const abrir = panels.hidden;
      if (abrir) {
        carregarReviews();
        renderLista();
        renderFormulario();
      }
      panels.hidden = !abrir;
      toggle.setAttribute('aria-expanded', String(abrir));
      toggle.textContent = abrir ? 'Ocultar avaliações' : rotuloToggle();
    });
  }

  /* ---------- favoritos (UC-15): botão no perfil do salão ---------- */
  const btnFavoritar = document.getElementById('btn-favoritar');
  if (btnFavoritar) {
    function atualizarFavorito() {
      if (!Auth.usuarioAtual()) { btnFavoritar.textContent = '☆ Favoritar'; return; }
      let favorito = false;
      try {
        favorito = API.meusFavoritos().some(l => l && String(l.id) === String(loja.id));
      } catch (e) { /* noop */ }
      btnFavoritar.textContent = favorito ? '★ Favorito' : '☆ Favoritar';
    }
    btnFavoritar.addEventListener('click', () => {
      if (!Auth.usuarioAtual()) {
        window.location.href = '/login?next=' + encodeURIComponent('/salao?id=' + loja.id);
        return;
      }
      try {
        const r = API.alternarFavorito(loja.id);
        showToast(r.favorito ? 'Adicionado aos favoritos! Ver em Meu perfil → Favoritos.' : 'Removido dos favoritos.');
        atualizarFavorito();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    });
    atualizarFavorito();
  }

  /* ==========================================================
     FLUXO DE AGENDAMENTO (UC-14, DT-03/DT-04)
     ========================================================== */
  const modal = document.getElementById('modal-agendar-cliente');
  const form = document.getElementById('form-agendar-cliente');
  const slotDates = document.getElementById('slot-dates');
  const slotTimes = document.getElementById('slot-times');
  const fieldDatas = document.getElementById('field-datas');
  const fieldHorarios = document.getElementById('field-horarios');
  const fieldDados = document.getElementById('field-dados');
  const fieldTelefone = document.getElementById('field-telefone');
  const profInfo = document.getElementById('prof-info');
  const resumoServico = document.getElementById('ag-resumo');
  const btnConfirmar = document.getElementById('btn-confirmar-agendamento');
  const acNome = document.getElementById('ac-nome');
  const acTelefone = document.getElementById('ac-telefone');

  const logado = Auth.usuarioAtual();
  const ehClienteLogado = logado && logado.role === 'cliente';

  let svcSelecionado = null;
  let dataEscolhida = null;
  let horaEscolhida = null;
  let profResolvido = null;
  let hrLivreOk = false;

  /* Tarefa 3: agendar exige conta. Sem sessão → login com retorno
     para esta mesma página do salão (?next= é honrado pós-login). */
  function exigirSessao() {
    if (Auth.usuarioAtual()) return true;
    sessionStorage.setItem('cc_flash', JSON.stringify({
      texto: 'Faça login para agendar seu horário.',
      tipo: 'error'
    }));
    const volta = '/salao?id=' + encodeURIComponent(loja.id);
    window.location.href = '/login?next=' + encodeURIComponent(volta);
    return false;
  }

  if (ehClienteLogado) {
    if (acNome) acNome.value = logado.name || '';
    if (acTelefone) acTelefone.value = logado.phone || '';
  }

  function fmtISO(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* datas dos próximos 14 dias em que o salão abre */
  function renderDatas() {
    slotDates.innerHTML = '';
    let encontrados = 0;
    for (let i = 0; i < 14 && encontrados < 7; i++) {
      const d = new Date();
      d.setDate(d.getDate() + i);
      const iso = fmtISO(d);

      let disp;
      try { disp = API.disponibilidade(loja.id, iso, duracaoAtual()); }
      catch (e) { break; }
      if (!disp.is_open) continue;

      encontrados++;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'slot-date';
      chip.dataset.data = iso;
      chip.innerHTML =
        '<span class="slot-day">' + DIAS[d.getDay()] + '</span>' +
        '<span class="slot-date-num">' + d.getDate() + '</span>' +
        '<span class="slot-month">' + MESES[d.getMonth()] + '</span>';
      chip.addEventListener('click', () => {
        slotDates.querySelectorAll('.slot-date').forEach(s => s.classList.remove('active'));
        chip.classList.add('active');
        dataEscolhida = iso;
        horaEscolhida = null;
        profResolvido = null;
        btnConfirmar.disabled = true;
        fieldDados.style.display = 'none';
        fieldTelefone.style.display = 'none';
        if (profInfo) profInfo.textContent = '';
        renderHorarios();
      });
      slotDates.appendChild(chip);
    }

    if (!encontrados) {
      slotDates.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">Salão sem datas abertas nos próximos dias.</p>';
    }
    fieldDatas.style.display = '';
  }

  function duracaoAtual() {
    return svcSelecionado ? svcSelecionado.duration_min : 30;
  }

  function renderHorarios() {
    slotTimes.innerHTML = '';
    fieldHorarios.style.display = '';
    if (!dataEscolhida) return;

    let disp;
    try { disp = API.disponibilidade(loja.id, dataEscolhida, duracaoAtual()); }
    catch (e) {
      slotTimes.innerHTML = '<p style="color:var(--stripe-red);font-size:13px;">' + esc(msgErro(e)) + '</p>';
      return;
    }

    if (!disp.available_slots.length) {
      slotTimes.innerHTML = disp.horarios_configurados === false
        ? '<p style="color:var(--text-muted);font-size:13px;margin:4px 0;">Esta barbearia ainda não definiu os horários de agendamento. Volte mais tarde.</p>'
        : '<p style="color:var(--text-muted);font-size:13px;margin:4px 0;">Nenhum horário livre neste dia.</p>';
      return;
    }

    const faixasEl = document.getElementById('slot-faixas');
    if (faixasEl) {
      const range = disp.free_ranges || [];
      faixasEl.textContent = range.length
        ? 'Horários livres: ' + range.map(r => r.start + ' às ' + r.end).join(' · ')
        : 'Sem horário livre neste dia.';
    }

    /* clique num slot pré-computado (passo de 15 min) */
    disp.available_slots.forEach(hora => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-time';
      btn.textContent = hora;
      btn.addEventListener('click', () => {
        slotTimes.querySelectorAll('.slot-time').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        selecionarHorario(hora);
      });
      slotTimes.appendChild(btn);
    });

    /* horário livre: qualquer minuto, validado pela engine (DT-04) */
    const livre = document.getElementById('ac-horario-livre');
    if (livre) {
      livre.value = '';
      livre.addEventListener('input', () => {
        if (!dataEscolhida) return;
        const h = String(livre.value || '').trim();
        const st = document.getElementById('ac-horario-livre-status');
        if (!h) {
          if (st) { st.textContent = ''; }
          return;
        }
        if (!/^\d{2}:\d{2}$/.test(h)) { if (st) { st.textContent = 'Horário inválido.'; } return; }
        let ok = false;
        try {
          const res = API.verificarHorarioLivre(loja.id, dataEscolhida, h, duracaoAtual());
          ok = !!res.ok;
          if (ok) {
            const sel = res.professionals && res.professionals.length
              ? function (hora) {
                  selecionarHorarioLivre(hora,
                    'Atendimento com ' + res.professionals[0].professional_name +
                    (res.professionals[1] ? ' (ou ' + res.professionals[1].professional_name + ').' : '.'),
                    '', res.professionals[0]);
                }
              : (res.shop_only ? function (hora) {
                  selecionarHorarioLivre(hora, 'Atendimento pelo horário geral do salão.', '', null);
                } : null);
            if (sel) sel(h);
            else {
              ok = false;
              if (st) { st.style.color = 'var(--stripe-red)'; st.textContent = 'Horário ocupado.'; }
            }
          } else {
            const free = (res.free_ranges || []).map(r => r.start + '–' + r.end).join(', ');
            if (st) {
              st.style.color = 'var(--stripe-red)';
              st.textContent = 'Horário ocupado.' + (free ? ' Livre: ' + free : '');
            }
          }
        } catch (e) {
          if (st) { st.style.color = 'var(--stripe-red)'; st.textContent = msgErro(e); }
        }
        hrLivreOk = ok;
      });
    }

    function selecionarHorario(hora) {
      slotTimes.querySelectorAll('.slot-time').forEach(function (x) { x.classList.remove('active'); });
      horaEscolhida = hora;
      profResolvido = null;
      if (profInfo) profInfo.textContent = 'Carregando profissional…';
      try {
        profResolvido = API.profissionalParaSlot(loja.id, dataEscolhida, hora, duracaoAtual());
      } catch (e) { profResolvido = null; }
      if (profInfo) {
        profInfo.textContent = profResolvido
          ? 'Atendimento com ' + profResolvido.professional_name + '.'
          : 'Atendimento pelo horário geral do salão.';
      }
      hrLivreOk = false;
      btnConfirmar.disabled = false;
      fieldDados.style.display = '';
      fieldTelefone.style.display = ehClienteLogado && logado.phone ? 'none' : '';
    }

    function selecionarHorarioLivre(hora, nota, erro, cand) {
      slotTimes.querySelectorAll('.slot-time').forEach(function (x) { x.classList.remove('active'); });
      horaEscolhida = hora;
      profResolvido = cand || null;
      const st = document.getElementById('ac-horario-livre-status');
      if (erro) {
        if (st) { st.style.color = 'var(--stripe-red)'; st.textContent = erro; }
        btnConfirmar.disabled = true;
        return;
      }
      if (profInfo) profInfo.textContent = nota || '';
      if (st) { st.style.color = 'var(--success)'; st.textContent = 'Horário livre!'; }
      btnConfirmar.disabled = false;
      fieldDados.style.display = '';
      fieldTelefone.style.display = ehClienteLogado && logado.phone ? 'none' : '';
    }
  }

  /* Atualização quase-tempo-real: a cada 30s revalida os horários livres
     do dia escolhido e reflete mudanças do salão sem recarregar a página. */
  function atualizarSlotsTempoReal() {
    if (!svcSelecionado || !dataEscolhida || fieldHorarios.style.display === 'none') return;
    let disp;
    try { disp = API.disponibilidade(loja.id, dataEscolhida, duracaoAtual()); }
    catch (e) { return; }
    const disponiveis = disp.available_slots || [];

    if (disponiveis.length) {
      slotTimes.querySelectorAll('p').forEach(p => p.remove());
    }

    slotTimes.querySelectorAll('.slot-time').forEach(b => {
      if (disponiveis.indexOf(b.textContent) < 0) b.remove();
    });

    const atuais = Array.from(slotTimes.querySelectorAll('.slot-time')).map(b => b.textContent);
    disponiveis.forEach(hora => {
      if (atuais.indexOf(hora) >= 0) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'slot-time';
      btn.textContent = hora;
      btn.addEventListener('click', () => {
        slotTimes.querySelectorAll('.slot-time').forEach(x => x.classList.remove('active'));
        btn.classList.add('active');
        selecionarHorario(hora);
      });
      slotTimes.appendChild(btn);
    });

    disponiveis.forEach(hora => {
      const b = Array.from(slotTimes.querySelectorAll('.slot-time')).find(x => x.textContent === hora);
      if (b) slotTimes.appendChild(b);
    });

    if (!disponiveis.length && !slotTimes.querySelector('.slot-time')) {
      slotTimes.innerHTML = '<p style="color:var(--text-muted);font-size:13px;margin:4px 0;">Nenhum horário livre neste dia.</p>';
    }

    if (horaEscolhida && disponiveis.indexOf(horaEscolhida) < 0) {
      horaEscolhida = null;
      profResolvido = null;
      hrLivreOk = false;
      btnConfirmar.disabled = true;
      fieldDados.style.display = 'none';
      fieldTelefone.style.display = 'none';
      if (profInfo) profInfo.textContent = 'O horário escolhido acabou de ser ocupado. Selecione outro.';
      showToast('Um horário foi ocupado. Escolha outro.', 'error');
    } else if (horaEscolhida) {
      const b = Array.from(slotTimes.querySelectorAll('.slot-time')).find(x => x.textContent === horaEscolhida);
      if (b) b.classList.add('active');
    }

    const faixasEl = document.getElementById('slot-faixas');
    if (faixasEl) {
      const range = disp.free_ranges || [];
      faixasEl.textContent = range.length
        ? 'Horários livres: ' + range.map(r => r.start + ' às ' + r.end).join(' · ')
        : 'Sem horário livre neste dia.';
    }
  }

  setInterval(atualizarSlotsTempoReal, 30000);

  document.querySelectorAll('.btn-agendar').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      if (!exigirSessao()) return; /* anônimo vai para o login */

      const row = btn.closest('.service-row-public');
      svcSelecionado = servicos.find(s => String(s.id) === row?.dataset.servicoId) || null;

      dataEscolhida = null;
      horaEscolhida = null;
      profResolvido = null;
      btnConfirmar.disabled = true;
      fieldHorarios.style.display = 'none';
      fieldDados.style.display = 'none';
      fieldTelefone.style.display = 'none';
      if (profInfo) profInfo.textContent = '';

      if (resumoServico && svcSelecionado) {
        resumoServico.hidden = false;
        resumoServico.innerHTML =
          '<strong>' + esc(svcSelecionado.name) + '</strong> · ' +
          fmtDuracao(svcSelecionado.duration_min) + ' · <span class="mono">' +
          DB.fmtBRL(svcSelecionado.price) + '</span>';
      }

      renderDatas();
      abrirModal(modal);
    });
  });

  document.getElementById('btn-fechar-modal-agendar')
    ?.addEventListener('click', () => fecharModal(modal));
  modal?.addEventListener('click', e => { if (e.target === modal) fecharModal(modal); });

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!exigirSessao()) return; /* sessão pode ter caído no meio do fluxo */
    if (!svcSelecionado || !dataEscolhida || !horaEscolhida) return;

    const nome = (acNome?.value || '').trim();
    const tel = (acTelefone?.value || '').replace(/\D/g, '');
    if (!nome) { showToast('Informe seu nome.', 'error'); return; }
    if (tel.length < 10) { showToast('Informe um telefone válido com DDD.', 'error'); return; }

    const payload = {
      barbershop_id: loja.id,
      date: dataEscolhida,
      start_time: horaEscolhida,
      service_ids: [svcSelecionado.id],
      client_name: nome,
      client_phone: tel,
      origin: 'online'
    };
    if (profResolvido) payload.professional_id = profResolvido.professional_id;

    try {
      API.criarAgendamento(payload);
      showToast('Agendamento solicitado! Aguardando confirmação do salão.');
      fecharModal(modal);
      form.reset();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
      if (err2 && err2.status === 409) {
        horaEscolhida = null;
        btnConfirmar.disabled = true;
        renderHorarios();
      }
    }
  });

  const btnCompartilhar = document.getElementById('btn-compartilhar');
  if (btnCompartilhar) {
    btnCompartilhar.addEventListener('click', () => {
      const url = window.location.href;
      const nomeEl = document.querySelector('.salon-name, h1, .salao-nome');
      const texto = 'Confira ' + (nomeEl ? nomeEl.textContent : 'esta barbearia') + ' no Corte Comigo: ';
      if (navigator.share) {
        navigator.share({ title: 'Corte Comigo', text: texto, url: url });
      } else if (navigator.clipboard) {
        navigator.clipboard.writeText(texto + url).then(() => alert('Link copiado!'));
      } else {
        try { window.prompt('Copie o link:', texto + url); } catch (e) { /* noop */ }
      }
    });
  }

  /* ==========================================================
     DENÚNCIA DE PERFIL (barbeiro/salão) — cliente
     ========================================================== */
  const modalDen = document.getElementById('modal-denunciar');
  const formDen = document.getElementById('form-denunciar');
  const btnDen = document.getElementById('btn-denunciar');
  const denTarget = document.getElementById('den-target');
  const denMotivo = document.getElementById('den-motivo');
  const denOutroMotivo = document.getElementById('den-outro-motivo');
  const denCampoOutro = document.getElementById('den-campo-outro');
  const denDesc = document.getElementById('den-descricao');

  function exigirSessaoDenuncia() {
    if (Auth.usuarioAtual()) return true;
    sessionStorage.setItem('cc_flash', JSON.stringify({
      texto: 'Faça login para denunciar um perfil.',
      tipo: 'error'
    }));
    const volta = '/salao?id=' + encodeURIComponent(loja.id);
    window.location.href = '/login?next=' + encodeURIComponent(volta);
    return false;
  }

  if (btnDen && modalDen && formDen) {
    btnDen.addEventListener('click', () => {
      if (!exigirSessaoDenuncia()) return;

      const u = Auth.usuarioAtual();
      /* barbeiro/dono não denuncia por aqui (usa o CRM para clientes) */
      if (u && (u.role === 'dono' || u.role === 'barbeiro')) {
        showToast('Denúncias de perfis de salão/barbeiro são feitas pela conta do cliente.', 'error');
        return;
      }

      /* alvos: o próprio salão e os barbeiros ativos listados na página */
      denTarget.innerHTML = '';
      const opSalao = document.createElement('option');
      opSalao.value = 'salao:' + loja.id;
      opSalao.textContent = 'Esta barbearia (' + (loja.name || '') + ')';
      denTarget.appendChild(opSalao);
      profissionais.forEach(p => {
        const op = document.createElement('option');
        op.value = 'barbeiro:' + p.id + ':' + (p.user_id || '');
        op.textContent = 'Um barbeiro (' + p.name + ')';
        denTarget.appendChild(op);
      });

      denMotivo.value = '';
      denOutroMotivo.value = '';
      if (denCampoOutro) denCampoOutro.style.display = 'none';
      denDesc.value = '';

      abrirModal(modalDen);
    });

    /* mostra o campo "conte o motivo" quando seleciona "outro" */
    denMotivo.addEventListener('change', () => {
      if (!denCampoOutro) return;
      const outro = denMotivo.value === 'outro';
      denCampoOutro.style.display = outro ? '' : 'none';
      if (outro) denOutroMotivo.focus();
    });

    document.getElementById('btn-fechar-modal-denunciar')
      ?.addEventListener('click', () => fecharModal(modalDen));
    modalDen.addEventListener('click', (e) => {
      if (e.target === modalDen) fecharModal(modalDen);
    });

    formDen.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!exigirSessaoDenuncia()) return;
      const alvo = (denTarget?.value || '').split(':');
      const [tipo, id1, id2] = alvo;
      if (!tipo || !id1) { showToast('Selecione o perfil a denunciar.', 'error'); return; }
      let motivo = denMotivo?.value || '';
      if (!motivo) { showToast('Selecione um motivo.', 'error'); return; }
      if (motivo === 'outro') {
        motivo = (denOutroMotivo?.value || '').trim();
        if (!motivo) { showToast('Conte o motivo da denúncia.', 'error'); return; }
      }

      const payload = {
        target_type: tipo, // 'salao' | 'barbeiro'
        reason: motivo,
        description: (denDesc?.value || '').trim(),
        target_display: loja.name
      };
      if (tipo === 'salao') payload.target_barbershop_id = id1;
      if (tipo === 'barbeiro') {
        payload.target_barbershop_id = loja.id;
        payload.target_user_id = id2 || null;
        const prof = profissionais.find(p => String(p.id) === id1);
        payload.target_display = prof ? prof.name : loja.name;
      }

      const btnEnv = formDen.querySelector('button[type="submit"]');
      btnEnv.disabled = true;
      btnEnv.textContent = 'Enviando...';
      try {
        API.denunciarPerfil(payload);
        showToast('Denúncia enviada! Nossa equipe vai analisar.');
        fecharModal(modalDen);
        formDen.reset();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      } finally {
        btnEnv.disabled = false;
        btnEnv.textContent = 'Enviar denúncia';
      }
    });
  }
});
