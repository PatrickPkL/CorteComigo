/* ============================================================
   Corte Comigo – admin/js/profissionais.js
   Equipe com horários próprios (DT-09), vínculo de serviços,
   limite por plano (RF-026/DT-12) e soft-delete (UC-09.4).
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

  const grid = document.getElementById('grid-profissionais');
  if (!grid) return;

  const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

  function servicosAtivos() {
    try { return API.servicosDaLoja(loja.id, true); } catch (e) { return []; }
  }

  function horarioDoProf(profId) {
    let linhas = [];
    try {
      linhas = API.horariosDaLoja(loja.id).filter(w =>
        w.professional_id === String(profId) && w.is_open);
    } catch (e) { /* noop */ }
    if (!linhas.length) return 'Sem expediente definido';
    const dows = linhas.map(l => l.day_of_week).sort((a, b) => a - b);
    const ini = linhas[0].start_time;
    const fim = linhas[0].end_time;
    let txt = dows.map(d => DIAS[d]).join('/') + ' · ' + ini + '–' + fim;
    if (linhas[0].lunch_start && linhas[0].lunch_end) {
      txt += ' · almoço ' + linhas[0].lunch_start + '–' + linhas[0].lunch_end;
    }
    return txt;
  }

  /* horários e serviços vêm do backend e podem faltar (profissional recém-
     criado, vínculo apagado): sem este guard, p.services.map quebrava o
     render inteiro e a tela ficava em branco. */
  function servicosDoProf(p) {
    return Array.isArray(p && p.services) ? p.services : [];
  }

  function render() {
    let profs;
    try { profs = API.profissionaisDaLoja(loja.id, false); } catch (e) {
      showToast(msgErro(e), 'error');
      return;
    }

    grid.innerHTML = profs.map(p =>
      '<div class="card" data-id="' + esc(p.id) + '"' + (p.is_active ? '' : ' style="opacity:.55;"') + '>' +
        '<div class="prof-card-top">' +
          '<div class="user-avatar user-avatar-lg"' +
            (p.color ? ' style="background:' + esc(p.color) + '22;color:' + esc(p.color) + ';border-color:' + esc(p.color) + '66;"' : '') + '>' +
            esc(DB.iniciais(p.name)) + '</div>' +
          '<div>' +
            '<div class="prof-card-nome">' + esc(p.name) +
              (p.is_active ? '' : ' <span class="badge badge-pendente">Inativo</span>') + '</div>' +
            (p.phone ? '<div class="prof-card-esp mono">' + esc(p.phone) + '</div>' : '') +
            (p.bio ? '<div class="prof-card-esp">' + esc(p.bio) + '</div>' : '') +
          '</div>' +
        '</div>' +
        '<div class="prof-card-horario">' + esc(horarioDoProf(p.id)) + '</div>' +
        (servicosDoProf(p).length
          ? '<div class="prof-card-servicos">' + servicosDoProf(p).map(s =>
              '<span class="chip">' + esc(s.name) + '</span>').join('') + '</div>'
          : '') +
        '<button class="btn btn-outline btn-prof-editar" data-id="' + esc(p.id) + '">Editar</button> ' +
        /* desativarProfissional() só marca is_active=false (soft-delete):
           dizer "Excluir" fazia o usuário achar que o histórico sumiu. */
        (p.is_active
          ? '<button class="btn btn-outline btn-prof-desativar" data-id="' + esc(p.id) + '">Desativar</button>'
          : '<button class="btn btn-outline btn-prof-reativar" data-id="' + esc(p.id) + '">Reativar</button>') +
      '</div>'
    ).join('') ||
    '<div class="empty-state" style="grid-column:1/-1;"><h3>Nenhum profissional</h3><p>Cadastre o primeiro membro da equipe.</p></div>';
  }

  function preencherServicos(containerId, selecionados) {
    const box = document.getElementById(containerId);
    if (!box) return;
    const sel = new Set((selecionados || []).map(String));
    box.innerHTML = servicosAtivos().map(s =>
      '<label class="check-inline">' +
        '<input type="checkbox" value="' + esc(s.id) + '"' + (sel.has(s.id) ? ' checked' : '') + '> ' +
        esc(s.name) + '</label>'
    ).join('') || '<p style="color:var(--muted,#8a8a8a);font-size:13px;">Nenhum serviço ativo no salão.</p>';
  }

  function coletarServicos(containerId) {
    return Array.from(
      document.getElementById(containerId)?.querySelectorAll('input:checked') || []
    ).map(i => i.value);
  }

  grid.addEventListener('click', (e) => {
    const editBtn = e.target.closest('.btn-prof-editar');
    const offBtn = e.target.closest('.btn-prof-desativar');
    const onBtn = e.target.closest('.btn-prof-reativar');

    if (editBtn) {
      let prof = null;
      let linha = {};
      try {
        prof = API.profissionaisDaLoja(loja.id, false)
          .find(p => String(p.id) === editBtn.dataset.id);
        linha = prof ? (API.horariosDaLoja(loja.id)
          .find(w => w.professional_id === prof.id && w.day_of_week === 1) || {}) : {};
      } catch (err2) {
        showToast(msgErro(err2), 'error');
        return;
      }
      if (!prof) return;

      document.getElementById('ep-id').value = prof.id;
      document.getElementById('ep-nome').value = prof.name;
      document.getElementById('ep-telefone').value = prof.phone || '';
      document.getElementById('ep-cor').value = prof.color || '#3b82f6';
      document.getElementById('ep-bio').value = prof.bio || '';
      document.getElementById('ep-inicio').value = linha.start_time || '09:00';
      document.getElementById('ep-fim').value = linha.end_time || '19:00';
      document.getElementById('ep-almoco-ini').value = linha.lunch_start || '';
      document.getElementById('ep-almoco-fim').value = linha.lunch_end || '';
      preencherServicos('ep-servicos', servicosDoProf(prof).map(s => s.id));
      abrirModal(document.getElementById('modal-editar-profissional'));
    }

    if (offBtn) {
      if (!confirm(
        'Desativar este profissional?\n\n' +
        'Ele sai da equipe e não aparece mais na agenda, mas o histórico de ' +
        'agendamentos e o cadastro são preservados. Você pode reativar depois.'
      )) return;
      try {
        API.desativarProfissional(offBtn.dataset.id);
        showToast('Profissional desativado. O histórico foi preservado.');
        render();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    }

    if (onBtn) {
      try {
        API.atualizarProfissional(onBtn.dataset.id, { is_active: true });
        showToast('Profissional reativado!');
        render();
      } catch (err2) {
        showToast(msgErro(err2), 'error');
      }
    }
  });

  /* ---------- novo ---------- */
  setupModal('btn-novo-profissional', 'modal-profissional', 'btn-fechar-modal-profissional');

  /* Valida no front para dar erro na hora, sem fechar o modal. O backend
     (_validarExpediente) valida de novo — front não é fronteira de
     segurança. Antes, um expediente invertido era gravado e só quebrava
     depois, já na agenda. */
  function validarProfissional(prefixo, nome, telefone, email, inicio, fim, lIni, lFim) {
    if (nome.trim().length < 2) return 'Informe o nome do profissional.';
    const digitos = (telefone || '').replace(/\D/g, '');
    if (digitos && (digitos.length < 10 || digitos.length > 13)) {
      return 'Telefone inválido: use de 10 a 13 dígitos.';
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'E-mail inválido.';
    if (!inicio || !fim) return 'Informe o início e o término do expediente.';
    if (fim <= inicio) return 'O término deve ser depois do início do expediente.';
    /* almoço é tudo-ou-nada: mensagem coerente com a do backend */
    if (lIni || lFim) {
      if (!lIni) return 'Informe o início do almoço, ou apague os dois campos.';
      if (!lFim) return 'Informe o término do almoço, ou apague os dois campos.';
      if (lFim <= lIni) return 'O término do almoço deve ser depois do início.';
      if (lIni < inicio || lFim > fim) return 'O almoço precisa ficar dentro do expediente.';
    }
    return null;
  }

  document.getElementById('form-profissional')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = document.getElementById('pf-nome').value;
    const telefone = document.getElementById('pf-telefone').value;
    const email = document.getElementById('pf-email').value;
    const inicio = document.getElementById('pf-inicio').value || '09:00';
    const fim = document.getElementById('pf-fim').value || '19:00';
    const lIni = document.getElementById('pf-almoco-ini').value || null;
    const lFim = document.getElementById('pf-almoco-fim').value || null;

    const problema = validarProfissional('pf', nome, telefone, email, inicio, fim, lIni, lFim);
    if (problema) { showToast(problema, 'error'); return; }

    try {
      API.criarProfissional({
        name: nome.trim(),
        phone: telefone.trim(),
        email: email.trim(),
        color: document.getElementById('pf-cor').value,
        bio: document.getElementById('pf-bio').value,
        start_time: inicio,
        end_time: fim,
        lunch_start: lIni,
        lunch_end: lFim,
        service_ids: coletarServicos('pf-servicos')
      });
      fecharModal(document.getElementById('modal-profissional'));
      e.target.reset();
      preencherServicos('pf-servicos', []);
      showToast('Profissional cadastrado!');
      render();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  /* ---------- editar ---------- */
  document.getElementById('btn-fechar-modal-editar-profissional')?.addEventListener('click', () =>
    fecharModal(document.getElementById('modal-editar-profissional')));
  document.getElementById('modal-editar-profissional')?.addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-editar-profissional')) fecharModal(e.target);
  });

  document.getElementById('form-editar-profissional')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nome = document.getElementById('ep-nome').value;
    const telefone = document.getElementById('ep-telefone').value;
    const inicio = document.getElementById('ep-inicio').value || '09:00';
    const fim = document.getElementById('ep-fim').value || '19:00';
    const lIni = document.getElementById('ep-almoco-ini').value || null;
    const lFim = document.getElementById('ep-almoco-fim').value || null;

    const problema = validarProfissional('ep', nome, telefone, '', inicio, fim, lIni, lFim);
    if (problema) { showToast(problema, 'error'); return; }

    try {
      API.atualizarProfissional(document.getElementById('ep-id').value, {
        name: nome.trim(),
        phone: telefone.trim(),
        color: document.getElementById('ep-cor').value,
        bio: document.getElementById('ep-bio').value,
        start_time: inicio,
        end_time: fim,
        lunch_start: lIni,
        lunch_end: lFim,
        service_ids: coletarServicos('ep-servicos')
      });
      fecharModal(document.getElementById('modal-editar-profissional'));
      showToast('Profissional atualizado!');
      render();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  preencherServicos('pf-servicos', []);
  render();
});

