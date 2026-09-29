/* ============================================================
   Corte Comigo – admin/js/suporte.js
   Tickets de atendimento (RF extra mantido da v1) + módulo de
   Reembolso (CDC art. 49 · 7 dias).

   A trava de 7 dias é SEMPRE decidida pelo servidor
   (API.reembolsoDisponivel / API.solicitarReembolso): o cliente
   apenas renderiza o resultado — nunca é fronteira de segurança.
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

  const form = document.getElementById('form-suporte');
  const tb = document.getElementById('tb-chamados');

  function badge(status) {
    const map = {
      aberto: ['badge-pendente', 'Aberto'],
      respondido: ['badge-confirmado', 'Respondido'],
      resolvido: ['badge-confirmado', 'Resolvido']
    };
    const [cls, txt] = map[status] || ['badge-pendente', status];
    return '<span class="badge ' + cls + '">' + esc(txt) + '</span>';
  }

  function corpoMensagem(c) {
    const msg = esc(c.message || c.mensagem || '');
    let html = '<div>' + msg + '</div>';
    const resposta = c.resposta;
    if (c.status !== 'aberto' && resposta != null && String(resposta).trim() !== '') {
      html += '<div class="suporte-resposta">Resposta da equipe: ' + esc(String(resposta)) + '</div>';
    }
    return html;
  }

  function renderChamados() {
    if (!tb) return;
    let chamados = [];
    try { chamados = API.ticketsDoSalao(loja.id); } catch (e) { /* noop */ }

    if (!chamados.length) {
      tb.innerHTML = '<tr><td colspan="4"><div class="empty-state"><h3>Nenhum chamado ainda</h3><p>Envie sua primeira mensagem pelo formulário acima.</p></div></td></tr>';
      return;
    }
    tb.innerHTML = chamados.map(c =>
      '<tr>' +
        '<td class="mono">' + DB.fmtDataBR(c.created_at || c.criadoEm) + '</td>' +
        '<td style="white-space:nowrap;">' + esc(c.subject || c.assunto || '') + '</td>' +
        '<td style="max-width:420px;">' + corpoMensagem(c) + '</td>' +
        '<td>' + badge(c.status) + '</td>' +
      '</tr>'
    ).join('');
  }

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const sel = document.getElementById('sup-assunto');
    const msg = document.getElementById('sup-mensagem');
    const texto = msg.value.trim();
    if (texto.length < 10) {
      showToast('Descreva sua mensagem com pelo menos 10 caracteres.', 'error');
      return;
    }
    try {
      API.criarTicket(loja.id, sel.options[sel.selectedIndex].text, texto);
      showToast('Mensagem enviada! Responderemos em até 24h úteis.');
      form.reset();
      renderChamados();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  renderChamados();
});

/* ============================================================
   MÓDULO DE REEMBOLSO
   ============================================================ */

