'use strict';
/* ============================================================
   Corte Comigo – payments.js
   Cobrança dos planos via Mercado Pago (PIX à vista).

   Métodos de pagamento:
   • PIX (somente) — QR Code + código copia-e-cola gerados pelo
     próprio Mercado Pago (POST /v1/payments, payment_method_id=pix).
   • Com MERCADOPAGO_ACCESS_TOKEN no .env → PIX real (token de teste
     = sandbox). Sem chave → modo simulado local (PIX fake/demo).

   Confirmação do pagamento:
   1. Polling — statusCobranca() consulta o Mercado Pago (ou o
      estado local, no modo demo) chamado pela tela Assinatura;
   2. Webhook — server.js recebe POST /webhooks/mercadopago,
      valida o header x-signature e chama processarEventoWebhook().

   O PIX do Mercado Pago EXIGE os dados do pagador (payer): nome,
   e-mail e CPF/CNPJ. Por isso a tela de Assinatura coleta o
   documento do dono antes de gerar a cobrança.

   Ao confirmar: subscription.status='ativa', plan_id do plano
   pago e current_period_end estendido em +30 dias (mensal) ou
   +365 dias (anual), a partir do fim do período vigente,
   preservando trial em andamento. O total anual usa o preço
   anual próprio do plano (price_annual) — não é 12× o mensal.
   ============================================================ */

