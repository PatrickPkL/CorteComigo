/* ============================================================
   Corte Comigo – super-admin/js/suporte-sa.js
   Suporte: lista todos os tickets, filtra por status e responde.
   Requer super-auth.js carregado antes.
   ============================================================ */

document.addEventListener('DOMContentLoaded', function () {

  if (!saAuth.check()) return;

  var tbody = document.getElementById('tbody-tickets');
  var totalAbertos = document.getElementById('sa-total-abertos');
  var botoesFiltro = document.querySelectorAll('#sa-filtros .sa-filtro-btn');
  var btnSair = document.getElementById('btn-sair');

  var filtroAtual = 'todos';
  var tickets = [];

  /* ---------- carregar tickets ---------- */
  function carregar() {
    var url = '/api/super-admin/tickets?status=' + encodeURIComponent(filtroAtual);
    fetch(url, { headers: saAuth.headers() })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) {
          saAuth.logout();
          return;
        }
        return res.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          showToast(data.error, 'error');
          return;
        }
        tickets = data.data || [];
        renderizar();
      })
      .catch(function () {
        showToast('Erro ao carregar tickets.', 'error');
      });
  }

  /* ---------- contador de abertos (carregado à parte) ---------- */
  function carregarContador() {
    fetch('/api/super-admin/tickets?status=todos', { headers: saAuth.headers() })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (!data || data.error) return;
        var todos = data.data || [];
        var abertos = todos.filter(function (t) { return t.status === 'aberto'; }).length;
        if (totalAbertos) totalAbertos.textContent = abertos;
      })
      .catch(function () { /* noop */ });
  }

  /* ---------- badge ---------- */
  function badgeStatus(status) {
    var map = {
      aberto: ['badge-aberto', 'Aberto'],
      respondido: ['badge-respondido', 'Respondido'],
      resolvido: ['badge-resolvido', 'Resolvido'],
      fechado: ['badge-fechado', 'Fechado'],
      em_andamento: ['badge-em_andamento', 'Em Andamento']
    };
    var par = map[status] || [null, status];
    var span = document.createElement('span');
    span.className = 'badge ' + (par[0] || 'badge-fechado');
    span.textContent = par[1];
    return span;
  }

  /* ---------- renderizar ---------- */
  function renderizar() {
    if (!tbody) return;
    tbody.innerHTML = '';

    if (!tickets.length) {
      var trVazio = document.createElement('tr');
      var tdVazio = document.createElement('td');
      tdVazio.colSpan = 7;
      tdVazio.className = 'sa-vazio';
      tdVazio.textContent = 'Nenhum ticket encontrado.';
      trVazio.appendChild(tdVazio);
      tbody.appendChild(trVazio);
      return;
    }

    tickets.forEach(function (t) {
      var tr = document.createElement('tr');

      var tdData = document.createElement('td');
      tdData.className = 'sa-data';
      tdData.textContent = t.criadoEm ? formatarData(t.criadoEm) : '—';

      var tdLoja = document.createElement('td');
      tdLoja.textContent = t.lojaNome || '—';

      var tdCidade = document.createElement('td');
      tdCidade.textContent = t.lojaCidade || '—';

      var tdAssunto = document.createElement('td');
      tdAssunto.textContent = t.assunto || '—';

      var tdMsg = document.createElement('td');
      tdMsg.className = 'sa-msg-trunc';
      tdMsg.textContent = t.mensagem || '—';
      tdMsg.title = t.mensagem || '';

      var tdStatus = document.createElement('td');
      tdStatus.appendChild(badgeStatus(t.status));

      var tdAcoes = document.createElement('td');
      var btn = document.createElement('button');
      btn.className = 'sa-btn sa-btn-brass';
      btn.textContent = 'Responder';
      btn.addEventListener('click', function () { abrirModal(t); });
      tdAcoes.appendChild(btn);

      tr.appendChild(tdData);
      tr.appendChild(tdLoja);
      tr.appendChild(tdCidade);
      tr.appendChild(tdAssunto);
      tr.appendChild(tdMsg);
      tr.appendChild(tdStatus);
      tr.appendChild(tdAcoes);
      tbody.appendChild(tr);
    });
  }

  /* ---------- filtros ---------- */
  if (botoesFiltro.length) {
    botoesFiltro.forEach(function (btn) {
      btn.addEventListener('click', function () {
        botoesFiltro.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        filtroAtual = btn.getAttribute('data-status');
        carregar();
      });
    });
  }

  /* ---------- modal ---------- */
  var modal = document.getElementById('sa-modal');
  var modalId = document.getElementById('sa-modal-ticket-id');
  var modalAssunto = document.getElementById('sa-modal-assunto');
  var modalMensagem = document.getElementById('sa-modal-mensagem');
  var modalMeta = document.getElementById('sa-modal-meta');
  var modalStatus = document.getElementById('sa-modal-status');
  var modalResposta = document.getElementById('sa-modal-resposta');

  function abrirModal(t) {
    modalId.value = t.id;
    modalAssunto.textContent = t.assunto || '—';
    modalMensagem.textContent = t.mensagem || '—';
    modalMeta.textContent =
      'Loja: ' + (t.lojaNome || '—') +
      (t.lojaCidade ? ' · ' + t.lojaCidade : '') +
      ' · ' + (t.criadoEm ? formatarData(t.criadoEm) : '') +
      ' · Status atual: ' + (t.status || 'aberto');
    modalStatus.value = (t.status === 'aberto') ? 'respondido' : (t.status || 'respondido');
    modalResposta.value = t.resposta || '';
    modal.classList.add('show');
  }

  function fecharModal() {
    modal.classList.remove('show');
  }

  if (document.getElementById('sa-modal-cancel')) {
    document.getElementById('sa-modal-cancel').addEventListener('click', fecharModal);
  }

  if (modal && modal.addEventListener) {
    modal.addEventListener('click', function (e) {
      if (e.target === modal) fecharModal();
    });
  }

  var btnSalvar = document.getElementById('sa-modal-salvar');
  if (btnSalvar) {
    btnSalvar.addEventListener('click', function () {
      var id = modalId.value;
      var status = modalStatus.value;
      var resposta = modalResposta.value.trim();

      btnSalvar.disabled = true;
      btnSalvar.textContent = 'Salvando...';

      fetch('/api/super-admin/ticket/' + id, {
        method: 'PUT',
        headers: saAuth.headers(),
        body: JSON.stringify({ status: status, resposta: resposta })
      })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (data.error) {
            showToast(data.error, 'error');
          } else {
            showToast('Ticket atualizado com sucesso!');
            fecharModal();
            carregar();
            carregarContador();
          }
          btnSalvar.disabled = false;
          btnSalvar.textContent = 'Salvar';
        })
        .catch(function () {
          showToast('Erro ao salvar ticket.', 'error');
          btnSalvar.disabled = false;
          btnSalvar.textContent = 'Salvar';
        });
    });
  }

  /* ---------- logout ---------- */
  if (btnSair) {
    btnSair.addEventListener('click', function (e) {
      e.preventDefault();
      saAuth.logout();
    });
  }

  /* ============================================================
     MÓDULO DE REEMBOLSO
     Abas: "Pedidos de Reembolso" (EM_ANALISE) e "Reembolsados"
     (REEMBOLSADO). Ambas leem o MESMO endpoint, filtrando status —
     por isso o card migra sozinho de uma aba para a outra quando o
     status vira REEMBOLSADO.
     ============================================================ */

  var painelChamados = document.getElementById('sa-painel-chamados');
  var painelReembolsos = document.getElementById('sa-painel-reembolsos');
  var botoesAba = document.querySelectorAll('#sa-abas .sa-filtro-btn');
  var botoesReb = document.querySelectorAll('#sa-filtros-reembolso .sa-filtro-btn');
  var tbodyReb = document.getElementById('tbody-reembolsos');
  var totalReb = document.getElementById('sa-total-reembolsos');
  var abaAtual = 'chamados';
  var statusRebAtual = 'EM_ANALISE';

  function trocarAba(aba) {
    abaAtual = aba;
    if (painelChamados) painelChamados.hidden = aba !== 'chamados';
    if (painelReembolsos) painelReembolsos.hidden = aba !== 'reembolsos';
    if (aba === 'reembolsos') carregarReembolsos();
  }

  if (botoesAba.length) {
    botoesAba.forEach(function (btn) {
      btn.addEventListener('click', function () {
        botoesAba.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        trocarAba(btn.getAttribute('data-aba'));
      });
    });
  }

  if (botoesReb.length) {
    botoesReb.forEach(function (btn) {
      btn.addEventListener('click', function () {
        botoesReb.forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
        statusRebAtual = btn.getAttribute('data-reb');
        carregarReembolsos();
      });
    });
  }

  function apiReembolsos(status) {
    return fetch('/api/super-admin/reembolsos?status=' + encodeURIComponent(status), { headers: saAuth.headers() })
      .then(function (res) {
        if (res.status === 401 || res.status === 403) { saAuth.logout(); return null; }
        return res.json();
      })
      .then(function (data) {
        if (!data) return null;
        if (data.error) { showToast(data.error, 'error'); return null; }
        return data.data || [];
      });
  }

  function renderReembolsos(lista) {
    if (!tbodyReb) return;
    tbodyReb.innerHTML = '';

    if (!lista.length) {
      var trV = document.createElement('tr');
      var tdV = document.createElement('td');
      tdV.colSpan = 8;
      tdV.className = 'sa-vazio';
      tdV.textContent = statusRebAtual === 'REEMBOLSADO'
        ? 'Nenhum reembolso concluído no histórico.'
        : 'Nenhum pedido de reembolso aguardando análise.';
      trV.appendChild(tdV);
      tbodyReb.appendChild(trV);
      return;
    }

    lista.forEach(function (r) {
      var tr = document.createElement('tr');

      var tdData = document.createElement('td');
      tdData.className = 'sa-data';
      tdData.textContent = r.criadoEm ? formatarData(r.criadoEm) : '—';

      var tdUser = document.createElement('td');
      tdUser.textContent = r.usuario_nome || '—';

      var tdLoja = document.createElement('td');
      tdLoja.textContent = r.loja_nome || '—' + (r.loja_cidade ? ' · ' + r.loja_cidade : '');

      var tdPlano = document.createElement('td');
      tdPlano.style.fontFamily = 'monospace';
      tdPlano.textContent = (r.plano_nome || '—') + (r.plano_valor_mensal ? ' · R$ ' + Number(r.plano_valor_mensal).toFixed(2).replace('.', ',') : '');

      var tdConta = document.createElement('td');
      tdConta.className = 'sa-msg-trunc';
      tdConta.textContent = [r.usuario_email, r.usuario_telefone].filter(Boolean).join(' · ') || '—';
      tdConta.title = tdConta.textContent;

      var tdMotivo = document.createElement('td');
      tdMotivo.className = 'sa-msg-trunc';
      tdMotivo.textContent = r.motivo || '—';
      tdMotivo.title = r.motivo || '';

      var tdPix = document.createElement('td');
      tdPix.className = 'sa-msg-trunc';
      tdPix.textContent = r.temporary_pix_key || '—';
      tdPix.title = r.temporary_pix_key || '';

      var tdAcoes = document.createElement('td');

      if (r.status === 'REEMBOLSADO') {
        var btnDel = document.createElement('button');
        btnDel.className = 'sa-btn sa-btn-perigo';
        btnDel.textContent = 'Excluir';
        btnDel.addEventListener('click', function () {
          if (!window.confirm('Ocultar este pedido das listas? O registro é preservado no banco.')) return;
          btnDel.disabled = true;
          btnDel.textContent = 'Removendo...';
          fetch('/api/super-admin/reembolso/' + encodeURIComponent(r.id), {
            method: 'DELETE',
            headers: saAuth.headers()
          })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (data && data.error) showToast(data.error, 'error');
              else { showToast('Pedido ocultado das listas.'); carregarReembolsos(); }
              btnDel.disabled = false;
              btnDel.textContent = 'Excluir';
            })
            .catch(function () {
              showToast('Erro ao ocultar o pedido.', 'error');
              btnDel.disabled = false;
              btnDel.textContent = 'Excluir';
            });
        });
        tdAcoes.appendChild(btnDel);
      } else {
        var btnOk = document.createElement('button');
        btnOk.className = 'sa-btn sa-btn-brass';
        btnOk.textContent = 'Realizado';
        btnOk.addEventListener('click', function () {
          if (!window.confirm('Confirmar que o reembolso foi REALIZADO?\nO barbeiro será notificado automaticamente.')) return;
          btnOk.disabled = true;
          btnOk.textContent = 'Salvando...';
          fetch('/api/super-admin/reembolso/' + encodeURIComponent(r.id), {
            method: 'PUT',
            headers: saAuth.headers(),
            body: JSON.stringify({ status: 'REEMBOLSADO' })
          })
            .then(function (res) { return res.json(); })
            .then(function (data) {
              if (data && data.error) {
                showToast(data.error, 'error');
                btnOk.disabled = false;
                btnOk.textContent = 'Realizado';
                return;
              }
              showToast('Reembolso marcado como realizado. O barbeiro foi notificado!');
              /* Recarrega a lista e o contador: o card some desta aba
                 (não é mais EM_ANALISE) e passa a constar em Reembolsados. */
              carregarReembolsos();
            })
            .catch(function () {
              showToast('Erro ao marcar como realizado.', 'error');
              btnOk.disabled = false;
              btnOk.textContent = 'Realizado';
            });
        });
        tdAcoes.appendChild(btnOk);
      }

      tr.appendChild(tdData);
      tr.appendChild(tdUser);
      tr.appendChild(tdLoja);
      tr.appendChild(tdConta);
      tr.appendChild(tdMotivo);
      tr.appendChild(tdPix);
      tr.appendChild(tdAcoes);
      tbodyReb.appendChild(tr);
    });
  }

  function carregarReembolsos() {
    if (!tbodyReb) return;
    if (abaAtual !== 'reembolsos') return;
    tbodyReb.innerHTML = '<tr><td colspan="7" class="sa-vazio">Carregando...</td></tr>';

    Promise.all([apiReembolsos(statusRebAtual), apiReembolsos('EM_ANALISE')])
      .then(function (res) {
        if (res[0]) renderReembolsos(res[0]);
        if (totalReb && res[1]) totalReb.textContent = res[1].length;
      })
      .catch(function () {
        tbodyReb.innerHTML = '<tr><td colspan="7" class="sa-vazio">Erro ao carregar reembolsos.</td></tr>';
      });
  }

  /* Carrega o contador de pedidos assim que a página abre, para o
     Super Admin saber que há algo aguardando — mesmo na aba Chamados. */
  apiReembolsos('EM_ANALISE').then(function (lista) {
    if (totalReb && lista) totalReb.textContent = lista.length;
  }).catch(function () { /* noop */ });

  /* ---------- formatadores ---------- */
  function formatarData(valor) {
    var d = new Date(valor);
    if (isNaN(d.getTime())) return String(valor);
    return d.toLocaleString('pt-BR');
  }

  /* ---------- init ---------- */
  carregar();
  carregarContador();
});
