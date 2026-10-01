/* ============================================================
   Corte Comigo – api.js (cliente HTTP)
   Substitui o antigo local-api.js: cada chamada vira um
   POST /api/rpc síncrono, preservando o contrato try/catch
   síncrono já usado em todas as páginas.

   Sessão: token guardado em localStorage ("token"), enviado no
   header "x-cc-token" a cada chamada.
   ============================================================ */

(function () {
  'use strict';

  const KEY_TOKEN = 'token';
  const KEY_USER = 'user';
  const KEY_LOJA = 'barbershop';

  function rpc(metodo, args) {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/rpc', false); // síncrono de propósito (ponte)
    xhr.setRequestHeader('Content-Type', 'application/json');
    const token = localStorage.getItem(KEY_TOKEN);
    if (token) xhr.setRequestHeader('x-cc-token', token);
    try {
      xhr.send(JSON.stringify({ method: metodo, args: args || [] }));
    } catch (e) {
      throw { status: 0, error: 'Servidor indisponível. Rode "npm run dev".' };
    }
    let resp = null;
    try { resp = JSON.parse(xhr.responseText); } catch (e) { /* resposta vazia */ }
    if (xhr.status >= 200 && xhr.status < 300 && resp && resp.ok) return resp.data;
    /* Assinatura inativa: qualquer ação produtiva do dono é bloqueada no
       backend (402). Aqui centralizamos o redirecionamento para a tela de
       assinatura — exceto quando já estamos nela (aí só repassa o erro). */
    if (resp && resp.code === 'assinatura_necessaria') {
      const erro = resp.error || 'Sua assinatura está inativa. Assine para liberar esta ação.';
      /* Chamadas automáticas de melhor-esforço (não iniciadas pelo usuário)
         apenas falham em silêncio — não podem expulsar o dono da visualização. */
      const automatico = (metodo === 'gerarLembretesPendentes');
      try {
        if (!automatico && !/assinatura\.html$/i.test(window.location.pathname)) {
          sessionStorage.setItem('cc_assinatura_aviso', erro);
          window.location.href = '/assinatura';
          return undefined;
        }
      } catch (e) { /* fora de contexto de navegador */ }
      throw { status: 402, code: 'assinatura_necessaria', error: erro };
    }
    throw {
      status: xhr.status || (resp && resp.status) || 500,
      error: (resp && resp.error) || ('Erro ' + xhr.status)
    };
  }

  /* ---------------- API: proxy genérico ---------------- */
  /* Métodos definidos localmente no cliente (ex.: processarImagem,
     que roda no navegador via canvas) ficam no target do proxy e
     PRECEDEM o fallback RPC — antes, o trap sombreava qualquer
     propriedade atribuída e todo upload virava uma chamada RPC. */

  window.API = new Proxy({}, {
    get(target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (Object.prototype.hasOwnProperty.call(target, prop)) return target[prop];
      return (...args) => rpc(prop, args);
    }
  });

  /* processarImagem continua no navegador (FileReader + canvas) */
  API.processarImagem = function (file) {
    return new Promise(async (resolve, reject) => {
      const tiposOk = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
      if (!tiposOk.includes(file.type)) {
        return reject({ status: 400, error: 'Formato inválido. Use JPEG, PNG, WebP ou GIF.' });
      }

      // [SEGURANÇA] Validação de magic bytes (não confia em file.type)
      const headerOk = await new Promise((resolve) => {
        const blob = file.slice(0, 4);
        const r = new FileReader();
        r.onload = () => {
          const arr = new Uint8Array(r.result);
          const hex = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
          const isJpeg = hex.startsWith('ffd8ff');
          const isPng  = hex === '89504e47';
          const isGif  = hex === '47494638';
          const isWebp = arr[0] === 0x52 && arr[1] === 0x49 && arr[2] === 0x46 && arr[3] === 0x46;
          resolve(isJpeg || isPng || isGif || isWebp);
        };
        r.onerror = () => resolve(false);
        r.readAsArrayBuffer(blob);
      });
      if (!headerOk) {
        return reject({ status: 400, error: 'Arquivo não é uma imagem válida.' });
      }

      // [SEGURANÇA] Reduzido de 5MB para 3MB para evitar DoS com uploads simultâneos
      if (file.size > 3 * 1024 * 1024) {
        return reject({ status: 400, error: 'Imagem muito grande (máx. 3MB).' });
      }
      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const MAX_DIM = 1000;
          let w = img.width, h = img.height;

          // [SEGURANÇA] Rejeita imagens muito pequenas (lixo/placeholder)
          if (w < 50 || h < 50) {
            return reject({ status: 400, error: 'Imagem muito pequena (mínimo 50x50).' });
          }

          if (w > MAX_DIM || h > MAX_DIM) {
            const escala = Math.min(MAX_DIM / w, MAX_DIM / h);
            w = Math.round(w * escala); h = Math.round(h * escala);
          }
          // [SEGURANÇA] Reencode via canvas remove naturalmente metadados EXIF
          // (GPS, modelo da câmera, data/hora) — a imagem processada contém apenas pixels
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          let qualidade = 0.82;
          let url = canvas.toDataURL('image/jpeg', qualidade);
          while (url.length > 300 * 1024 && qualidade > 0.45) {
            qualidade -= 0.08;
            url = canvas.toDataURL('image/jpeg', qualidade);
          }

          // [SEGURANÇA] Rejeita se resultado processado ainda é grande demais
          if (url.length > 500 * 1024) {
            return reject({ status: 400, error: 'Imagem processada ainda muito grande. Tente uma imagem menor.' });
          }
          resolve(url);
        };
        img.onerror = () => reject({ status: 400, error: 'Não foi possível ler a imagem.' });
        img.src = ev.target.result;
      };
      reader.onerror = () => reject({ status: 400, error: 'Falha ao carregar o arquivo.' });
      reader.readAsDataURL(file);
    });
  };

  /* ---------------- RPC explícitos (além do Proxy) ---------------- */

  API.verificarMagicLink = function (token) {
    const r = rpc('verificarMagicLink', [token]);
    if (r && r.token) {
      localStorage.setItem(KEY_TOKEN, r.token);
      localStorage.setItem(KEY_USER, r.user ? JSON.stringify(r.user) : '');
      localStorage.setItem(KEY_LOJA, r.barbershop ? JSON.stringify(r.barbershop) : '');
    }
    return r;
  };
  API.gerarLembretesAmanha = function () { return rpc('gerarLembretesAmanha', []); };
  API.lojasProximas = function (dados) { return rpc('lojasProximas', [dados]); };

  /* Login do funcionário/dependente: além do RPC, grava a sessão
     local (token/user/barbershop) igual ao verifyCode. */
  API.loginDependente = function (dados) {
    const r = rpc('loginDependente', [dados]);
    if (r && r.token) {
      localStorage.setItem(KEY_TOKEN, r.token);
      localStorage.setItem(KEY_USER, r.user ? JSON.stringify(r.user) : '');
      localStorage.setItem(KEY_LOJA, r.barbershop ? JSON.stringify(r.barbershop) : '');
    }
    return r;
  };

  /* Vincula a conta já logada ao Código Único (dependente/cliente). */
  API.vincularDependente = function (dados) {
    const r = rpc('vincularDependente', [dados]);
    if (r && r.user) {
      localStorage.setItem(KEY_USER, r.user ? JSON.stringify(r.user) : '');
      localStorage.setItem(KEY_LOJA, r.barbershop ? JSON.stringify(r.barbershop) : '');
    }
    return r;
  };

  /* Deixa de ser dependente (vira cliente) e sincroniza a sessão local. */
  API.sairDeDependente = function () {
    const r = rpc('sairDeDependente', []);
    if (r && r.ok) {
      if (r.user) localStorage.setItem(KEY_USER, JSON.stringify(r.user));
      localStorage.removeItem(KEY_LOJA);
    }
    return r;
  };

  /* ---------------- Auth (espelho do backend) ---------------- */

  function limpar() {
    [KEY_TOKEN, KEY_USER, KEY_LOJA].forEach(k => localStorage.removeItem(k));
  }

  window.Auth = {
    normalizarTelefone(v) {
      return String(v || '').replace(/\D/g, '');
    },

    requestCode(dados) {
      return rpc('requestCode', [dados]);
    },

    reenviarCodigo(phone, modo) {
      return rpc('reenviarCodigo', [phone, modo]);
    },

    reenviarCodigoIdentidade(dados) {
      return rpc('reenviarCodigoIdentidade', [dados]);
    },

    verifyCode(phone, code) {
      const r = rpc('verifyCode', [phone, code]);
      if (r && r.token) {
        localStorage.setItem(KEY_TOKEN, r.token);
        localStorage.setItem(KEY_USER, r.user ? JSON.stringify(r.user) : '');
        localStorage.setItem(KEY_LOJA, r.barbershop ? JSON.stringify(r.barbershop) : '');
      }
      return r;
    },

    usuarioAtual() {
      try { return JSON.parse(localStorage.getItem(KEY_USER)) || null; }
      catch (e) { return null; }
    },

    salaoDoUsuario(user) {
      if (!user || (user.role !== 'dono' && user.role !== 'barbeiro' && user.role !== 'dependente')) return null;
      try { return JSON.parse(localStorage.getItem(KEY_LOJA)) || null; }
      catch (e) { return null; }
    },

    logout() {
      try { rpc('logout', []); } catch (e) { /* sessão já ida */ }
      limpar();
    },

    limparSessao: limpar,

    /* reescreve o cache local após atualizações de perfil/loja —
       sem isso o F5 repõe valores antigos no formulário */
    sincronizarUsuario(u) {
      if (u) localStorage.setItem(KEY_USER, JSON.stringify(u));
    },

    sincronizarLoja(l) {
      if (l) localStorage.setItem(KEY_LOJA, JSON.stringify(l));
    },

    publicUser(u) { return u || null; },

    /* validação de força da senha (espelho do backend) */
    validarForcaSenha(senha) {
      const s = String(senha || '');
      const erros = [];
      if (s.length < 8) erros.push('Mínimo 8 caracteres');
      if (s.length > 12) erros.push('Máximo 12 caracteres');
      if (!/[A-Z]/.test(s)) erros.push('Pelo menos 1 maiúscula');
      if (!/[a-z]/.test(s)) erros.push('Pelo menos 1 minúscula');
      if (!/[0-9]/.test(s)) erros.push('Pelo menos 1 número');
      if (!/[^A-Za-z0-9]/.test(s)) erros.push('Pelo menos 1 especial (* @ # $ %)');
      return { ok: erros.length === 0, erros };
    },

    /* alterar senha (logado) */
    alterarSenha(senhaAtual, novaSenha, confirmarSenha) {
      return rpc('alterarSenha', [senhaAtual, novaSenha, confirmarSenha]);
    },

    /* login tradicional e-mail + senha */
    loginComSenha(email, senha) {
      return rpc('loginComSenha', [email, senha]);
    },

    /* solicitar redefinição de senha (link por e-mail) */
    solicitarRedefinicaoSenha(email) {
      return rpc('solicitarRedefinicaoSenha', [email]);
    },

    /* redefinir senha via token */
    redefinirSenha(token, novaSenha, confirmarSenha) {
      return rpc('redefinirSenha', [token, novaSenha, confirmarSenha]);
    }
  };
})();
