/* ============================================================
   Corte Comigo – admin/js/login.js
   Autenticação por telefone OU e-mail + código de verificação
   (RF-001..005, DT-13). Requer db.js, auth.js, local-api.js e
   shared.js antes.
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {

  /* ---------- seletor de papel ---------- */
  const roleBtns = document.querySelectorAll('.role-btn');
  const painelCliente = document.getElementById('painel-cliente');
  const painelDono = document.getElementById('painel-dono');
  const painelDepend = document.getElementById('painel-depend');

  function mostrarPapel(papel) {
    roleBtns.forEach(b => b.classList.toggle('active', b.dataset.role === papel));
    if (painelCliente) painelCliente.style.display = papel === 'cliente' ? '' : 'none';
    if (painelDono) painelDono.style.display = papel === 'dono' ? '' : 'none';
    if (painelDepend) painelDepend.style.display = papel === 'dependente' ? '' : 'none';
    voltarAoInicio();
  }

  roleBtns.forEach(btn => {
    btn.addEventListener('click', () => mostrarPapel(btn.dataset.role));
  });

  /* ---------- password visibility toggle ---------- */
  document.querySelectorAll('.password-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const wrapper = btn.closest('.password-wrapper');
      const input = wrapper?.querySelector('input[type="password"], input[type="text"]');
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.querySelector('.eye-open').style.display = isPassword ? 'none' : '';
      btn.querySelector('.eye-closed').style.display = isPassword ? '' : 'none';
    });
  });

  /* ---------- tabs entrar / criar conta ---------- */
  function ligarTabs(prefixo, formEntrarId, formCadId, senhaInputId, forcaId) {
    const tE = document.getElementById(prefixo + '-entrar');
    const tC = document.getElementById(prefixo + '-criar');
    const fE = document.getElementById(formEntrarId);
    const fC = document.getElementById(formCadId);
    if (!tE || !tC || !fE || !fC) return;
    tE.addEventListener('click', () => {
      tE.classList.add('active'); tC.classList.remove('active');
      fE.style.display = ''; fC.style.display = 'none';
      voltarAoInicio();
    });
    tC.addEventListener('click', () => {
      tC.classList.add('active'); tE.classList.remove('active');
      fC.style.display = ''; fE.style.display = 'none';
      voltarAoInicio();
      if (senhaInputId && forcaId) atualizarForcaSenha(senhaInputId, forcaId);
    });
  }
  ligarTabs('tab-cli', 'form-cli-login', 'form-cli-cadastro', 'cli-senha', 'cli-senha-forca');
  ligarTabs('tab-dono', 'form-dono-login', 'form-dono-cadastro', 'cad-senha', 'cad-senha-forca');
  ligarTabs('tab-dep', 'form-dep-login', 'form-dep-cadastro', 'dep-cad-senha', 'dep-cad-senha-forca');

  /* ---------- etapa do código (compartilhada) ---------- */
  const etapaCodigo = document.getElementById('etapa-codigo');
  const bannerCodigo = document.getElementById('banner-codigo');
  const infoFone = document.getElementById('codigo-info');
  const inputCodigo = document.getElementById('input-codigo');

  let fluxo = null;      // {phone, ident, payload}
  let recForcaLigada = false;   // medidor de força da nova senha (liga só 1x)
  const SEL_FORMS = '#painel-cliente form, #painel-dono form, #painel-depend form';

  function todosForms() {
    return Array.from(document.querySelectorAll(SEL_FORMS));
  }

  /* mostrarEtapaCodigo/mostrarRecuperar escondem TODOS os forms dos três
     painéis. Sem restaurar, trocar de papel ou clicar em "voltar" deixava o
     painel em branco (nenhum form visível). */
  function voltarAoInicio() {
    if (etapaCodigo) etapaCodigo.style.display = 'none';
    const etapaRec = document.getElementById('etapa-recuperar');
    if (etapaRec) etapaRec.style.display = 'none';
    const camposSenha = document.getElementById('campos-nova-senha');
    if (camposSenha) camposSenha.style.display = 'none';
    const ns = document.getElementById('rec-nova-senha'); if (ns) ns.value = '';
    const cs = document.getElementById('rec-confirmar-senha'); if (cs) cs.value = '';
    fluxo = null;
    if (inputCodigo) inputCodigo.value = '';
    todosForms().forEach(f => {
      if (f.offsetParent === null) return;               // painel já oculto
      /* form-cli-login <-> tab-cli-entrar · form-cli-cadastro <-> tab-cli-criar */
      const prefixo = f.id.replace(/^form-/, '').replace(/-(login|cadastro)$/, '');
      const aba = document.getElementById('tab-' + prefixo + '-' + (/cadastro$/.test(f.id) ? 'criar' : 'entrar'));
      f.style.display = (aba && aba.classList.contains('active')) ? '' : 'none';
    });
  }

  /* ---------- medidor de força da senha ---------- */
  function atualizarForcaSenha(inputId, forcaId) {
    const input = document.getElementById(inputId);
    const forcaEl = document.getElementById(forcaId);
    if (!input || !forcaEl) return;
    input.addEventListener('input', () => {
      const s = input.value;
      const checks = [
        { re: /.{8,}/, label: '8+ chars' },
        { re: /.{13}/, label: '≤12 chars', invert: true },  // invert: true means PASS when NOT matched
        { re: /[A-Z]/, label: 'Maiúscula' },
        { re: /[a-z]/, label: 'Minúscula' },
        { re: /[0-9]/, label: 'Número' },
        { re: /[^A-Za-z0-9]/, label: 'Especial' }
      ];
      let ok = 0;
      checks.forEach(c => {
        const matched = c.re.test(s);
        if (c.invert) { if (!matched) ok++; }
        else { if (matched) ok++; }
      });
      const total = checks.length;
      const pct = (ok / total) * 100;
      let cor = '#e74c3c', txt = 'Muito fraca';
      if (ok === 3) { cor = '#f39c12'; txt = 'Fraca'; }
      else if (ok === 4) { cor = '#f1c40f'; txt = 'Boa'; }
      else if (ok === 5) { cor = '#27ae60'; txt = 'Forte'; }
      else if (ok === 6) { cor = '#27ae60'; txt = 'Muito forte'; }
      forcaEl.innerHTML = '<div style="height:4px; background:#eee; border-radius:2px; overflow:hidden;">' +
        '<div style="width:' + pct + '%; height:100%; background:' + cor + '; transition:width .2s,background .2s;"></div>' +
        '</div><span style="font-size:12px; color:' + cor + '; margin-left:8px;">' + txt + ' (' + ok + '/' + total + ')' + '</span>';
    });
  }

  function mostrarEtapaCodigo(res) {
    /* esconde TODOS os forms dos três painéis; voltarAoInicio devolve o
       formulário certo (o da aba ativa do painel ativo) */
    todosForms().forEach(f => { f.style.display = 'none'; });

    /* recuperação de acesso: pede a nova senha junto com o código, para o
       usuário definir a senha e poder logar normalmente depois. */
    const recuperacao = !!(fluxo && fluxo.payload && fluxo.payload.modo === 'recuperacao');
    const camposSenha = document.getElementById('campos-nova-senha');
    const btnVerificar = document.getElementById('btn-verificar-codigo');
    if (camposSenha) camposSenha.style.display = recuperacao ? '' : 'none';
    if (btnVerificar) btnVerificar.textContent = recuperacao ? 'Definir senha e entrar' : 'Verificar e entrar';
    if (recuperacao) {
      const ns = document.getElementById('rec-nova-senha');
      const cs = document.getElementById('rec-confirmar-senha');
      if (ns) ns.required = true;
      if (cs) cs.required = true;
      if (!recForcaLigada) { atualizarForcaSenha('rec-nova-senha', 'rec-senha-forca'); recForcaLigada = true; }
    }

    if (bannerCodigo) {
      bannerCodigo.hidden = false;
      bannerCodigo.innerHTML = recuperacao
        ? '<strong>Verifique seu e-mail</strong> — digite o código e crie sua nova senha.'
        : '<strong>Verifique seu e-mail</strong> — você recebeu um código de 6 dígitos.';
    }
    if (infoFone) {
      const destinoRegistro = (fluxo && fluxo.payload && fluxo.payload.modo === 'registro' && fluxo.payload.email)
        ? String(fluxo.payload.email).trim() : '';
      infoFone.textContent = 'Digite o código de 6 dígitos enviado para ' +
        (destinoRegistro ? destinoRegistro : String(fluxo && fluxo.ident ? fluxo.ident : '').trim()) + '.';
    }
    if (etapaCodigo) etapaCodigo.style.display = '';
    if (inputCodigo) inputCodigo.focus();
  }

  function abrirRecuperar() {
    if (painelCliente) painelCliente.style.display = 'none';
    if (painelDono) painelDono.style.display = 'none';
    if (painelDepend) painelDepend.style.display = 'none';
    const pr = document.getElementById('painel-recuperar');
    if (pr) pr.style.display = '';
    voltarAoInicio();
  }

  function fecharRecuperar() {
    const pr = document.getElementById('painel-recuperar');
    if (pr) pr.style.display = 'none';
    roleBtns.forEach(b => {
      if (b.classList.contains('active')) mostrarPapel(b.dataset.role);
    });
  }

  async function pedirCodigo(payload) {
    try {
      const res = Auth.requestCode(payload);
      fluxo = {
        phone: payload.email || payload.phone,
        ident: payload.email || payload.phone,
        payload
      };
      mostrarEtapaCodigo(res);
    } catch (e) {
      showToast(msgErro(e), 'error');
    }
  }

  /* consentimento é lido do checkbox de verdade. Antes ia `true` fixo:
     se o atributo required sumisse do HTML (ou o form fosse enviado por
     script), o backend receberia aceite de termos que o usuário nunca deu. */
  function consentiu(form) {
    const cb = form && form.querySelector('input[name=aceite_privacidade]');
    return !!(cb && cb.checked);
  }

  /* entrada — LOGIN tradicional e-mail + senha */
  document.getElementById('form-cli-login')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const email = document.getElementById('cli-email-login').value.trim();
    const senha = document.getElementById('cli-senha-login')?.value || '';
    if (!email || !senha) { showToast('Informe e-mail e senha.', 'error'); return; }
    try {
      const r = Auth.loginComSenha(email, senha);
      sessionStorage.removeItem('cc_flash');
      const primeiro = (r.user && r.user.name ? r.user.name.split(' ')[0] : '');
      showToast('Bem-vindo' + (primeiro ? ', ' + primeiro : '') + '!');
      setTimeout(() => { window.location.href = destinoPosLogin(r.user); }, 700);
    } catch (erro) {
      showToast(msgErro(erro), 'error');
    }
  });

  document.getElementById('form-dono-login')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const ident = document.getElementById('dono-tel').value.trim();
    const senha = document.getElementById('dono-senha-login')?.value || '';
    if (!ident || !senha) { showToast('Informe e-mail/telefone e senha.', 'error'); return; }
    try {
      const r = Auth.loginComSenha(ident, senha);
      sessionStorage.removeItem('cc_flash');
      const primeiro = (r.user && r.user.name ? r.user.name.split(' ')[0] : '');
      showToast('Bem-vindo' + (primeiro ? ', ' + primeiro : '') + '!');
      setTimeout(() => { window.location.href = destinoPosLogin(r.user); }, 700);
    } catch (erro) {
      showToast(msgErro(erro), 'error');
    }
  });

  /* CADASTRO DO CLIENTE — passo 1 pede o código por e-mail; o passo 2
     (form-verificar-codigo) confirma, cria a conta com a senha e já entra.
     Nos acessos seguintes basta e-mail + senha (Auth.loginComSenha). */
  document.getElementById('form-cli-cadastro')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const senha = document.getElementById('cli-senha').value;
    const validacao = Auth.validarForcaSenha(senha);
    if (!validacao.ok) {
      showToast('Senha fraca: ' + validacao.erros.join(', '), 'error');
      return;
    }
    pedirCodigo({
      phone: document.getElementById('cli-tel-cad').value,
      modo: 'registro',
      name: document.getElementById('cli-nome').value,
      email: document.getElementById('cli-email').value,
      role: 'cliente',
      senha: senha,
      aceite_privacidade: consentiu(f)
    });
  });

  /* CADASTRO DO DONO — mesmo fluxo, role 'dono'. Sem este listener o form
     #form-dono-cadastro (login.html) dava submit nativo e recarregava a
     página, sem pedir nada ao servidor. */
  document.getElementById('form-dono-cadastro')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    const senha = document.getElementById('cad-senha').value;
    const validacao = Auth.validarForcaSenha(senha);
    if (!validacao.ok) {
      showToast('Senha fraca: ' + validacao.erros.join(', '), 'error');
      return;
    }
    pedirCodigo({
      phone: document.getElementById('cad-tel').value,
      modo: 'registro',
      name: document.getElementById('cad-nome-resp').value,
      email: document.getElementById('cad-email').value,
      role: 'dono',
      salon_name: document.getElementById('cad-salao-nome').value,
      senha: senha,
      aceite_privacidade: consentiu(f)
    });
  });

  /* login do FUNCIONÁRIO/DEPENDENTE — Login + Senha (Código Único opcional) */
  document.getElementById('form-dep-login')?.addEventListener('submit', (e) => {
    e.preventDefault();
    try {
      const r = API.loginDependente({
        login: document.getElementById('dep-login').value,
        senha: document.getElementById('dep-senha').value,
        codigo_unico: document.getElementById('dep-codigo').value
      });
      sessionStorage.removeItem('cc_flash');
      if (r.link_pendente) {
        showToast('Conta criada mas ainda sem vínculo. Informe o Código Único da empresa.', 'success');
        window.location.href = '/agendamentos';
        return;
      }
      showToast('Bem-vindo, ' + (r.user.name ? r.user.name.split(' ')[0] : 'funcionário') + '!');
      setTimeout(() => { window.location.href = destinoPosLogin(r.user); }, 700);
    } catch (erro) {
      showToast(msgErro(erro), 'error');
      const s = document.getElementById('dep-senha');
      if (s) { s.value = ''; s.focus(); }
    }
  });

  /* cadastro do FUNCIONÁRIO/DEPENDENTE (autoatendimento, sem código) */
  const formDepCad = document.getElementById('form-dep-cadastro');
  formDepCad?.addEventListener('submit', (e) => {
    e.preventDefault();
    const aceite = formDepCad.querySelector('input[name=aceite_privacidade]');
    const emailCad = (document.getElementById('dep-cad-email') || {}).value || '';
    const senhaCad = (document.getElementById('dep-cad-senha') || {}).value || '';
    const validacao = Auth.validarForcaSenha(senhaCad);
    if (!validacao.ok) {
      showToast('Senha fraca: ' + validacao.erros.join(', '), 'error');
      return;
    }
    try {
      API.criarContaDependente({
        name: document.getElementById('dep-cad-nome').value,
        email: emailCad,
        senha: senhaCad,
        phone: document.getElementById('dep-cad-tel')?.value || '',
        aceite_privacidade: aceite ? aceite.checked : false
      });
    } catch (erro) {
      showToast(msgErro(erro), 'error');
      return;   /* conta não foi criada: não troca abas nem limpa nada */
    }
    showToast('Conta criada! Agora entre com seu e-mail e senha.', 'success');
    const tE = document.getElementById('tab-dep-entrar');
    const tC = document.getElementById('tab-dep-criar');
    const fE = document.getElementById('form-dep-login');
    const fC = document.getElementById('form-dep-cadastro');
    if (tE) tE.classList.add('active');
    if (tC) tC.classList.remove('active');
    if (fE) fE.style.display = '';
    if (fC) fC.style.display = 'none';
    const edit = document.getElementById('dep-login');
    if (edit) edit.value = emailCad;
    const senha = document.getElementById('dep-senha');
    if (senha) senha.value = senhaCad;
    formDepCad.reset();
  });

  /* verificar */
  document.getElementById('form-verificar-codigo')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!fluxo) return;
    const recuperacao = !!(fluxo.payload && fluxo.payload.modo === 'recuperacao');
    try {
      let r;
      if (recuperacao) {
        const nova = document.getElementById('rec-nova-senha').value;
        const conf = document.getElementById('rec-confirmar-senha').value;
        const validacao = Auth.validarForcaSenha(nova);
        if (!validacao.ok) {
          showToast('Senha fraca: ' + validacao.erros.join(', '), 'error');
          return;
        }
        if (nova !== conf) {
          showToast('A nova senha e a confirmação não coincidem.', 'error');
          return;
        }
        /* valida o código, grava a nova senha e abre a sessão */
        r = Auth.redefinirSenhaComCodigo(fluxo.ident, inputCodigo.value, nova, conf);
      } else {
        r = Auth.verifyCode(fluxo.phone, inputCodigo.value);
      }
      /* flash antigo (ex.: "faça login para denunciar") não deve
         aparecer depois do login bem-sucedido */
      sessionStorage.removeItem('cc_flash');
      const primeiro = (r.user && r.user.name ? r.user.name.split(' ')[0] : '');
      showToast(recuperacao
        ? 'Senha criada! Entrando...'
        : (r.user && r.user.role === 'dono'
          ? 'Bem-vindo de volta, ' + primeiro + '!'
          : 'Login realizado com sucesso!'));
      setTimeout(() => { window.location.href = destinoPosLogin(r.user); }, 700);
    } catch (err) {
      showToast(msgErro(err), 'error');
      inputCodigo.value = '';
      inputCodigo.select();
    }
  });

  /* reenviar (respeita cooldown de 30s da API — o servidor devolve 429) */
  document.getElementById('btn-reenviar')?.addEventListener('click', (e) => {
    e.preventDefault();
    if (!fluxo) return;
    /* recuperação: reenvia o código de acesso (não é requestCode) */
    if (fluxo.payload && fluxo.payload.modo === 'recuperacao') {
      try {
        const r = API.recuperarAcesso(fluxo.ident);
        if (r && r.enviado === false) {
          showToast(r.aviso || 'Não foi possível enviar o e-mail.', 'warning');
        } else {
          showToast('Novo código enviado para ' + fluxo.ident + '.', 'success');
        }
      } catch (err) {
        showToast(msgErro(err), 'error');
      }
      return;
    }
    pedirCodigo(fluxo.payload);
  });

  /* voltar */
  document.getElementById('btn-voltar-login')?.addEventListener('click', (e) => {
    e.preventDefault();
    voltarAoInicio();
    roleBtns.forEach(b => {
      if (b.classList.contains('active')) mostrarPapel(b.dataset.role);
    });
  });

  /* ---------- recuperar acesso por e-mail ---------- */
  const etapaRecuperar = document.getElementById('etapa-recuperar');
  const formRecuperar = document.getElementById('form-recuperar');
  const btnVoltarRec = document.getElementById('btn-voltar-recuperar');

  function mostrarRecuperar() {
    /* esconde os forms dos três painéis; fecharRecuperar chama mostrarPapel,
       que roda voltarAoInicio e devolve o formulário certo */
    todosForms().forEach(f => { f.style.display = 'none'; });
    if (etapaRecuperar) etapaRecuperar.style.display = '';
    const inp = document.getElementById('input-rec-email');
    if (inp) inp.focus();
  }

  document.querySelectorAll('.recuperar-link').forEach(link => {
    link.addEventListener('click', e => {
      e.preventDefault();
      mostrarRecuperar();
    });
  });

  btnVoltarRec?.addEventListener('click', e => {
    e.preventDefault();
    voltarAoInicio();
    roleBtns.forEach(b => {
      if (b.classList.contains('active')) mostrarPapel(b.dataset.role);
    });
  });

  formRecuperar?.addEventListener('submit', e => {
    e.preventDefault();
    const email = document.getElementById('input-rec-email').value.trim();
    if (!email) {
      showToast('Informe o e-mail cadastrado.', 'error');
      return;
    }
    try {
      /* envia um código de 6 dígitos por e-mail; sem senha atual.
         anti-enumeração: resposta igual para e-mail cadastrado ou não. */
      const r = API.recuperarAcesso(email);
      if (r && r.enviado === false) {
        showToast(r.aviso || 'Não foi possível enviar o e-mail (SMTP não configurado).', 'error');
        return;
      }
      fluxo = { phone: email, ident: email, payload: { modo: 'recuperacao', email: email } };
      formRecuperar.reset();
      if (etapaRecuperar) etapaRecuperar.style.display = 'none';
      mostrarEtapaCodigo(r);
      showToast('Se este e-mail estiver cadastrado, enviamos um código de 6 dígitos.', 'success');
    } catch (erro) {
      showToast(msgErro(erro), 'error');
    }
  });

  /* magic link: se URL tem ?token=, verificar automaticamente */
  (function() {
    var params = new URLSearchParams(window.location.search);
    var magicToken = params.get('token') || localStorage.getItem('cc_magic_token');
    if (magicToken) {
      localStorage.removeItem('cc_magic_token');
      try {
        var r = API.verificarMagicLink(magicToken);
        showToast('Login realizado via link mágico!');
        setTimeout(function() { window.location.href = destinoPosLogin(r.user); }, 500);
      } catch (e) {
        showToast(msgErro(e), 'error');
      }
    }
  })();
});
