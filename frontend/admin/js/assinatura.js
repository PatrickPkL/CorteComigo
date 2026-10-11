/* ============================================================
   Corte Comigo – admin/js/assinatura.js
   Status da assinatura, troca de planos via PIX (Mercado Pago)
   e histórico de cobranças (RF-057..061, DT-12).
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const usuario = exigirLogin('dono');
  if (!usuario) return;
  const loja = Auth.salaoDoUsuario(usuario);
  if (!loja) {
    showToast('Nenhum salão vinculado a esta conta.', 'error');
    setTimeout(() => { window.location.href = '/login'; }, 1200);
    return;
  }

  /* motivo do redirecionamento (ação bloqueada por falta de assinatura) */
  try {
    const aviso = sessionStorage.getItem('cc_assinatura_aviso');
    if (aviso) {
      sessionStorage.removeItem('cc_assinatura_aviso');
      showToast(aviso, 'error');
    }
  } catch (e) { /* sessionStorage indisponível */ }

  function setText(id, v) { const el = document.getElementById(id); if (el) el.textContent = v; }
  function setHTML(id, v) { const el = document.getElementById(id); if (el) el.innerHTML = v; }

  const STATUS_LABEL = {
    trial: ['badge-pendente', '10 dias grátis'],
    ativa: ['badge-confirmado', 'Ativa'],
    cancelada: ['badge-cancelado', 'Cancelada'],
    expirada: ['badge-cancelado', 'Expirada']
  };

  let planos = [];
  try { planos = API.listarPlanos(); } catch (e) { /* noop */ }

  /* Ao expirar os 10 dias grátis, rola até a lista de planos uma vez por
     carregamento, para o dono escolher qual plano deseja renovar (a
     cobrança só é gerada depois que ele escolhe). */
  let escolhaJaRolada = false;

  function render() {
    let sub;
    try { sub = API.minhaAssinatura(); } catch (e) {
      showToast(msgErro(e), 'error');
      return;
    }

    const [cls, label] = STATUS_LABEL[sub.status] || ['', 'Sem assinatura'];
    setHTML('st-status', '<span class="badge ' + cls + '">' + label + '</span>');
    setText('st-plano', sub.plano_efetivo ? sub.plano_efetivo.name : (sub.plan ? sub.plan.name : '—'));
    setText('st-preco', sub.plano_efetivo ? DB.fmtBRL(sub.plano_efetivo.price_monthly) + '/mês' : '—');

    let liberado = false;
    try { liberado = !!API.acessoLiberado(loja.id); } catch (e) { liberado = false; }

    const podeTrial = sub.trial_disponivel !== false && !sub.trial_usado && !sub.on_trial;

    if (sub.on_trial) {
      const valorPlano = sub.plan ? DB.fmtBRL(sub.plan.price_monthly) + '/mês' : '—';
      setText('st-cobranca', DB.fmtDataBR(sub.trial_ends_at));
      setText('st-cobranca-nota', 'último dia do teste — cobrança no dia seguinte');
      setHTML('st-trial', 'Você está testando o plano <strong>' +
        esc(sub.plan ? sub.plan.name : '') + '</strong> por <strong>' + sub.days_left_in_trial +
        ' dia(s)</strong> (termina em ' + DB.fmtDataBR(sub.trial_ends_at) + '). No <strong>11º dia</strong> ' +
        'a cobrança mensal de ' + valorPlano + ' é gerada. Pode trocar o plano de teste quando quiser — ' +
        'é só escolher abaixo.');
      document.getElementById('box-trial').hidden = false;
    } else {
      const venceu = sub.current_period_end && sub.current_period_end < DB.hojeISO();
      setText('st-cobranca', sub.current_period_end ? DB.fmtDataBR(sub.current_period_end) : '—');
      setText('st-cobranca-nota', venceu ? 'período encerrado — escolha um plano para renovar'
                                         : 'renovação ao pagar o PIX');
      document.getElementById('box-trial').hidden = true;
    }

    /* Aviso: escolha o plano que você quer testar nos 10 dias grátis */
    const boxEscolher = document.getElementById('box-escolher');
    if (boxEscolher) {
      boxEscolher.hidden = !podeTrial;
      if (podeTrial) {
        setHTML('st-escolher', 'Escolha abaixo o plano que você quer <strong>testar por 10 dias ' +
          'grátis</strong>. Depois do teste a assinatura é mensal e a cobrança só é gerada quando ' +
          'você confirmar qual plano quer renovar.');
      }
    }

    const devePagar = !liberado && !sub.on_trial && !!(sub.plan || sub.trial_usado);
    const boxPend = document.getElementById('box-pendente');
    if (boxPend) {
      boxPend.hidden = !devePagar;
      if (devePagar) {
        setHTML('st-pendente', 'Seus <strong>10 dias grátis terminaram</strong>. Escolha abaixo o ' +
          'plano que deseja renovar e pague o PIX para reativar o acesso. A assinatura é mensal.');
      }
    }

    renderPlanos(sub);
    renderHistorico(sub);

    /* Assinatura expirada: rola até os planos para o dono escolher qual
       renovar (a cobrança é gerada só na escolha de um plano). */
    if (devePagar && !escolhaJaRolada) {
      escolhaJaRolada = true;
      setTimeout(() => {
        const alvo = document.getElementById('lista-planos');
        if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 150);
    }
  }

  /* ---------- cards de planos ---------- */
  function opcoesParcelas(plano) {
    const total = Math.round(
      ((plano.price_annual != null && Number(plano.price_annual) > 0
        ? Number(plano.price_annual)
        : Number(plano.price_monthly) * 12) * 100)
    ) / 100;
    const opcoes = [1, 2, 3, 6, 12].map(n => {
      const valor = Math.round((total / n) * 100) / 100;
      const rotulo = n === 1 ? ' (à vista)'
        : n === 12 ? ' (valor mensal)'
        : '';
      return '<option value="' + n + '">' + n + '× de ' + DB.fmtBRL(valor) + rotulo + '</option>';
    });
    return opcoes.join('');
  }

  let periodoGlobal = 'mensal';

  function aplicarPeriodoGlobal() {
    const anual = periodoGlobal === 'anual';
    document.querySelectorAll('#lista-planos .plan-card').forEach(card => {
      const plano = planos.find(p => String(p.id) === card.dataset.plano);
      if (!plano) return;
      const base = anual
        ? (plano.price_annual != null && Number(plano.price_annual) > 0
          ? Number(plano.price_annual) : Number(plano.price_monthly) * 12)
        : Number(plano.price_monthly);
      const riscado = card.querySelector('.plan-preco-riscado');
      const valorEl = card.querySelector('.plan-preco-valor');
      const unidEl = card.querySelector('.plan-preco-unidade');
      const nota = card.querySelector('.plan-anual-nota');
      const parc = card.querySelector('.plan-parcelas');
      if (plano.is_free) {
        const compare = plano.price_compare != null ? Number(plano.price_compare) : 0;
        if (riscado) riscado.textContent = DB.fmtBRL(compare);
        if (valorEl) valorEl.textContent = 'R$ 0,00';
        if (unidEl) unidEl.textContent = 'sempre';
        const depois = card.querySelector('.plan-preco-depois');
        if (depois) depois.textContent = 'De ' + DB.fmtBRL(compare) +
          (compare > 0 ? ' por R$ 0,00' : '') + ' · sem cartão, sem surpresa';
        return;
      }
      if (riscado) {
        /* card em trial: preço cheio riscado + R$ 0,00 nos 10 primeiros dias */
        riscado.textContent = DB.fmtBRL(base);
        if (valorEl) valorEl.textContent = 'R$ 0,00';
        if (unidEl) unidEl.textContent = 'nos primeiros 10 dias';
        const depois = card.querySelector('.plan-preco-depois');
        if (depois) depois.textContent = 'Depois ' + DB.fmtBRL(base) +
          (anual ? '/ano' : '/mês') + ' · cancele quando quiser';
        return;
      }
      if (valorEl) valorEl.textContent = DB.fmtBRL(base);
      if (unidEl) unidEl.textContent = anual ? '/ano' : '/mês';
      if (nota) nota.hidden = !anual;
      if (parc) parc.hidden = !anual;
    });
  }

  function renderPlanos(subAtual) {
    const box = document.getElementById('lista-planos');
    if (!box) return;

    const podeTrial = subAtual.trial_disponivel !== false && !subAtual.trial_usado && !subAtual.on_trial;
    const anual = periodoGlobal === 'anual';
    box.innerHTML = planos.map(p => {
      const atual = subAtual.plano_efetivo && subAtual.plano_efetivo.id === p.id;
      const isFree = !!p.is_free;
      const anualBase = p.price_annual != null && Number(p.price_annual) > 0
        ? Number(p.price_annual)
        : Number(p.price_monthly) * 12;
      const limite = p.max_professionals == null
        ? 'Profissionais ilimitados'
        : 'Até ' + p.max_professionals + ' profissional(is)';
      const feats = (p.features || []).map(f => '<li>' + esc(f) + '</li>').join('');

      let botao;
      if (isFree) {
        botao = '<button type="button" class="btn" disabled title="Plano base gratuito — assine para liberar recursos">' +
          (atual ? 'Plano atual' : 'Plano base') + '</button>';
      } else if (podeTrial) {
        botao = '<button type="button" class="btn btn-brass btn-assinar-trial" data-id="' + p.id + '">' +
          'Começar 10 dias grátis</button>';
      } else if (subAtual.on_trial) {
        const emTeste = subAtual.plan && subAtual.plan.id === p.id;
        botao = emTeste
          ? '<button type="button" class="btn" disabled>Em teste agora</button>'
          : '<button type="button" class="btn btn-brass btn-trocar-plano" data-id="' + p.id + '">' +
            'Trocar para este plano</button>';
      } else {
        botao = '<button type="button" class="btn btn-brass btn-assinar" data-id="' + p.id + '">' +
          (atual ? 'Renovar' : 'Assinar agora') + '</button>';
      }

      let preco;
      if (isFree) {
        const compare = p.price_compare != null ? Number(p.price_compare) : 0;
        preco = '<div class="plan-preco mono">' +
            '<span class="plan-preco-riscado">' + DB.fmtBRL(compare) + '</span>' +
            '<span class="plan-preco-valor">R$ 0,00</span>' +
            '<small class="plan-preco-unidade">sempre</small>' +
          '</div>' +
          '<div class="plan-preco-depois">De ' + DB.fmtBRL(compare) +
            (compare > 0 ? ' por R$ 0,00' : '') + ' · sem cartão, sem surpresa</div>';
      } else if (podeTrial) {
        preco = '<div class="plan-preco mono">' +
            '<span class="plan-preco-riscado">' + DB.fmtBRL(anual ? anualBase : p.price_monthly) + '</span>' +
            '<span class="plan-preco-valor">R$ 0,00</span>' +
            '<small class="plan-preco-unidade">nos primeiros 10 dias</small>' +
          '</div>' +
          '<div class="plan-preco-depois">Depois ' + DB.fmtBRL(anual ? anualBase : p.price_monthly) +
            (anual ? '/ano' : '/mês') + ' · cancele quando quiser</div>';
      } else {
        preco = '<div class="plan-preco mono">' +
            '<span class="plan-preco-valor">' + DB.fmtBRL(anual ? anualBase : p.price_monthly) + '</span>' +
            '<small class="plan-preco-unidade">' + (anual ? '/ano' : '/mês') + '</small>' +
          '</div>' +
          '<div class="plan-anual-nota"' + (anual ? '' : ' hidden') + '>12 meses · parcelas a partir de ' +
            DB.fmtBRL(Math.round(anualBase / 12 * 100) / 100) + '/mês</div>' +
          '<div class="plan-parcelas"' + (anual ? '' : ' hidden') + '>' +
            '<label>Parcelar em</label>' +
            '<select class="plan-parcelas-sel">' + opcoesParcelas(p) + '</select>' +
          '</div>';
      }

      return '<div class="card plan-card' + (atual ? ' plan-card-highlight' : '') + '" data-plano="' + p.id + '"' +
          (isFree ? ' data-free="1"' : podeTrial ? ' data-trial="1"' : '') + '>' +
        (atual ? '<span class="plan-badge">Plano atual</span>' : '') +
        '<h3 class="plan-nome">' + esc(p.name) + '</h3>' +
        preco +
        '<ul class="plan-feats"><li>' + limite + '</li>' + feats + '</ul>' +
        botao +
      '</div>';
    }).join('');

    box.querySelectorAll('.btn-assinar').forEach(btn => {
      btn.addEventListener('click', () => {
        const plano = planos.find(p => String(p.id) === btn.dataset.id);
        const parcelas = periodoGlobal === 'anual'
          ? Number(btn.closest('.plan-card').querySelector('.plan-parcelas-sel').value) || 12
          : 1;
        if (plano) abrirPagamento(plano, periodoGlobal, parcelas);
      });
    });

    box.querySelectorAll('.btn-assinar-trial').forEach(btn => {
      btn.addEventListener('click', () => {
        const plano = planos.find(p => String(p.id) === btn.dataset.id);
        if (!plano) return;
        if (!confirm('Começar 10 dias grátis no plano ' + plano.name +
          '? Depois do período você escolhe qual plano quer renovar e paga o PIX.')) return;
        try {
          API.assinarComTrial(plano.id);
          showToast('10 dias grátis ativados no plano ' + plano.name + '!', 'success');
          render();
          montarShellAdmin();
        } catch (e) {
          showToast(msgErro(e), 'error');
          render();
        }
      });
    });

    /* durante o teste, troca o plano testado mantendo os dias restantes */
    box.querySelectorAll('.btn-trocar-plano').forEach(btn => {
      btn.addEventListener('click', () => {
        const plano = planos.find(p => String(p.id) === btn.dataset.id);
        if (!plano) return;
        if (!confirm('Passar a testar o plano ' + plano.name +
          '? Os dias de teste que restam continuam os mesmos.')) return;
        try {
          API.trocarPlano(plano.id);
          showToast('Agora você está testando o plano ' + plano.name + '.', 'success');
          render();
          montarShellAdmin();
        } catch (e) {
          showToast(msgErro(e), 'error');
          render();
        }
      });
    });
  }

  /* ---------- modal de pagamento PIX ---------- */
  const modalPg = document.getElementById('modal-pagamento');
  let cobrancaId = null;
  let timerPoll = null;
  let timerRelogio = null;

  function pararTimers() {
    clearInterval(timerPoll);
    clearInterval(timerRelogio);
    timerPoll = timerRelogio = null;
  }

function fecharPagamento() {
    pararTimers();
    cobrancaId = null;
    fecharModal(modalPg);
    render();
  }

  function statusTexto(c) {
    if (c.status === 'paid') return 'Pagamento confirmado!';
    if (c.status === 'expired') return 'PIX expirado — clique em Assinar novamente para gerar outro.';
    if (c.status === 'cancelled') return 'Cobrança cancelada.';
    return 'Aguardando pagamento…';
  }

  function atualizarStatus(c) {
    const el = document.getElementById('pg-status');
    if (!el) return;
    el.textContent = statusTexto(c);
    if (c.status === 'paid') el.style.color = 'var(--success)';
    else if (c.status === 'expired' || c.status === 'cancelled') el.style.color = 'var(--warn-text)';
    else el.style.color = 'var(--text-muted)';
  }

  function iniciarRelogio(expiresAt) {
    const fim = new Date(expiresAt).getTime();
    clearInterval(timerRelogio);
    const tick = () => {
      const rest = Math.max(0, Math.floor((fim - Date.now()) / 1000));
      const mm = String(Math.floor(rest / 60)).padStart(2, '0');
      const ss = String(rest % 60).padStart(2, '0');
      const el = document.getElementById('pg-status');
      if (el && cobrancaId && rest > 0 &&
        el.textContent.indexOf('Aguardando') === 0) {
        el.textContent = 'Aguardando pagamento… expira em ' + mm + ':' + ss;
      }
      if (rest <= 0) clearInterval(timerRelogio);
    };
    tick();
    timerRelogio = setInterval(tick, 1000);
  }

  function mostrarCobranca(c, plano) {
    cobrancaId = c.id;
    const anual = c.billing_period === 365;
    let rotulo = 'Plano ' + c.plan_name + ' · ' + (anual ? 'anual' : '30 dias');
    if (anual && c.installments > 1) rotulo += ' · ' + c.installments + '×';
    if (anual && c.installments === 1) rotulo += ' · à vista';
    const titulo = document.getElementById('pg-titulo');
    if (titulo) titulo.textContent = 'Pagar com PIX';
    setText('pg-plano', rotulo);
    setText('pg-valor', DB.fmtBRL(c.amount_cents / 100));

    const checkout = document.getElementById('pg-checkout');
    if (checkout) checkout.hidden = false;

    const qr = document.getElementById('pg-qrcode');
    const semqr = document.getElementById('pg-semqr');
    if (c.qr_base64) {
      qr.src = c.qr_base64;
      qr.hidden = false;
      semqr.hidden = true;
    } else {
      qr.hidden = true;
      semqr.hidden = false;
    }
    document.getElementById('pg-codigo').value = c.br_code || '';
    atualizarStatus(c);
    iniciarRelogio(c.expires_at);

    pararTimers(); // limpa poll anterior antes de recomeçar
    timerPoll = setInterval(() => {
      if (!cobrancaId) return;
      let st = null;
      try { st = API.statusCobranca(cobrancaId); }
      catch (e) { return; /* rede indisponível — tenta no próximo ciclo */ }
      atualizarStatus(st);
      if (st.status !== 'pending') {
        pararTimers();
        if (st.status === 'paid') {
          showToast('Pagamento confirmado! Plano ' + st.plan_name + ' ativo.', 'success');
          setTimeout(fecharPagamento, 900);
        }
      }
    }, 4000);

    abrirModal(modalPg);
  }

  /* Cria a cobrança PIX direto ao escolher o plano — o Mercado Pago não
     exige CPF/CNPJ do pagador, então não há passo de documento. */
  function abrirPagamento(plano, periodo, parcelas) {
    if (!plano) return;
    const anual = periodo === 'anual';
    const titulo = document.getElementById('pg-titulo');
    if (titulo) titulo.textContent = 'Pagar com PIX';
    setText('pg-plano', 'Plano ' + plano.name + ' · ' + (anual ? 'anual' : '30 dias'));
    const valorAnual = plano.price_annual != null && Number(plano.price_annual) > 0
      ? Number(plano.price_annual) : Number(plano.price_monthly) * 12;
    setText('pg-valor', DB.fmtBRL(anual ? valorAnual : Number(plano.price_monthly)));

    const checkout = document.getElementById('pg-checkout');
    if (checkout) checkout.hidden = true;
    abrirModal(modalPg);

    try {
      const c = API.criarCobrancaPlano(plano.id, periodo || 'mensal', parcelas || 1, 'pix');
      mostrarCobranca(c, plano);
    } catch (e) {
      showToast(msgErro(e), 'error');
      fecharPagamento();
    }
  }

  document.getElementById('btn-fechar-pagamento')?.addEventListener('click', fecharPagamento);
  modalPg?.addEventListener('click', e => {
    if (e.target === modalPg) fecharPagamento();
  });

  document.getElementById('pg-copiar')?.addEventListener('click', () => {
    const inp = document.getElementById('pg-codigo');
    inp.select();
    const done = () => showToast('Código PIX copiado!', 'success');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(inp.value).then(done).catch(() => {
        document.execCommand('copy'); done();
      });
    } else {
      document.execCommand('copy'); done();
    }
  });

  /* ---------- histórico real de cobranças ---------- */
  function badgeDe(status) {
    if (status === 'paid') return ['badge-confirmado', 'Pago'];
    if (status === 'refunded') return ['badge-cancelado', 'Estornado'];
    if (status === 'pending') return ['badge-pendente', 'Aguardando'];
    if (status === 'expired') return ['badge-cancelado', 'Expirado'];
    return ['badge-cancelado', 'Cancelada'];
  }

  function renderHistorico(sub) {
    const tb = document.getElementById('tbody-cobrancas');
    if (!tb) return;

    let cobrancas = [];
    try { cobrancas = API.listarMinhasCobrancas() || []; } catch (e) { /* noop */ }

    const linhas = [];
    if (sub.on_trial) {
      linhas.push(
        '<tr><td>—</td><td>Trial — plano ' + esc(sub.plan ? sub.plan.name : '') + '</td>' +
        '<td class="mono">R$ 0,00</td><td><span class="badge badge-pendente">Trial</span></td></tr>');
    }
    cobrancas.forEach(c => {
      const estornada = !!(c.refunded_at || c.status === 'refunded');
      const [bCls, bTxt] = estornada ? ['badge-cancelado', 'Estornado'] : badgeDe(c.status);
      const anual = c.billing_period === 365;
      let desc = 'Plano ' + esc(c.plan_name) + (anual ? ' — anual' : ' — mensalidade');
      if (anual && c.installments > 1) desc += ' em ' + c.installments + '×';
      if (c.provider === 'demo') desc += ' <small>(teste)</small>';

      let acao = '';
      if (c.status === 'paid' && !estornada && dentroDaJanelaArrependimento(c.paid_at)) {
        acao = '<button type="button" class="btn btn-outline btn-estornar" data-id="' + c.id + '" ' +
          'title="Direito de arrependimento (CDC art. 49): desistir em até 7 dias e receber o valor de volta" ' +
          'style="margin-top:8px; font-size:12px; padding:4px 10px;">Solicitar reembolso</button>';
      }

      linhas.push(
        '<tr><td class="mono">' + DB.fmtDataBR(String(c.created_at).slice(0, 10)) + '</td>' +
        '<td>' + desc + '</td>' +
        '<td class="mono">' + DB.fmtBRL(c.amount_cents / 100) + '</td>' +
        '<td><span class="badge ' + bCls + '">' + bTxt + '</span>' + acao + '</td></tr>');
    });

    tb.innerHTML = linhas.join('') ||
      '<tr><td colspan="4" style="color:var(--text-muted)">Sem cobranças registradas.</td></tr>';

    tb.querySelectorAll('.btn-estornar').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        if (!confirm(
          'Solicitar reembolso integral (direito de arrependimento — CDC art. 49)?\n\n' +
          'Você vai desistir desta compra e receber de volta o valor pago integralmente. ' +
          'O acesso ao plano será encerrado e os dias pagos removidos da assinatura.'
        )) return;
        try {
          const r = API.estornarArrependimento(id);
          if (r && r.refunded_at) showToast('Reembolso solicitado com sucesso. Valor devolvido integralmente.', 'success');
          else showToast('Reembolso processado.', 'success');
          render();
        } catch (e2) {
          showToast(msgErro(e2), 'error');
        }
      });
    });
  }

  function dentroDaJanelaArrependimento(paidAt) {
    if (!paidAt) return false;
    const paidMs = Date.parse(paidAt);
    if (isNaN(paidMs)) return false;
    return Date.now() - paidMs <= 7 * 24 * 60 * 60 * 1000;
  }

  /* ---------- cancelar assinatura ---------- */
  document.getElementById('btn-cancelar-assinatura')?.addEventListener('click', () => {
    if (!confirm('Cancelar a assinatura? O painel seguirá acessível até o fim do período já pago.')) return;
    try {
      API.cancelarAssinatura();
      showToast('Assinatura cancelada.', 'error');
      render();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  /* ---------- fim dos 10 dias: leva o dono a escolher o plano a renovar ---------- */
  document.getElementById('btn-pagar-pendente')?.addEventListener('click', () => {
    const alvo = document.getElementById('lista-planos');
    if (alvo && alvo.scrollIntoView) alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Escolha abaixo o plano que você quer renovar.', 'info');
  });

  /* ---------- seletor global Mensal/Anual ---------- */
  document.querySelectorAll('.plan-tgl-global .plan-tgl-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const per = btn.dataset.per;
      document.querySelectorAll('.plan-tgl-global .plan-tgl-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.per === per);
      });
      periodoGlobal = per;
      aplicarPeriodoGlobal();
    });
  });

  render();

  /* ---------- planos em tempo real ----------
     Super-admin pode criar/editar/excluir planos e mudar preços a
     qualquer momento. Re-consulta a cada 20s (e ao reativar a aba)
     e só re-renderiza quando algo mudou de fato nos planos ou no
     status da assinatura. */
  let planoSnapshot = JSON.stringify(planos);
  let subSnapshot = '';

  function sincronizarAoVivo() {
    try {
      const novos = API.listarPlanos();
      const snap = JSON.stringify(novos || []);
      let sub = null;
      try { sub = API.minhaAssinatura(); } catch (e2) { return; }
      const snapSub = JSON.stringify(sub);
      const subMudou = snapSub !== subSnapshot;
      subSnapshot = snapSub;
      const planosMudaram = snap !== planoSnapshot;
      if (planosMudaram) planos = novos || [];
      planoSnapshot = snap;
      if (planosMudaram || subMudou) render();
    } catch (e) { /* rede indisponível — tenta no próximo ciclo */ }
  }

  window.addEventListener('focus', sincronizarAoVivo);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') sincronizarAoVivo();
  });
  setInterval(sincronizarAoVivo, 20000);
});

