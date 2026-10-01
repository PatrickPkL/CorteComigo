/* ============================================================
   Corte Comigo – admin/js/clientes.js
   CRM: lista de clientes (RF-044), ficha com notas e histórico
   (RF-045/047). O cadastro manual foi removido: os clientes são
   criados automaticamente pelos agendamentos (RBAC).
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const usuario = exigirLogin(['dono', 'barbeiro', 'dependente']);
  if (!usuario) return;
  const loja = Auth.salaoDoUsuario(usuario);
  if (!loja) {
    /* dependente com conta criada por autoatendimento e ainda sem vínculo */
    if (usuario.role === 'dependente' && telaVinculoPendente()) return;
    showToast('Nenhum salão vinculado a esta conta.', 'error');
    setTimeout(() => { window.location.href = '/login'; }, 1200);
    return;
  }

  const tbody = document.getElementById('tbody-clientes');
  const busca = document.getElementById('busca-cliente');
  if (!tbody) return;

  function render() {
    let clientes;
    try {
      clientes = API.listarClientes({ q: busca?.value || '' }).items;
    } catch (e) {
      showToast(msgErro(e), 'error');
      return;
    }

    if (!clientes.length) {
      tbody.innerHTML = '<tr><td colspan="6"><div class="empty-state"><h3>Nenhum cliente por aqui</h3><p>Os clientes aparecem automaticamente conforme os agendamentos chegam.</p></div></td></tr>';
      return;
    }

    tbody.innerHTML = clientes.map(c =>
      '<tr>' +
        '<td>' + esc(c.name) + ' ' + (c.blocked ? '<span class="badge-status st-cancelado">Bloqueado</span>' : '') + '</td>' +
        '<td class="mono">' + esc(c.phone || '—') + '</td>' +
        '<td>' + esc(c.email || '—') + '</td>' +
        '<td>' + esc(c.last_visit_at ? DB.fmtDataBR(String(c.last_visit_at).slice(0, 10)) : '—') + '</td>' +
        '<td>' + esc(String(c.total_visits)) + ' · <span class="mono">' + esc(DB.fmtBRL(c.total_spent)) + '</span></td>' +
        '<td><button class="btn btn-outline btn-ver-perfil" data-id="' + esc(c.id) + '">Ver perfil</button></td>' +
      '</tr>'
    ).join('');

    tbody.querySelectorAll('.btn-ver-perfil').forEach(btn => {
      btn.addEventListener('click', () => abrirPerfil(btn.dataset.id));
    });
  }

  busca?.addEventListener('input', debounce(render, 300));

  function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

  /* ---------- ficha do cliente ---------- */
  const modal = document.getElementById('modal-cliente-perfil');
  let clienteAtual = null;

  function abrirPerfil(id) {
    if (!modal) return;
    let c;
    try { c = API.getCliente(id); } catch (e) { showToast(msgErro(e), 'error'); return; }
    clienteAtual = c;

    document.getElementById('cp-titulo').textContent = 'Perfil · ' + c.name;
    /* btn-cp-bloquear/desbloquear/salvar já têm type="button" no HTML e não
       estão dentro de <form>; nada a corrigir aqui. */
    document.getElementById('cp-info').innerHTML =
      '<p style="color:var(--text-muted);font-size:14px;margin-bottom:4px;">Telefone: ' +
        '<strong style="color:var(--text)" class="mono">' + esc(c.phone || '—') + '</strong></p>' +
      '<p style="color:var(--text-muted);font-size:14px;">E-mail: ' +
        '<strong style="color:var(--text)">' + esc(c.email || '—') + '</strong></p>' +
      '<p style="color:var(--text-muted);font-size:14px;">Visitas: <strong style="color:var(--text)">' +
        esc(String(c.total_visits)) + '</strong> · Total gasto: <strong style="color:var(--text)" class="mono">' +
        esc(DB.fmtBRL(c.total_spent)) + '</strong></p>';

    setVal('cp-telefone', c.phone || '');
    setVal('cp-email', c.email || '');
    document.getElementById('cp-notas').value = c.notes || '';

    /* estado de bloqueio do cliente */
    let bloqueado = false;
    try { bloqueado = !!(API.clienteBloqueado(c.id) || {}).blocked; } catch (e) { /* noop */ }
    const btnBloquear = document.getElementById('btn-cp-bloquear');
    const btnDesbloquear = document.getElementById('btn-cp-desbloquear');
    const infoBloqueio = document.getElementById('cp-bloqueio-info');
    if (btnBloquear) btnBloquear.style.display = bloqueado ? 'none' : '';
    if (btnDesbloquear) btnDesbloquear.style.display = bloqueado ? '' : 'none';
    if (infoBloqueio) {
      infoBloqueio.textContent = bloqueado
        ? 'Este cliente está bloqueado e não pode agendar nesta barbearia.'
        : '';
    }

    renderHistorico(c.id);
    abrirModal(modal);
  }

  function renderHistorico(clienteId) {
    const tabela = document.getElementById('cp-tabela');
    if (!tabela) return;
    let ags = [];
    try { ags = API.agendamentosDoCliente(clienteId); } catch (e) { /* noop */ }

    tabela.innerHTML = ags.slice(0, 8).map(a =>
      '<tr>' +
        '<td>' + esc(fmtDataHoraBR(a.starts_at)) + '</td>' +
        '<td>' + esc(a.services.map(s => s.name).join(' + ') || '—') + '</td>' +
        '<td class="mono">' + esc(DB.fmtBRL(a.price_total)) + '</td>' +
        '<td>' + badgeStatus(a.status) + '</td>' +
      '</tr>'
    ).join('') || '<tr><td colspan="4" style="color:var(--text-muted)">Sem histórico.</td></tr>';
  }

  document.getElementById('btn-cp-salvar')?.addEventListener('click', (ev) => {
    if (!clienteAtual) return;
    const btn = ev.currentTarget;
    const inpTel = document.getElementById('cp-telefone');
    const inpEmail = document.getElementById('cp-email');
    const tel = (inpTel ? inpTel.value : '').trim();
    const email = (inpEmail ? inpEmail.value : '').trim();

    /* validava nada: gravava "  " como telefone e sobrepunha o e-mail
       existente com string vazia */
    if (tel) {
      const d = tel.replace(/\D/g, '');
      if (d.length < 10 || d.length > 13) {
        showToast('Telefone inválido: use de 10 a 13 dígitos.', 'error');
        if (inpTel) inpTel.focus();
        return;
      }
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('E-mail inválido.', 'error');
      if (inpEmail) inpEmail.focus();
      return;
    }
    /* NÃO bloquear telefone igual ao atual: o mesmo botão salva as notas
       também, e quem só edita a observação não mudou o telefone. O backend
       já ignora o próprio id na checagem de duplicidade. */

    btn.disabled = true;
    try {
      API.atualizarCliente(clienteAtual.id, {
        notes: document.getElementById('cp-notas').value,
        phone: tel,
        email: email
      });
      showToast('Cliente atualizado!');
      fecharModal(modal);
      render();
    } catch (e) {
      showToast(msgErro(e), 'error');
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById('btn-fechar-modal-cliente')?.addEventListener('click', () =>
    fecharModal(modal));
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) fecharModal(modal);
  });

  /* ---------- bloqueio / denúncia de cliente ---------- */
  const modalDenCli = document.getElementById('modal-denunciar-cliente');

  document.getElementById('btn-cp-bloquear')?.addEventListener('click', () => {
    if (!clienteAtual) return;
    if (!confirm('Bloquear ' + clienteAtual.name + '? O cliente não poderá agendar nesta barbearia.')) return;
    try {
      API.bloquearCliente(clienteAtual.id);
      showToast('Cliente bloqueado.');
      abrirPerfil(clienteAtual.id);
    } catch (e) { showToast(msgErro(e), 'error'); }
  });

  document.getElementById('btn-cp-desbloquear')?.addEventListener('click', () => {
    if (!clienteAtual) return;
    try {
      API.desbloquearCliente(clienteAtual.id);
      showToast('Cliente desbloqueado.');
      abrirPerfil(clienteAtual.id);
    } catch (e) { showToast(msgErro(e), 'error'); }
  });

  document.getElementById('btn-cp-denunciar')?.addEventListener('click', () => {
    if (!clienteAtual || !modalDenCli) return;
    document.getElementById('den-cli-motivo').value = '';
    document.getElementById('den-cli-descricao').value = '';
    abrirModal(modalDenCli);
  });

  document.getElementById('btn-fechar-modal-denunciar-cliente')?.addEventListener('click', () =>
    fecharModal(modalDenCli));
  modalDenCli?.addEventListener('click', (e) => {
    if (e.target === modalDenCli) fecharModal(modalDenCli);
  });

  document.getElementById('form-denunciar-cliente')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!clienteAtual) return;
    const motivo = document.getElementById('den-cli-motivo').value;
    const descricao = document.getElementById('den-cli-descricao').value.trim();
    if (!motivo) { showToast('Selecione um motivo.', 'error'); return; }
    const btnEnv = e.target.querySelector('button[type="submit"]');
    btnEnv.disabled = true;
    btnEnv.textContent = 'Enviando...';
    try {
      API.denunciarPerfil({
        target_type: 'cliente',
        target_client_id: clienteAtual.id,
        target_user_id: clienteAtual.user_id || null,
        reason: motivo,
        description: descricao
      });
      showToast('Denúncia enviada! Nossa equipe vai analisar.');
      fecharModal(modalDenCli);
    } catch (err) {
      showToast(msgErro(err), 'error');
    } finally {
      btnEnv.disabled = false;
      btnEnv.textContent = 'Enviar denúncia';
    }
  });

  render();
});