(function () {
  const DB = window.DB;
  const Auth = window.Auth;

  const URL_API = 'https://api.mercadopago.com';
  const EXPIRA_EM_SEG = 3600; // QR Code PIX válido por 1h

  function agoraISO() { return new Date().toISOString().slice(0, 16); }
  function agoraMsISO() { return new Date().toISOString(); }

  function chaveApi() {
    return String(process.env.MERCADOPAGO_ACCESS_TOKEN || '').trim();
  }

  function urlWebhook() {
    const base = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
    return base ? base + '/webhooks/mercadopago' : null;
  }

  /* [SEGURANÇA] Ambiente de produção. Sem isto, um erro de deploy
     (NODE_ENV não definido no hPanel) deixaria a cobrança demo — que não
     move dinheiro — valendo como pagamento real. */
  function ambienteProducao() {
    return String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production';
  }

  /* Simulação só fora de produção E com opt-in explícito, para não
     carregar um botão de "pagar" em ambiente que alguém publicou. */
  function simulacaoLiberada() {
    if (ambienteProducao()) return false;
    const flag = String(process.env.CC_PAGAMENTO_SIMULADO || '').trim().toLowerCase();
    if (flag === '1' || flag === 'true') return true;
    /* Fora de produção, sem NODE_ENV definido, a simulação segue liberada
       (ambiente de dev); com NODE_ENV explícito de staging, exige opt-in. */
    return !String(process.env.NODE_ENV || '').trim();
  }

  /* Cobrança real exige chave do Mercado Pago. Sem isso, falhar alto em vez
     de gerar cobrança demo silenciosamente. */
  function exigirChaveParaCobrancaReal() {
    if (chaveApi()) return true;
    if (ambienteProducao() || !simulacaoLiberada()) {
      throw {
        status: 503,
        code: 'pagamento_indisponivel',
        error: 'Pagamento online indisponível no momento. Tente novamente mais tarde.'
      };
    }
    return false;
  }

  /* ---------- auth local (exigirDono vive fechado no api.js) ---------- */

  function exigirDonoLocal() {
    const user = Auth.usuarioAtual();
    if (!user) throw { status: 401, error: 'Faça login para continuar.' };
    if (user.role !== 'dono') throw { status: 403, error: 'Acesso restrito ao dono do salão.' };
    const shop = Auth.salaoDoUsuario(user);
    if (!shop) throw { status: 403, error: 'Nenhum salão vinculado a esta conta.' };
    return { user, shop };
  }

  /* ---------- helpers de cobrança ---------- */

  function pagamentoPublico(pag) {
    const plano = DB._d().plans.find(p => p.id === pag.plan_id);
    return {
      id: pag.id,
      plan_name: plano ? plano.name : '—',
      billing_period: pag.billing_period || 30,
      installments: pag.installments || 1,
      amount_cents: pag.amount_cents,
      metodo: pag.metodo || 'pix',
      status: pag.status,
      provider: pag.provider,
      br_code: pag.br_code || '',
      qr_base64: pag.qr_base64 || '',
      provider_id: pag.provider_id || null,
      dev_mode: pag.dev_mode === true,
      refunded_at: pag.refunded_at || null,
      refund_reason: pag.refund_reason || null,
      refund_id: pag.refund_id || null,
      created_at: pag.created_at,
      expires_at: pag.expires_at,
      paid_at: pag.paid_at || null
    };
  }

  /**
   * Ativação idempotente do plano pago. Renovações antecipadas
   * empilham a partir do fim do período atual (trial preservado).
   */
  function aplicarPagamento(pag) {
    if (!pag || pag.status === 'paid') return false;
    const db = DB._d();
    pag.status = 'paid';
    pag.paid_at = agoraISO();

    let sub = db.subscriptions.find(s => s.barbershop_id === pag.barbershop_id);
    const hoje = DB.hojeISO();
    const dias = Number(pag.billing_period || 30);
    if (!sub) {
      sub = {
        id: DB.proximoId(), barbershop_id: pag.barbershop_id,
        plan_id: pag.plan_id, status: 'ativa', trial_ends_at: null,
        billing_period: dias,
        current_period_end: DB.addDiasISO(dias),
        trial_usado: true, created_at: agoraISO(), updated_at: agoraISO()
      };
      db.subscriptions.push(sub);
    } else {
      const base = (sub.current_period_end && sub.current_period_end > hoje)
        ? sub.current_period_end : hoje;
      sub.plan_id = pag.plan_id;
      sub.status = 'ativa';
      sub.billing_period = dias;
      sub.trial_usado = true;
      sub.current_period_end = DB.addDiasISO(dias, base);
      sub.updated_at = agoraISO();
    }
    DB.salvar();
    return true;
  }

  /* ---------- validação de CPF/CNPJ do pagador ---------- */

  function somenteDigitos(v) { return String(v == null ? '' : v).replace(/\D/g, ''); }

  function cpfValido(cpf) {
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
    let soma = 0;
    for (let i = 0; i < 9; i++) soma += Number(cpf[i]) * (10 - i);
    let d1 = (soma * 10) % 11; if (d1 === 10) d1 = 0;
    if (d1 !== Number(cpf[9])) return false;
    soma = 0;
    for (let i = 0; i < 10; i++) soma += Number(cpf[i]) * (11 - i);
    let d2 = (soma * 10) % 11; if (d2 === 10) d2 = 0;
    return d2 === Number(cpf[10]);
  }

  function cnpjValido(cnpj) {
    if (!/^\d{14}$/.test(cnpj) || /^(\d)\1{13}$/.test(cnpj)) return false;
    const calc = (base) => {
      const pesos = base.length === 12
        ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
        : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
      let soma = 0;
      for (let i = 0; i < base.length; i++) soma += Number(base[i]) * pesos[i];
      const r = soma % 11;
      return r < 2 ? 0 : 11 - r;
    };
    const d1 = calc(cnpj.slice(0, 12));
    if (d1 !== Number(cnpj[12])) return false;
    const d2 = calc(cnpj.slice(0, 13));
    return d2 === Number(cnpj[13]);
  }

  /**
   * Normaliza o documento do pagador (obrigatório no PIX do Mercado
   * Pago). Aceita CPF (11 dígitos) ou CNPJ (14 dígitos), com ou sem
   * máscara. Lança 400 com mensagem clara quando inválido.
   */
  function normalizarDocumento(pagador) {
    const num = somenteDigitos(pagador && (pagador.cpfCnpj || pagador.documento));
    if (num.length === 11 && cpfValido(num)) return { tipo: 'CPF', numero: num };
    if (num.length === 14 && cnpjValido(num)) return { tipo: 'CNPJ', numero: num };
    throw {
      status: 400, code: 'documento_invalido',
      error: 'Informe um CPF (11 dígitos) ou CNPJ (14 dígitos) válido do titular que assina o plano.'
    };
  }

  /* O Mercado Pago pede nome separado em first_name/last_name. Usa a
     primeira palavra como nome e o restante como sobrenome (fallback
     para o próprio nome quando só há uma palavra). */
  function nomePayer(nomeCompleto) {
    const partes = String(nomeCompleto || '').trim().split(/\s+/).filter(Boolean);
    if (!partes.length) return { first: 'Cliente', last: 'Corte Comigo' };
    const first = partes[0].slice(0, 60);
    let last = partes.slice(1).join(' ').slice(0, 60);
    if (!last) last = first;
    return { first, last };
  }

  /* Formata a expiração no padrão do Mercado Pago (ISO 8601 com offset
     de São Paulo, UTC-3 o ano inteiro desde 2019). */
  function dataExpiracaoISO(segundos) {
    const offsetMin = -180;
    const local = new Date(Date.now() + offsetMin * 60000 + segundos * 1000);
    const p = n => String(n).padStart(2, '0');
    return local.getUTCFullYear() + '-' + p(local.getUTCMonth() + 1) + '-' + p(local.getUTCDate()) +
      'T' + p(local.getUTCHours()) + ':' + p(local.getUTCMinutes()) + ':' + p(local.getUTCSeconds()) +
      '.000-03:00';
  }

  /* ---------- Mercado Pago ---------- */

  function erroMP(corpo, resp) {
    const msg = (corpo && (corpo.message || corpo.error || corpo.cause)) ||
      ('HTTP ' + (resp && resp.status));
    return typeof msg === 'string' ? msg : JSON.stringify(msg);
  }

  async function criarCobrancaMercadoPago(pag, plano, dono, shop, pagador) {
    const doc = normalizarDocumento(pagador);
    const email = String((dono && dono.email) || (shop && shop.email) || '').trim();
    if (!email) {
      throw {
        status: 409, code: 'sem_email',
        error: 'Cadastre um e-mail na sua conta para gerar a cobrança do plano.'
      };
    }
    const nome = nomePayer(dono && dono.name);
    const anual = (pag.billing_period || 30) === 365;
    const body = {
      transaction_amount: Math.round(Number(pag.amount_cents)) / 100,
      description: 'Corte Comigo — Plano ' + plano.name + ' (' + (anual ? 'anual' : '30 dias') + ')',
      payment_method_id: 'pix',
      external_reference: 'cc_pay_' + pag.id,
      date_of_expiration: dataExpiracaoISO(EXPIRA_EM_SEG),
      payer: {
        email: email,
        first_name: nome.first,
        last_name: nome.last,
        identification: { type: doc.tipo, number: doc.numero }
      }
    };
    const notif = urlWebhook();
    if (notif) body.notification_url = notif;

    const resp = await fetch(URL_API + '/v1/payments', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + chaveApi(),
        'Content-Type': 'application/json',
        'X-Idempotency-Key': 'cc_pay_' + pag.id
      },
      body: JSON.stringify(body)
    });
    let corpo = null;
    try { corpo = await resp.json(); } catch (e) { /* resposta não-JSON */ }
    if (!resp.ok || !corpo || !corpo.id) {
      const motivo = erroMP(corpo, resp);
      console.error('[payments] Mercado Pago recusou a cobrança:', motivo);
      throw { status: 502, error: 'Falha ao gerar o PIX no Mercado Pago (' + motivo + '). Tente novamente.' };
    }
    const tdata = (corpo.point_of_interaction && corpo.point_of_interaction.transaction_data) || {};
    return {
      id: String(corpo.id),
      br_code: tdata.qr_code || '',
      qr_base64: tdata.qr_code_base64 ? ('data:image/png;base64,' + tdata.qr_code_base64) : '',
      expires_at: corpo.date_of_expiration || pag.expires_at,
      dev_mode: /^TEST-/.test(chaveApi())
    };
  }

  /** GET do pagamento no Mercado Pago (fonte da verdade do status). */
  async function consultarMercadoPago(paymentId) {
    try {
      const resp = await fetch(
        URL_API + '/v1/payments/' + encodeURIComponent(paymentId),
        { headers: { 'Authorization': 'Bearer ' + chaveApi() } });
      if (!resp.ok) return null;
      return await resp.json();
    } catch (e) { return null; }
  }

  /** Traduz o status do Mercado Pago para o ciclo interno. */
  function situacaoMercadoPago(det) {
    const s = String((det && det.status) || '').toLowerCase();
    if (s === 'approved') return 'PAID';
    if (s === 'refunded' || s === 'charged_back') return 'REFUNDED';
    if (s === 'rejected' || s === 'cancelled') return 'CANCELLED';
    return null; /* pending / in_process / authorized → ainda pendente */
  }

  /* ================= API pública ================= */

  /**
   * Gera o PIX para assinar/renovar um plano. Reaproveita uma
   * cobrança pendente ainda válida da mesma loja+plano+período.
   *
   * periodo: 'mensal' (padrão, 30 dias) | 'anual' (365 dias,
   * cobrança do preço anual do plano). A opção de parcelar continua
   * aceita apenas como registro no anual.
   *
   * pagador: { cpfCnpj } — CPF/CNPJ do titular (obrigatório no
   * Mercado Pago).
   */
  async function montarCobranca(shopId, planId, periodo, parcelas, metodo, pagador) {
    const db = DB._d();

    const plano = db.plans.find(p => p.id == planId);
    if (!plano) err400('Plano não encontrado.');
    if (plano.is_free) err400('O plano Free não pode ser assinado — é o plano base gratuito.');
    /* [SEGURANÇA] Plano desativado pelo super-admin não aceita nova
       cobrança. Antes `plans.active` era ignorado aqui e a assinatura
       acontecia mesmo com o plano fora da vitrine. */
    if (plano.active === false) err400('Este plano não está disponível para contratação no momento.');

    const mtd = String(metodo || 'pix').toLowerCase();
    if (mtd !== 'pix') err400('Método de pagamento inválido.');

    const anual = String(periodo || '').toLowerCase() === 'anual';
    const dias = anual ? 365 : 30;
    const nParc = anual
      ? Math.min(12, Math.max(1, parseInt(parcelas, 10) || 12))
      : 1;
    /* Preço por período. Anual usa o preço anual próprio do plano
       (price_annual) quando disponível; senão cai para 12× o mensal. */
    const basePlano = anual
      ? (plano.price_annual != null && Number(plano.price_annual) > 0
          ? Number(plano.price_annual)
          : Number(plano.price_monthly || 0) * 12)
      : Number(plano.price_monthly || 0);

    /* price_per_employee é exibido na vitrine mas nunca era cobrado:
       o Salão anunciava "R$ 10 por profissional" e o PIX vinha só com a
       mensalidade. Cobramos a diferença entre a cota do plano e o que a
       loja realmente usa — nunca abaixo de 1, para não cobrar por
       profissional em loja com equipe vazia. */
    const porProf = plano.price_per_employee == null ? 0 : Number(plano.price_per_employee) || 0;
    let extraFuncionarios = 0;
    if (porProf > 0) {
      const { plano: planoEfet } = (typeof window.API.planoEfetivo === 'function')
        ? window.API.planoEfetivo(shopId) : { plano: plano };
      const inclusos = planoEfet && planoEfet.max_professionals != null
        ? Math.max(1, Number(planoEfet.max_professionals)) : 1;
      const emUso = db.professionals.filter(p =>
        p.barbershop_id === shopId && p.is_active).length;
      extraFuncionarios = Math.max(0, emUso - inclusos);
    }
    const totalCents = Math.round((basePlano + porProf * extraFuncionarios) * 100);

    /* pendente reutilizável? */
    const agora = agoraMsISO();
    const existente = db.payments.find(p =>
      p.barbershop_id === shopId && p.plan_id === plano.id &&
      p.billing_period === dias && (p.installments || 1) === nParc &&
      (p.metodo || 'pix') === mtd &&
      p.status === 'pending' && p.expires_at > agora);
    if (existente) return pagamentoPublico(existente);

    const pag = {
      id: DB.proximoId(),
      barbershop_id: shopId,
      plan_id: plano.id,
      billing_period: dias,
      installments: nParc,
      amount_cents: totalCents,
      metodo: mtd,
      status: 'pending',
      provider: exigirChaveParaCobrancaReal() ? 'mercadopago' : 'demo',
      provider_id: null,
      br_code: '',
      qr_base64: '',
      created_at: agoraISO(),
      expires_at: new Date(Date.now() + EXPIRA_EM_SEG * 1000).toISOString()
    };

    if (pag.provider === 'mercadopago') {
      const dono = db.users.find(u => u.id === (db.barbershops.find(b => b.id === shopId) || {}).owner_user_id);
      const shop = db.barbershops.find(b => b.id === shopId);
      const d = await criarCobrancaMercadoPago(pag, plano, dono, shop, pagador);
      pag.provider_id = d.id;
      pag.br_code = d.br_code;
      pag.qr_base64 = d.qr_base64;
      pag.expires_at = d.expires_at || pag.expires_at;
      pag.dev_mode = d.dev_mode === true;
    } else {
      /* modo simulado — código PIX inválido apenas ilustrativo */
      pag.br_code = '00020126BR.GOV.BCB.PIX01CORTECOMIGO-DEMO520400005303986' +
        '5802BR5904DEMO6009SAO PAULO62070503***' + String(pag.id).padStart(3, '0') + '6304DEMO';
    }

    db.payments.push(pag);
    DB.salvar();
    return pagamentoPublico(pag);
  }

  /**
   * Cria a cobrança do dono logado (wrapper de sessão sobre montarCobranca).
   * periodo: 'mensal' (padrão, 30 dias) | 'anual' (365 dias).
   * pagador: { cpfCnpj } — CPF/CNPJ do titular que assina.
   */
  async function criarCobrancaPlano(planId, periodo, parcelas, metodo, pagador) {
    const { shop } = exigirDonoLocal();
    return montarCobranca(shop.id, planId, periodo, parcelas, metodo, pagador);
  }

  /**
   * Job de assinatura: quando os 10 dias grátis terminam, a assinatura é
   * marcada como 'expirada' (bloqueia o acesso pago) e o dono é avisado para
   * escolher, na tela Assinatura, o plano que deseja renovar. A assinatura é
   * mensal e a cobrança só é gerada quando ele escolhe o plano
   * (criarCobrancaPlano). Idempotente: só processa assinaturas em 'trial'.
   */
  function vencerTrialsExpirados() {
    const db = DB._d();
    const hoje = DB.hojeISO();
    const vencidos = db.subscriptions.filter(s =>
      s.status === 'trial' && s.trial_ends_at && s.trial_ends_at < hoje);
    let vencidosCount = 0;
    for (const sub of vencidos) {
      try {
        sub.status = 'expirada';
        sub.updated_at = agoraISO();

        const loja = db.barbershops.find(b => b.id === sub.barbershop_id);
        const internos = window.__CC_INTERNAL || {};
        if (loja && loja.owner_user_id && typeof internos.notificar === 'function') {
          internos.notificar({
            user_id: loja.owner_user_id,
            barbershop_id: loja.id,
            type: 'assinatura',
            title: 'Seus 10 dias grátis terminaram',
            message: 'Escolha o plano que deseja renovar na tela Assinatura. ' +
              'A assinatura é mensal e a cobrança é gerada na hora que você escolher.'
          });
        }
        DB.salvar();
        vencidosCount++;
      } catch (e) {
        console.error('[assinatura][job] falha ao vencer trial ' + sub.barbershop_id + ':',
          (e && (e.error || e.message)) || e);
      }
    }
    return { vencidos: vencidosCount };
  }

  /** Consulta a situação de uma cobrança (polling da tela). */
  async function statusCobranca(paymentId) {
    const { shop } = exigirDonoLocal();
    const pag = DB._d().payments.find(p => p.id == paymentId && p.barbershop_id === shop.id);
    if (!pag) throw { status: 404, error: 'Cobrança não encontrada.' };
    if (pag.status !== 'pending') return pagamentoPublico(pag);

    /* expirou sem pagar */
    if (pag.expires_at <= agoraMsISO()) {
      pag.status = 'expired';
      DB.salvar();
      return pagamentoPublico(pag);
    }

    if (pag.provider === 'mercadopago' && pag.provider_id) {
      const det = await consultarMercadoPago(pag.provider_id);
      const situacao = situacaoMercadoPago(det);
      if (situacao === 'PAID') aplicarPagamento(pag);
      else if (situacao === 'REFUNDED') {
        pag.refunded_at = agoraMsISO();
        pag.refund_reason = 'mercadopago';
        pag.refund_id = pag.provider_id;
        DB.salvar();
        recalcularPeriodoAposEstorno(pag.barbershop_id);
      } else if (situacao === 'CANCELLED') {
        pag.status = 'cancelled';
        DB.salvar();
      }
    }
    return pagamentoPublico(pag);
  }

  /**
   * Modo simulado: confirma uma cobrança demo pendente.
   * Nunca afeta cobranças reais (provider 'mercadopago').
   */
  function confirmarCobrancaDemo(paymentId) {
    /* [SEGURANÇA] Uma cobrança demo NÃO pode ativar plano pago.
       Antes bastava faltar a chave no .env (erro comum de
       deploy) para o próprio dono "pagar" e liberar o plano premium.
       Em produção isso é dinheiro que não entra. */
    if (ambienteProducao()) {
      throw {
        status: 403,
        error: 'Simulação de pagamento indisponível em produção.'
      };
    }
    if (!simulacaoLiberada()) {
      throw {
        status: 403,
        error: 'Simulação de pagamento desativada. Defina CC_PAGAMENTO_SIMULADO=1 fora de produção para habilitar.'
      };
    }
    const { shop } = exigirDonoLocal();
    const pag = DB._d().payments.find(p => p.id == paymentId && p.barbershop_id === shop.id);
    if (!pag) throw { status: 404, error: 'Cobrança não encontrada.' };
    if (pag.provider !== 'demo') throw { status: 409, error: 'Esta cobrança é real — use o app do banco.' };
    if (pag.status !== 'pending') throw { status: 409, error: 'Cobrança já processada.' };
    aplicarPagamento(pag);
    return pagamentoPublico(pag);
  }

  /**
   * Estorno integral no Mercado Pago.
   * Só devolve sucesso quando o Mercado Pago confirma o reembolso.
   * Lança erro -> 502 quando recusado.
   */
  async function estornarNoMercadoPago(pag) {
    const resp = await fetch(
      URL_API + '/v1/payments/' + encodeURIComponent(pag.provider_id) + '/refunds', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + chaveApi(),
          'Content-Type': 'application/json',
          'X-Idempotency-Key': 'cc_refund_' + pag.id
        },
        body: JSON.stringify({})
      });
    let corpo = null;
    try { corpo = await resp.json(); } catch (e) { /* resposta não-JSON */ }
    if (!resp.ok || !corpo || !corpo.id) {
      const motivo = erroMP(corpo, resp);
      throw {
        status: 502, code: 'estorno_recusado',
        error: 'O Mercado Pago recusou o estorno (' + motivo + '). Nenhuma cobrança foi alterada.'
      };
    }
    return String(corpo.id);
  }

  /**
   * Direito de arrependimento — CDC art. 49.
   * Desistência em até 7 dias corridos da contratação/pagamento,
   * com devolução integral dos valores pagos.
   *
   * [SEGURANÇA] Validações server-side (nunca confia no cliente):
   * • só o DONO do salão da cobrança (barbershop_id batido);
   * • só cobranças 'paid' (dinheiro de fato recebido);
   * • janela de 7 dias contada a partir de paid_at;
   * • estorno idempotente (refunded_at) — nunca estorna 2×;
   * • cobrança real (mercadopago) só vira "estornada" se o Mercado
   *   Pago confirmar o reembolso (estornarNoMercadoPago); caso
   *   contrário, lança erro e nada é alterado;
   * • ao estornar, recalcula o período pago da assinatura para
   *   revogar os dias devolvidos (recalcularPeriodoAposEstorno).
   */
  async function estornarArrependimento(paymentId) {
    const { shop } = exigirDonoLocal();
    const pag = DB._d().payments.find(p => p.id == paymentId && p.barbershop_id === shop.id);
    if (!pag) throw { status: 404, error: 'Cobrança não encontrada.' };
    if (pag.status !== 'paid') throw { status: 409, code: 'nao_paga', error: 'Só é possível estornar cobranças já pagas.' };
    if (pag.refunded_at) throw { status: 409, code: 'ja_estornada', error: 'Esta cobrança já foi estornada.' };

    const paidMs = Date.parse(pag.paid_at || '');
    if (isNaN(paidMs)) throw { status: 409, code: 'sem_paid_at', error: 'Cobrança sem data de pagamento registrada.' };
    const DIAS_CDC = 7;
    const limiteMs = Date.now() - DIAS_CDC * 24 * 60 * 60 * 1000;
    if (paidMs < limiteMs) {
      throw {
        status: 409, code: 'fora_da_janela',
        error: 'O direito de arrependimento vale por 7 dias após o pagamento (CDC art. 49). ' +
          'Fora desse prazo, use "Cancelar assinatura" (acesso até o fim do período já pago).'
      };
    }

    let refund_id = null;
    if (pag.provider === 'mercadopago') {
      if (!pag.provider_id) throw { status: 409, code: 'sem_provider_id', error: 'Cobrança sem referência no Mercado Pago — entre em contato.' };
      refund_id = await estornarNoMercadoPago(pag);
    }

    pag.refunded_at = agoraMsISO();
    pag.refund_reason = 'arrependimento_cdc49';
    pag.refund_id = refund_id;
    DB.salvar();

    /* Revoga os dias que o pagamento devolvido tinha concedido. */
    recalcularPeriodoAposEstorno(shop.id);

    /* Avisa o dono: o estorno é um ato irreversível e muda o acesso dele. */
    notificarEstorno(shop, pag);

    return pagamentoPublico(pag);
  }

  /** Registra o estorno em notificações e tenta e-mail ao dono. Nunca
      lança: falha de e-mail não pode desfazer um estorno já confirmado. */
  function notificarEstorno(shop, pag) {
    try {
      const db = DB._d();
      const valor = (Number(pag.amount_cents || 0) / 100).toFixed(2);
      const texto = 'O pagamento de R$ ' + valor + ' (plano ' +
        ((db.plans.find(p => p.id === pag.plan_id) || {}).name || '—') +
        ') foi estornado. Os dias correspondentes foram removidos do seu acesso.';
      if (Array.isArray(db.notifications)) {
        db.notifications.push({
          id: DB.proximoId(),
          user_id: (shop && shop.owner_id) || null,
          barbershop_id: shop ? shop.id : null,
          type: 'payment',
          title: 'Estorno processado',
          message: texto,
          read: false,
          created_at: agoraISO()
        });
        DB.salvar();
      }
      var Mailer;
      try { require('./mailer'); } catch (e) { return; }
      const dono = db.users.find(u => u.id === (shop && shop.owner_id));
      if (dono && dono.email && Mailer && Mailer.enviarEmail) {
        var esc = function (s) {
          return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        };
        Mailer.enviarEmail({
          to: dono.email,
          subject: 'Estorno processado — ' + (shop.name || 'seu salão'),
          html: '<h2>Estorno processado</h2><p>Olá, ' + esc(dono.name || '') + '.</p><p>' +
            esc(texto) + '</p><p>Se não reconhece esta operação, fale com o suporte.</p>'
        }).catch(function () {});
      }
    } catch (e) {
      console.error('[estorno] falha ao notificar dono:', e && e.message);
    }
  }

  /**
   * Recalcula o período pago da assinatura somando periods NÃO
   * estornados (determinístico — mesmo resultado em qualquer ordem
   * de estornos). Sem cobrança paga restante, encerra o acesso.
   */
  function recalcularPeriodoAposEstorno(shopId) {
    const db = DB._d();
    const sub = db.subscriptions.find(s => s.barbershop_id === shopId);
    if (!sub) return;
    const pagos = db.payments
      .filter(p => p.barbershop_id === shopId && p.status === 'paid' && !p.refunded_at)
      .sort((a, b) => (a.paid_at || '') > (b.paid_at || '') ? 1 : -1);
    let fim = null;
    let plano = null;
    for (const p of pagos) {
      const dias = Number(p.billing_period || 30);
      if (!fim) {
        fim = DB.addDiasISO(dias, p.paid_at ? String(p.paid_at).slice(0, 10) : undefined);
      } else {
        fim = DB.addDiasISO(dias, fim);
      }
      plano = p.plan_id;
    }
    if (fim) {
      sub.current_period_end = fim;
      sub.plan_id = plano || sub.plan_id;
      /* [SEGURANÇA] NÃO ressuscite uma assinatura cancelada. Antes isto
         fazia status='ativa' incondicional: o dono cancelava, estornava
         e voltava a estar ativo. Uma assinatura 'trial' que ainda tem
         trial vigente também permanece 'trial'. */
      if (sub.status !== 'cancelada' && sub.status !== 'trial') {
        sub.status = 'ativa';
      }
    } else {
      /* Sem nenhum pagamento válido resta nada a pagar. Se o dono havia
         cancelado, o cancelamento permanece — só o fim do período some. */
      sub.current_period_end = null;
      if (sub.status !== 'cancelada') sub.status = 'expirada';
    }
    sub.updated_at = agoraISO();
    DB.salvar();
  }

  /**
   * Confirma uma cobrança pendente para testes:
   * • provider demo → ativa localmente;
   * • provider mercadopago → o Mercado Pago NÃO oferece endpoint de
   *   simulação de PIX (o pagamento é feito por um usuário de teste
   *   no app do banco). Devolvemos erro explicativo.
   */
  async function simularPagamento(paymentId) {
    const { shop } = exigirDonoLocal();
    const pag = DB._d().payments.find(p => p.id == paymentId && p.barbershop_id === shop.id);
    if (!pag) throw { status: 404, error: 'Cobrança não encontrada.' };
    if (pag.provider === 'demo') return confirmarCobrancaDemo(paymentId);
    if (pag.provider === 'mercadopago') {
      throw {
        status: 409, code: 'sem_simulacao_mp',
        error: 'O Mercado Pago não permite simular o PIX pela API. Em teste, pague o QR Code com um usuário de teste; em produção, o pagamento é confirmado automaticamente.'
      };
    }
    throw { status: 409, error: 'Cobrança inválida para simulação.' };
  }

  /** Histórico real de cobranças da loja (mais recentes primeiro). */
  function listarMinhasCobrancas() {
    const { shop } = exigirDonoLocal();
    return DB._d().payments
      .filter(p => p.barbershop_id === shop.id)
      .sort((a, b) => b.id - a.id)
      .map(pagamentoPublico);
  }

  /**
   * Webhook do Mercado Pago (server.js valida x-signature antes).
   * O evento só traz o id; reconfirmamos o pagamento na API (fonte
   * da verdade) antes de ativar ou estornar. Idempotente.
   */
  async function processarEventoWebhook(ev) {
    const tipo = String((ev && (ev.type || ev.topic)) || '');
    const acao = String((ev && ev.action) || '');
    const dados = (ev && ev.data) || {};
    const mpId = (dados && dados.id != null) ? String(dados.id) : '';
    if (tipo !== 'payment' && !/^payment\./.test(acao)) {
      return { ignored: true, event: tipo || acao };
    }
    if (!mpId) return { ignored: true, motivo: 'sem_payment_id' };

    const det = await consultarMercadoPago(mpId);
    const db = DB._d();
    let pag = db.payments.find(p => String(p.provider_id) === mpId);
    if (!pag && det && det.external_reference) {
      const m = /^cc_pay_(.+)$/.exec(String(det.external_reference));
      if (m) pag = db.payments.find(p => String(p.id) === String(m[1]));
    }
    if (!pag) return { ignored: true, motivo: 'cobranca_desconhecida' };

    const situacao = situacaoMercadoPago(det);
    if (situacao === 'PAID') {
      /* [SEGURANÇA] Uma cobrança já estornada não pode ser reativada por
         um evento de pagamento posterior ou repetido. */
      if (pag.refunded_at) {
        console.warn('[webhook] pagamento ja estornado, ativacao ignorada: ' + pag.id);
        return { ignored: true, motivo: 'cobranca_estornada' };
      }
      /* [SEGURANÇA] Confere o valor informado no evento contra o valor
         cobrado. Divergência indica evento forjado ou recombination. */
      if (det && det.transaction_amount != null && pag.amount_cents != null) {
        const valorCents = Math.round(Number(det.transaction_amount) * 100);
        if (Number.isFinite(valorCents) && valorCents !== Math.round(Number(pag.amount_cents))) {
          console.error('[webhook] valor divergente para ' + pag.id + ' — ativacao bloqueada');
          return { ignored: true, motivo: 'valor_divergente' };
        }
      }
      const mudou = aplicarPagamento(pag);
      return { ok: true, payment_db_id: pag.id, applied: mudou };
    }
    if (situacao === 'REFUNDED') {
      if (!pag.refunded_at) {
        pag.refunded_at = agoraMsISO();
        pag.refund_reason = 'webhook_mercadopago';
        pag.refund_id = mpId;
        DB.salvar();
        recalcularPeriodoAposEstorno(pag.barbershop_id);
      }
      return { ok: true, payment_db_id: pag.id, refunded: true };
    }
    if (situacao === 'CANCELLED') {
      if (pag.status === 'pending') {
        pag.status = 'cancelled';
        DB.salvar();
      }
      return { ok: true, payment_db_id: pag.id, cancelled: true };
    }
    return { ignored: true, motivo: 'status_' + ((det && det.status) || 'desconhecido') };
  }

  function err400(msg) { throw { status: 400, error: msg }; }

  /**
   * A loja pode acessar o painel? O plano Free é sempre liberado
   * (leituras + edição do perfil da loja). Planos pagos exigem
   * trial vigente ou período pago corrente (inclusive cancelada
   * dentro do prazo — acesso encerra ao fim do período).
   */
  function acessoLiberado(shopId) {
    if (typeof window.API.modoGratuito === 'function' && window.API.modoGratuito()) return true;
    const db = DB._d();
    const hoje = DB.hojeISO();
    const sub = db.subscriptions.find(s => s.barbershop_id == shopId);
    const plano = sub && db.plans.find(p => p.id === sub.plan_id);
    if (plano && plano.is_free) return true;
    if (!sub) return false;
    if (sub.status === 'trial') {
      return !!sub.trial_ends_at && sub.trial_ends_at >= hoje;
    }
    if (sub.status === 'cancelada') {
      return !!sub.current_period_end && sub.current_period_end >= hoje;
    }
    if (sub.status !== 'ativa') return false;
    return !!sub.current_period_end && sub.current_period_end >= hoje;
  }

  Object.assign(window.API, {
    criarCobrancaPlano,
    statusCobranca,
    listarMinhasCobrancas,
    confirmarCobrancaDemo,
    simularCobranca: simularPagamento,
    estornarArrependimento,
    processarEventoWebhook,
    acessoLiberado
  });

  /* Internos do job de assinatura (fora do roteador RPC). */
  window.__CC_INTERNAL = window.__CC_INTERNAL || {};
  window.__CC_INTERNAL.vencerTrialsExpirados = vencerTrialsExpirados;
  window.__CC_INTERNAL.criarCobrancaParaLoja = montarCobranca;
})();
