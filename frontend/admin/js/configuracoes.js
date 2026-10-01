/* ============================================================
   Corte Comigo – admin/js/configuracoes.js
   Dados da loja (RF-016/017), logo/capa e galeria com reencode
   (RF-062..065), grade de horários com almoço (DT-09) e
   exclusão de conta em cascata (RF-010).
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

  /* ---------- dados do salão ---------- */
  function preencherDados() {
    let l;
    try { l = API.minhaLoja(); } catch (e) { showToast(msgErro(e), 'error'); return; }
    setVal('cfg-nome', l.name);
    setVal('cfg-descricao', l.description || '');
    setVal('cfg-telefone', l.phone || '');
    setVal('cfg-whatsapp', l.whatsapp || '');
    setVal('cfg-endereco', l.address || '');
    setVal('cfg-cidade', l.city || '');
    setVal('cfg-uf', l.uf || '');
    setVal('cfg-instagram', l.instagram || '');

    const preview = document.getElementById('foto-perfil-preview');
    if (preview && l.logo_url) {
      preview.innerHTML = '<img src="' + esc(l.logo_url) + '" alt="Logo do salão">';
    }
  }

  function setVal(id, v) { const el = document.getElementById(id); if (el) el.value = v; }

  document.getElementById('form-config-salao')?.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const l = API.atualizarLoja({
        name: document.getElementById('cfg-nome').value.trim(),
        description: document.getElementById('cfg-descricao').value.trim(),
        phone: document.getElementById('cfg-telefone').value.trim(),
        whatsapp: document.getElementById('cfg-whatsapp').value.trim(),
        address: document.getElementById('cfg-endereco').value.trim(),
        city: document.getElementById('cfg-cidade').value.trim(),
        uf: document.getElementById('cfg-uf').value.trim().toUpperCase().slice(0, 2),
        instagram: document.getElementById('cfg-instagram').value.trim()
      });
      Auth.sincronizarLoja(l); // cabeçalho das outras páginas não fica velho
      const sbNome = document.getElementById('sb-nome');
      if (sbNome) sbNome.textContent = document.getElementById('cfg-nome').value.trim();
      showToast('Dados do salão atualizados!');
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  /* ---------- logo (upload com reencode — RF-063/RNF-11) ---------- */
  document.getElementById('foto-perfil')?.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const dataUrl = await API.processarImagem(file);
      API.definirLogo(dataUrl);
      const preview = document.getElementById('foto-perfil-preview');
      if (preview) preview.innerHTML = '<img src="' + esc(dataUrl) + '" alt="Logo do salão">';
      showToast('Logo atualizada!');
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
    e.target.value = '';
  });


  /* ---------- galeria ---------- */
  const galleryGrid = document.getElementById('gallery-grid');
  const inputGaleria = document.getElementById('input-foto-catalogo');

  function renderGaleria() {
    if (!galleryGrid) return;
    let fotos = [];
    try { fotos = API.galeriaDaLoja(loja.id); } catch (e) { /* noop */ }
    const addBtn = document.getElementById('btn-add-foto');

    galleryGrid.querySelectorAll('.gallery-item:not(.gallery-add)').forEach(i => i.remove());

    fotos.forEach(f => {
      const item = document.createElement('div');
      item.className = 'gallery-item';
      item.innerHTML =
        '<div class="gallery-img"><img src="' + esc(f.url) + '" alt="Foto do salão"></div>' +
        '<div class="gallery-actions">' +
          '<button type="button" class="gallery-btn-capa" title="Definir como capa">★</button>' +
          '<button type="button" class="gallery-remove" title="Remover">&times;</button>' +
        '</div>';
      item.querySelector('.gallery-remove').addEventListener('click', () => {
        if (!confirm('Remover esta foto?')) return;
        try {
          API.removerGaleria(f.id);
          item.remove();
          showToast('Foto removida.', 'error');
        } catch (err2) {
          showToast(msgErro(err2), 'error');
        }
      });
      item.querySelector('.gallery-btn-capa').addEventListener('click', () => {
        try {
          API.definirCapa(f.url);
          showToast('Foto definida como capa!');
        } catch (err2) {
          showToast(msgErro(err2), 'error');
        }
      });
      if (addBtn) galleryGrid.insertBefore(item, addBtn);
      else galleryGrid.appendChild(item);
    });
  }

  document.getElementById('btn-add-foto')?.addEventListener('click', () => inputGaleria?.click());
  inputGaleria?.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    // [SEGURANÇA] Limite de fotos por loja (deve bater com backend)
    const LIMITE_GALERIA = 20;
    const fotosAtuais = galleryGrid.querySelectorAll('.gallery-item:not(.gallery-add)').length;
    if (fotosAtuais + files.length > LIMITE_GALERIA) {
      showToast('Limite de ' + LIMITE_GALERIA + ' fotos por loja. Remova fotos antes de adicionar.', 'error');
      e.target.value = '';
      return;
    }
    // [SEGURANÇA] Envia 1 foto por chamada para manter request < 500KB
    for (const file of files) {
      try {
        const dataUrl = await API.processarImagem(file);
        await API.adicionarGaleria([dataUrl]);
        showToast(file.name + ' adicionada!');
      } catch (e) {
        showToast(file.name + ': ' + msgErro(e), 'error');
      }
    }
    renderGaleria();
    inputGaleria.value = '';
  });

  /* LGPD — Exportar dados da loja */
  var btnExportarLoja = document.getElementById('btn-exportar-dados-loja');
  if (btnExportarLoja) {
    btnExportarLoja.onclick = function() {
      var r = API.exportarMeusDados();
      var blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = 'cortecomigo-dados-loja-' + new Date().toISOString().slice(0,10) + '.json';
      a.click();
      URL.revokeObjectURL(url);
    };
  }

  /* ---------- zona de risco (RF-010) — exclusão com código ---------- */
  const modalExcluir = document.getElementById('modal-excluir-conta');
  const step1 = document.getElementById('excluir-step-1');
  const step2 = document.getElementById('excluir-step-2');
  const inputCodigo = document.getElementById('input-codigo-excluir');
  const btnGerar = document.getElementById('btn-gerar-codigo-excluir');
  const btnConfirmar = document.getElementById('btn-confirmar-excluir');
  const btnCancelarExcluir = document.getElementById('btn-cancelar-excluir');

  document.getElementById('btn-excluir-conta')?.addEventListener('click', () => {
    if (!modalExcluir) return;
    step1.style.display = 'block';
    step2.style.display = 'none';
    if (inputCodigo) inputCodigo.value = '';
    if (btnConfirmar) btnConfirmar.disabled = true;
    abrirModal(modalExcluir);
  });

  btnGerar?.addEventListener('click', () => {
    const senha = document.getElementById('input-senha-exclusao')?.value || '';
    const telefone = document.getElementById('input-tel-exclusao')?.value || '';
    try {
      const r = API.gerarCodigoExclusao({ senha, telefone });
      step1.style.display = 'none';
      step2.style.display = 'block';
      showToast(r && r.hint ? r.hint : 'Código enviado. Digite abaixo.');
      if (inputCodigo) inputCodigo.focus();
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  inputCodigo?.addEventListener('input', () => {
    if (btnConfirmar) btnConfirmar.disabled = inputCodigo.value.length !== 4;
  });

  btnConfirmar?.addEventListener('click', () => {
    const code = (inputCodigo?.value || '').trim();
    if (code.length !== 4) return;
    try {
      API.confirmarExclusao(code);
      Auth.limparSessao();
      showToast('Conta excluída permanentemente.', 'error');
      setTimeout(() => { window.location.href = '/login'; }, 1200);
    } catch (err2) {
      showToast(msgErro(err2), 'error');
    }
  });

  btnCancelarExcluir?.addEventListener('click', () => fecharModal(modalExcluir));
  modalExcluir?.addEventListener('click', e => { if (e.target === modalExcluir) fecharModal(modalExcluir); });

  preencherDados();
  renderGaleria();
});