(function reembolso() {
  'use strict';

  document.addEventListener('DOMContentLoaded', function () {
    const usuario = exigirLogin('dono');
    if (!usuario) return;
    if (!Auth.salaoDoUsuario(usuario)) return; /* redirecionado pelo suporte.js */

    const boxAlerta = document.getElementById('reb-alerta');
    const boxForm = document.getElementById('reb-form-box');
    const boxEnviado = document.getElementById('reb-enviado-box');
    const boxHistorico = document.getElementById('reb-historico');
    if (!boxAlerta || !boxForm || !boxEnviado) return;

    const form = document.getElementById('form-reembolso');
    const inpPix = document.getElementById('reb-pix');
    const errPix = document.getElementById('reb-pix-erro');
    const txtMotivo = document.getElementById('reb-motivo');
    const errMotivo = document.getElementById('reb-motivo-erro');
    const elPrazo = document.getElementById('reb-prazo');
    const elProtocolo = document.getElementById('reb-protocolo');
    const elChaveEnviada = document.getElementById('reb-chave-enviada');
    const elBadge = document.getElementById('reb-badge-status');
    const btnGmail = document.getElementById('reb-btn-gmail');
    const btnConfirmar = document.getElementById('reb-btn-confirmar');
    const elLista = document.getElementById('reb-lista');

    /* ---- validação (espelha validarChavePix em backend/api.js) ----
       A checagem de CPF vem ANTES da de UUID para que um CPF sempre
       receba a mensagem específica. Não usamos \d{11,} aqui (o backend
       também não usa): o último grupo de uma EVP válida tem 12
       caracteres hex e pode ser 100% numérico, então esse regex
       rejeitaria chaves Pix legítimas. */
    function pareceCpf(s) {
      if (/^\d{11}$/.test(s)) return true;
      if (/^\d{3}\.\d{3}\.\d{3}-\d{2}$/.test(s)) return true;
      if (!/^[\d.\-\s]+$/.test(s)) return false;
      return s.replace(/[.\-\s]/g, '').length === 11;
    }
    const RE_EVP = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const MSG_CPF = 'Não aceitamos CPF. Por favor, informe uma chave Pix temporária/aleatória.';
    const MSG_EVP = 'Informe uma chave Pix temporária/aleatória (EVP) no formato UUID.';

    const STATUS_LABEL = {
      PENDENTE_GMAIL: ['badge-pendente', 'Aguardando envio do e-mail'],
      EM_ANALISE: ['badge-confirmado', 'Em análise'],
      REEMBOLSADO: ['badge-confirmado', 'Reembolsado']
    };

    let situacao = null;   /* retorno de API.reembolsoDisponivel() */
    let pedido = null;     /* pedido em aberto, se houver */

    function mostrar(caixa) {
      boxAlerta.hidden = caixa !== boxAlerta;
      boxForm.hidden = caixa !== boxForm;
      boxEnviado.hidden = caixa !== boxEnviado;
    }

    function setErro(input, el, msg) {
      el.textContent = msg || '';
      if (msg) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      return !msg;
    }

    /* O campo é zerado quando um CPF é detectado enquanto o usuário digita.
       Guardamos o motivo para que o envio não sobrescreva a orientação de
       CPF com a mensagem genérica de "campo vazio". */
    let cpfRecusado = false;

    function validarChave(valor) {
      const s = String(valor || '').trim();
      if (!s) return cpfRecusado ? MSG_CPF : 'Informe a chave Pix temporária/aleatória.';
      if (pareceCpf(s)) return MSG_CPF;
      if (!RE_EVP.test(s)) return MSG_EVP;
      return null;
    }

    /* Bloqueio imediato: enquanto digita, um CPF é recusado na hora */
    inpPix?.addEventListener('input', function () {
      const s = inpPix.value.trim();
      if (pareceCpf(s)) {
        inpPix.value = '';
        cpfRecusado = true;
        setErro(inpPix, errPix, MSG_CPF);
        showToast(MSG_CPF, 'error');
        return;
      }
      if (s) cpfRecusado = false;
      setErro(inpPix, errPix, '');
    });
    /* Ao colar (o evento 'input' nem sempre cobre colagem em alguns
       navegadores antigos) */
    inpPix?.addEventListener('paste', function (e) {
      const texto = (e.clipboardData || window.clipboardData).getData('text') || '';
      if (pareceCpf(texto.trim())) {
        e.preventDefault();
        inpPix.value = '';
        cpfRecusado = true;
        setErro(inpPix, errPix, MSG_CPF);
        showToast(MSG_CPF, 'error');
      }
    });

    form?.addEventListener('submit', function (e) {
      e.preventDefault();

      const erroPix = validarChave(inpPix.value);
      const okPix = setErro(inpPix, errPix, erroPix);

      const motivo = txtMotivo.value.trim();
      const okMotivo = setErro(txtMotivo, errMotivo,
        motivo.length < 10 ? 'Descreva o motivo do reembolso com pelo menos 10 caracteres.' : '');

      if (!okPix || !okMotivo) {
        showToast(erroPix || 'Descreva o motivo do reembolso.', 'error');
        return;
      }

      const btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; btn.textContent = 'Enviando...'; }

      try {
        pedido = API.solicitarReembolso({
          temporary_pix_key: inpPix.value.trim(),
          reason: motivo
        });
        showToast('Solicitação registrada! Agora envie o relatório pelo Gmail.');
        form.reset();
        pintarEnviado(pedido);
        carregar();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
        /* Se o servidor recusou por prazo, re-renderiza o alerta. */
        if (err2 && err2.status === 409) carregar();
      } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Enviar solicitação'; }
      }
    });

    function montarMailto(p) {
      if (!btnGmail) return '';
      const email = (situacao && situacao.email_contato) || '';
      const assunto = '[Reembolso ' + p.id + '] Solicitação de reembolso — ' +
        ((Auth.salaoDoUsuario(Auth.usuarioAtual()) || {}).name || 'barbearia');
      const corpo =
        'ID da solicitação: ' + p.id + '\n' +
        'Data: ' + p.created_at + '\n\n' +
        'Chave Pix temporária/aleatória: ' + p.temporary_pix_key + '\n\n' +
        'Relatório / motivo do reembolso:\n' + p.reason + '\n\n' +
        '— Enviado pela central de suporte do Corte Comigo.';
      return 'mailto:' + email +
        '?subject=' + encodeURIComponent(assunto) +
        '&body=' + encodeURIComponent(corpo);
    }

    function pintarEnviado(p) {
      if (!p) return;
      elProtocolo.textContent = p.id;
      elChaveEnviada.textContent = p.temporary_pix_key;
      const par = STATUS_LABEL[p.status] || ['badge-pendente', p.status];
      elBadge.innerHTML = '<span class="badge ' + par[0] + '">' + esc(par[1]) + '</span>';
      if (btnGmail) btnGmail.href = montarMailto(p);
      /* "Já enviei o e-mail" só faz sentido enquanto o pedido aguarda. */
      if (btnConfirmar) btnConfirmar.hidden = p.status !== 'PENDENTE_GMAIL';
      mostrar(boxEnviado);
    }

    btnConfirmar?.addEventListener('click', function () {
      if (!pedido) return;
      btnConfirmar.disabled = true;
      try {
        pedido = API.confirmarEnvioGmail(pedido.id);
        showToast('Pedido confirmado! Nossa equipe já pode visualizá-lo.');
        pintarEnviado(pedido);
        carregar();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      } finally {
        btnConfirmar.disabled = false;
      }
    });

    function renderHistorico(lista) {
      if (!elLista) return;
      if (!lista.length) { boxHistorico.hidden = true; return; }
      boxHistorico.hidden = false;
      elLista.innerHTML = lista.slice(0, 5).map(function (r) {
        const par = STATUS_LABEL[r.status] || ['badge-pendente', r.status];
        return '<div class="reb-status-linha">' +
          '<span class="mono">' + esc(DB.fmtDataBR(String(r.created_at || '').slice(0, 10))) + '</span>' +
          '<span class="badge ' + par[0] + '">' + esc(par[1]) + '</span>' +
        '</div>';
      }).join('');
    }

    function carregar() {
      try {
        situacao = API.reembolsoDisponivel();
      } catch (err2) {
        mostrar(boxAlerta);
        return;
      }

      /* Pedido em aberto tem prioridade: a UI mostra o passo a passo. */
      if (situacao.pedido_aberto) {
        pedido = situacao.pedido_aberto;
        pintarEnviado(pedido);
      } else if (!situacao.dentro_do_prazo) {
        pedido = null;
        mostrar(boxAlerta);
      } else {
        pedido = null;
        mostrar(boxForm);
        if (elPrazo) {
          elPrazo.textContent = situacao.dias_restantes <= 0
            ? 'O prazo termina hoje.'
            : 'Restam ' + situacao.dias_restantes + ' dia(s) para solicitar o reembolso.';
        }
      }

      try { renderHistorico(API.meusReembolsos() || []); } catch (e) { /* noop */ }
    }

    carregar();
  });
})();

