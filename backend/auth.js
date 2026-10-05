/* ============================================================
   Corte Comigo – auth.js  (PRD v2 · Seção 3.1 / RNF-06 / RNF-10)
   Autenticação SEM SENHA: e-mail + código de 6 dígitos (RF-002).
   O código é enviado por e-mail e, sem Gmail configurado, exibido
   na UI (modo demonstração — RNF-19).
   Sessão: token opaco de 256 bits, validade 7 dias.
   Chaves de compatibilidade: token / user / barbershop.
   Requer db.js carregado antes (fonte: PostgreSQL espelhado).
   ============================================================ */

window.Auth = (function () {
  'use strict';

  var Mailer = require('./mailer');
  var IDX = require('./idx');

  /* Audit log: api.js define _auditLog e o expõe em window.API._auditLog.
     Este arquivo chamava um `_auditLog` solto (variável livre, inexistente
     no escopo) em loginComSenha / alterarSenha / redefinirSenha /
     solicitarRedefinicaoSenha — o que estourava
     "ReferenceError: _auditLog is not defined" no login com senha.
     Aqui resolve pelo API; se o API ainda não carregou, apenas avisa
     (auditoria nunca deve derrubar o login). */
  function _auditLog(userId, acao, extra) {
    try {
      var api = (typeof window !== 'undefined') ? (window.API || null) : null;
      if (api && typeof api._auditLog === 'function') {
        api._auditLog(userId, acao, extra);
      } else {
        console.warn('[auth] _auditLog indisponível (ação: ' + acao + ')');
      }
    } catch (e) {
      console.error('[auth] falha ao registrar no audit log:', e);
    }
  }

  const TOKEN_TTL_DIAS = 7;
  const CODIGO_TTL_MS = 10 * 60 * 1000;   // RF-002: 10 minutos
  const MAX_TENTATIVAS = 5;               // RNF-10
  const COOLDOWN_MS = 30 * 1000;         // 30 segundos entre pedidos de código

  /* ---------------- utilidades ---------------- */

  function normalizarTelefone(v) {
    return String(v || '').replace(/\D/g, '');
  }

  /* Identidade de login: telefone (só dígitos) OU e-mail (RBAC ajudante) */
  function normalizarIdentidade(v) {
    const s = String(v || '').trim();
    if (!s) return '';
    if (s.includes('@')) return s.toLowerCase();
    return s.replace(/\D/g, '');
  }

  function ehEmail(ident) { return String(ident || '').includes('@'); }

function usuarioPorIdentidade(db, ident) {
    if (!ident) return null;
    if (ehEmail(ident)) {
        return IDX.usuarioPorEmail().get(ident) || null;
    }
    return IDX.usuarioPorTelefone().get(ident) || null;
}

/* O índice de identidade guarda 1 usuário por e-mail/telefone (o último da
   lista). Se existirem DUAS contas com a mesma identidade — o caso comum é
   um cadastro antigo feito por código, sem senha — o login caía na conta
   errada e respondia "não possui senha". Aqui procuramos a conta que de
   fato tem senha cadastrada. */
function usuarioComSenhaPorIdentidade(db, ident) {
    if (!ident) return null;
    const chave = ehEmail(ident)
        ? (u) => String(u.email || '').toLowerCase()
        : (u) => String(u.phone || '').replace(/\D/g, '');
    return (db.users || []).find(u => u && u.role !== 'dependente' && u.password_hash && chave(u) === ident) || null;
}

  function agoraMs() { return Date.now(); }

  function gerarToken() {
    const bytes = new Uint8Array(32); // 256 bits
    crypto.getRandomValues(bytes);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function slugify(nome) {
    return String(nome || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 60);
  }

  function slugUnico(nome) {
    const base = slugify(nome);
    if (!base) return 'salao-' + Math.floor(Math.random() * 900 + 100);
    const db = DB._d();
    if (!db.barbershops.some(b => b.slug === base)) return base;
    for (let i = 0; i < 50; i++) {
      const cand = base + '-' + Math.floor(Math.random() * 900 + 100);
      if (!db.barbershops.some(b => b.slug === cand)) return cand;
    }
    throw { status: 500, error: 'Não foi possível gerar um identificador único para o salão.' };
  }

  /* Código Único da empresa (alfanumérico, sem 0/O/1/I), usado no
     acesso das contas Dependente/Funcionário (Login + Senha + Código). */
  const ALCARISO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  function gerarCodigoUnico() {
    const db = DB._d();
    for (let i = 0; i < 30; i++) {
      let c = '';
      for (let j = 0; j < 8; j++) {
        c += ALCARISO.charAt(Math.floor(Math.random() * ALCARISO.length));
      }
      if (!db.barbershops.some(b => b.codigo_unico === c)) return c;
    }
    throw { status: 500, error: 'Não foi possível gerar um código único para a empresa.' };
  }

  /* ---------------- senha dos funcionários (scrypt) ---------------- */
  // Formato armazenado: scrypt:$N:$r:$p:$saltB64:$hashB64 — nunca em claro.

  const SENHA_N = 16384, SENHA_R = 8, SENHA_P = 1, SENHA_KEYLEN = 64;

  /* backend/auth.js roda apenas no Node (o browser usa o espelho em
     frontend/shared/js/api.js), então o módulo nativo está disponível. */
  const _crypto = require('crypto');

  function hashSenha(senha) {
    const salt = _crypto.randomBytes(16);
    const hash = _crypto.scryptSync(String(senha), salt, SENHA_KEYLEN, { N: SENHA_N, r: SENHA_R, p: SENHA_P });
    return 'scrypt:' + SENHA_N + ':' + SENHA_R + ':' + SENHA_P + ':' +
      salt.toString('base64') + ':' + hash.toString('base64');
  }

  function verificarSenha(senha, hashArmazenado) {
    if (!hashArmazenado || typeof hashArmazenado !== 'string') return false;
    const partes = String(hashArmazenado).split(':');
    if (partes[0] !== 'scrypt' || partes.length !== 6) return false;
    const N = parseInt(partes[1], 10), r = parseInt(partes[2], 10), p = parseInt(partes[3], 10);
    const salt = Buffer.from(partes[4], 'base64');
    const esperado = Buffer.from(partes[5], 'base64');
    let calculado;
    try {
      calculado = _crypto.scryptSync(String(senha), salt, esperado.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
    } catch (e) { return false; }
    return calculado.length === esperado.length && _crypto.timingSafeEqual(calculado, esperado);
  }

  /* ---------------- rate limiting login ---------------- */
  // 5 tentativas falhas -> bloqueio de 2 minutos
  var _loginFalhas = new Map();
  const LOGIN_MAX_TENTATIVAS = 5;
  const LOGIN_BLOQUEIO_MS = 2 * 60 * 1000;

  function registrarFalhaLogin(ident) {
    const agora = Date.now();
    const rec = _loginFalhas.get(ident) || { conta: 0, bloqueioAte: 0 };
    if (agora > rec.bloqueioAte) { rec.conta = 0; rec.bloqueioAte = 0; }
    rec.conta++;
    if (rec.conta >= LOGIN_MAX_TENTATIVAS) {
      rec.bloqueioAte = agora + LOGIN_BLOQUEIO_MS;
    }
    _loginFalhas.set(ident, rec);
    return rec;
  }

  function verificarBloqueioLogin(ident) {
    const rec = _loginFalhas.get(ident);
    if (!rec || rec.conta < LOGIN_MAX_TENTATIVAS) return null;
    const agora = Date.now();
    if (agora >= rec.bloqueioAte) {
      _loginFalhas.delete(ident);
      return null;
    }
    const seg = Math.ceil((rec.bloqueioAte - agora) / 1000);
    return { bloqueado: true, segundos: seg, minutos: Math.ceil(seg / 60) };
  }

  function limparFalhasLogin(ident) {
    _loginFalhas.delete(ident);
  }

  /* ---------------- validação de força da senha ---------------- */
  // Requisitos: 8-12 caracteres, 1 maiúscula, 1 minúscula, 1 número, 1 especial
  function validarForcaSenha(senha) {
    const s = String(senha || '');
    if (s.length < 8) throw { status: 400, error: 'A senha deve ter pelo menos 8 caracteres.' };
    if (s.length > 12) throw { status: 400, error: 'A senha deve ter no máximo 12 caracteres.' };
    if (!/[A-Z]/.test(s)) throw { status: 400, error: 'A senha deve conter pelo menos uma letra maiúscula.' };
    if (!/[a-z]/.test(s)) throw { status: 400, error: 'A senha deve conter pelo menos uma letra minúscula.' };
    if (!/[0-9]/.test(s)) throw { status: 400, error: 'A senha deve conter pelo menos um número.' };
    if (!/[^A-Za-z0-9]/.test(s)) throw { status: 400, error: 'A senha deve conter pelo menos um caractere especial (ex: * @ # $ %).' };
    return s;
  }

  /* ---------------- sessão ---------------- */

  function usuarioAtual() {
    // em contexto HTTP o token vem SEMPRE da requisição (header x-cc-token)
    const token = window.__CC_HTTP
      ? (window.__CC_REQUEST_TOKEN || null)
      : localStorage.getItem('token');
    if (!token) return null;
    const db = DB._d();
    const s = IDX.sessaoPorToken().get(token);
    if (!s) { limparSessao(); return null; }
    if (s.expires_at <= new Date().toISOString()) {
      // RF-006: purga na verificação
      db.sessions = db.sessions.filter(x => x.token !== token);
      DB.salvar();
      limparSessao();
      return null;
    }
    return IDX.usuarioPorId().get(s.user_id) || null;
  }

  function salaoDoUsuario(user) {
    if (!user) return null;
    const db = DB._d();
    if (user.role === 'dono') {
      return IDX.lojaPorDono().get(user.id) || null;
    }
    if (user.role === 'barbeiro') {
      const prof = IDX.profissionalPorUsuario().get(user.id);
      if (!prof) return null;
      return IDX.lojaPorId().get(prof.barbershop_id) || null;
    }
    /* Dependente/Funcionário: vínculo direto users.barbershop_id
       (acessa DADOS e AGENDA da empresa pelo Código Único). */
    if (user.role === 'dependente' && user.barbershop_id) {
      return IDX.lojaPorId().get(user.barbershop_id) || null;
    }
    return null;
  }

  function criarSessao(userId) {
    const db = DB._d();
    /* limita a 5 sessões ativas por usuário */
    const ativas = IDX.sessoesPorUsuario().get(userId) || [];
    if (ativas.length >= 5) {
      const maisAntiga = ativas.slice().sort((a, b) => a.expires_at.localeCompare(b.expires_at))[0];
      db.sessions = db.sessions.filter(s => s.id !== maisAntiga.id);
    }
    const expira = new Date(Date.now() + TOKEN_TTL_DIAS * 24 * 3600 * 1000).toISOString();
    const sessao = { id: DB.proximoId(), user_id: userId, token: gerarToken(), expires_at: expira };
    db.sessions.push(sessao);
    DB.salvar();
    localStorage.setItem('token', sessao.token);
    const u = IDX.usuarioPorId().get(userId);
    const shop = salaoDoUsuario(u);
    localStorage.setItem('user', JSON.stringify(publicUser(u)));
    localStorage.setItem('barbershop', shop ? JSON.stringify(shop) : '');
    return sessao;
  }

  function limparSessao() {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    localStorage.removeItem('barbershop');
  }

  function logout(tokenAtual) {
    const db = DB._d();
    const token = tokenAtual || (window.__CC_HTTP
      ? (window.__CC_REQUEST_TOKEN || null)
      : localStorage.getItem('token'));
    // RF-008: invalida somente o token atual
    db.sessions = db.sessions.filter(s => s.token !== token);
    DB.salvar();
    limparSessao();
  }

  function publicUser(u) {
    return u ? {
      id: u.id, role: u.role, name: u.name,
      email: u.email || '', phone: u.phone, verified: !!u.verified,
      prefs: u.prefs || null
    } : null;
  }

  /* ============================================================
     FLUXO SMS (RF-001..RF-004, DT-13)
     ============================================================ */

  function codigoAtivo(ident) {
    return DB._d().sms_codes.find(c => c.ident === ident && !c.used) || null;
  }

  function cooldownRestanteSeg(ident) {
    const c = codigoAtivo(ident);
    if (!c || !c.next_allowed_at) return 0;
    const rest = Math.ceil((c.next_allowed_at - agoraMs()) / 1000);
    return rest > 0 ? rest : 0;
  }

  /**
   * Etapa 1 — solicitar código.
   * modo 'login' exige identidade (telefone OU e-mail) existente;
   * 'registro' exige telefone novo.
   */
  function requestCode(dados) {
    const db = DB._d();
    let senhaHash = null;   // só no modo 'registro'

    /* Identidade: e-mail tem prioridade (login/cadastro por e-mail — RF-002).
       Quando só o campo telefone veio preenchido, normalizamos (aceita e-mail). */
    const tel = String((dados && dados.phone) || '').trim();
    const em = String((dados && dados.email) || '').trim();
    const emValido = !!em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(em).toLowerCase());
    const ident = normalizarIdentidade(emValido ? em : tel);
    const porEmail = ehEmail(ident);

    if (porEmail) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident)) {
        throw { status: 400, error: 'E-mail inválido.' };
      }
    } else if (ident.length < 10) {
      throw { status: 400, error: 'Informe um telefone válido (ao menos 10 dígitos com DDD) ou um e-mail.' };
    }

    const cooldown = cooldownRestanteSeg(ident);
    if (cooldown > 0) throw { status: 429, error: 'Aguarde ' + cooldown + 's para solicitar um novo código.' };

    const existente = usuarioPorIdentidade(db, ident);

    if (dados.modo === 'login') {
      if (!existente) {
        throw { status: 404, error: porEmail
          ? 'E-mail não cadastrado. Verifique o e-mail ou crie uma conta.'
          : 'Número não cadastrado. Crie uma conta.' };
      }
    } else if (dados.modo === 'registro') {
      if (existente) throw { status: 409, error: porEmail
        ? 'E-mail já cadastrado. Faça login.'
        : 'Número já cadastrado. Faça login.' };
      const nome = String(dados.name || '').trim();
      if (!nome) throw { status: 400, error: 'Informe seu nome.' };
      const email = porEmail ? ident : String(dados.email || '').trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw { status: 400, error: 'Informe um e-mail válido.' };
      const role = dados.role === 'dono' ? 'dono' : 'cliente';
      if (role === 'dono' && !String(dados.salon_name || '').trim()) {
        throw { status: 400, error: 'Informe o nome do salão.' };
      }
      /* A senha é validada e convertida em hash AQUI, no passo 1, e não no
         verifyCode. O payload do pedido fica ~10 min na tabela sms_codes
         (que entra no pg_dump de backup), então nunca guardamos a senha em
         claro: só o hash scrypt, que é o que será gravado em
         users.password_hash quando o código for confirmado.

         Validar agora também faz o erro de senha fraca aparecer na hora, em
         vez de o usuário preencher tudo, esperar o e-mail e só então ser
         rejeitado ao digitar o código. */
      senhaHash = hashSenha(validarForcaSenha(dados.senha));
    } else {
      throw { status: 400, error: 'Modo inválido (use login ou registro).' };
    }

    /* RF-002: o código é entregue SEMPRE por e-mail (sem SMS). login/cadastro
       por e-mail usam a identidade; recuperar por telefone e o caso de
       telefone usam o e-mail informado ou o já cadastrado do usuário.

       Tudo é validado ANTES de gravar o código: se o envio falhar depois do
       push, o usuário ficaria com cooldown ativo e um código válido que
       nunca chegou — impossible de recuperar sem esperar o cooldown. */
    var emailCodigo = porEmail
      ? ident
      : (String(dados.email || '') || (existente && existente.email) || '').trim();
    if (!emailCodigo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailCodigo)) {
      throw {
        status: 400,
        error: porEmail
          ? 'Não foi possível enviar o código para esse e-mail.'
          : 'Informe um e-mail válido (cadastro) ou o e-mail cadastrado (login). Não usamos mais SMS.'
      };
    }
    if (!Mailer.temEmailReal()) {
      throw {
        status: 500,
        error: 'E-mail não configurado no servidor (GMAIL_USER/GMAIL_PASS). Não é possível enviar o código.'
      };
    }

    // RF-002: novo pedido substitui o código anterior da mesma identidade
    db.sms_codes = db.sms_codes.filter(c => c.ident !== ident);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const registro = {
      id: DB.proximoId(),
      ident,
      phone: porEmail
        ? String((dados && dados.phone) || '').replace(/\D/g, '')
        : ident,
      code,
      expires_at: agoraMs() + CODIGO_TTL_MS,
      attempts: 0,
      used: 0,
      next_allowed_at: agoraMs() + COOLDOWN_MS,
      payload: dados.modo === 'registro'
        ? {
            modo: 'registro',
            name: String(dados.name || '').trim(),
            email: porEmail ? ident : String(dados.email || '').trim(),
            phone: porEmail
              ? String((dados && dados.phone) || '').replace(/\D/g, '')
              : (existente ? (existente.phone || '') : ''),
            role: dados.role === 'dono' ? 'dono' : 'cliente',
            salon_name: String(dados.salon_name || '').trim(),
            senha_hash: senhaHash,
            aceite_privacidade: !!(dados.aceite_privacidade || dados.aceiteTermos || dados.termosAceitos || dados.termsAccepted)
          }
        : { modo: 'login' },
      created_at: new Date().toISOString()
    };
    db.sms_codes.push(registro);
    DB.salvar();
    console.info('[Auth] Código de verificação gerado para ' + ident + '.');

    Mailer.enviarCodigoVerificacao(emailCodigo, code)
      .catch(function(e) { console.error('[mailer] falha ao enviar código de verificação:', e); });

    /* link mágico por e-mail (se usuário tem email) */
    var emailDestino = porEmail ? ident : (dados.email || '');
    if (!emailDestino || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailDestino)) {
      if (existente && existente.email) emailDestino = existente.email;
    }
    if (emailDestino && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailDestino)) {
      var crypto = require('crypto');
      var token = crypto.randomBytes(32).toString('hex');
      var agora = new Date();
      var expira = new Date(agora.getTime() + 15 * 60 * 1000);
      /* tokens sem conta ainda usam user_id NULL — o sentinela precisa
         casar com o que o banco guarda, senão os tokens órfãos antigos
         nunca são limpos e o limite de 3 nunca conta. */
      var donoToken = existente ? existente.id : null;
      var ativos = (db.magic_tokens || []).filter(function(t) {
        return t.user_id === donoToken && !t.used;
      });
      if (ativos.length >= 3) {
        db.magic_tokens = db.magic_tokens.filter(function(t) {
          return t.user_id !== donoToken || t.used;
        });
      }
      db.magic_tokens.push({
        id: DB.proximoId(),
        token: token,
        user_id: donoToken,
        email: emailDestino,
        expires_at: expira.toISOString(),
        used: 0,
        created_at: agora.toISOString()
      });
      DB.salvar();
      var nomeUser = existente ? existente.name : (dados.name || 'Usuário');
      Mailer.enviarLinkMagico(emailDestino, token, nomeUser)
        .catch(function(e) { console.error('[mailer] falha:', e); });
    }

    var resposta = {
      ok: true,
      expires_in_seconds: 600,
      cooldown_seconds: COOLDOWN_MS / 1000
    };
    return resposta;
  }

  /** Reenvio usa a mesma validação de cooldown do request original. */
  function reenviarCodigo(phone, modo) {
    return requestCode({ phone, modo });
  }

/** Reenvio com identidade completa (e-mail ou telefone). */
  function reenviarCodigoIdentidade(dados) {
    return requestCode(dados);
  }

  /* Cooldown de 30s para pedidos de recuperação de acesso (em memória,
     sem tocar no banco) — evita spam de e-mails de recuperação. */
  var _recoverCooldown = new Map();
  var RECOVER_COOLDOWN_MS = 30 * 1000;

  /**
   * Recuperação de acesso ("esqueci minha senha").
   * Envia por e-mail (Gmail via Mailer) um link mágico que entra
   * na conta direto — o app é sem senha (telefone + código).
   * Não revela se o e-mail está cadastrado (anti-enumeração).
   */
  function recuperarAcesso(email) {
    const db = DB._d();
    const ident = normalizarIdentidade(email);
    if (!ehEmail(ident) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident)) {
      throw { status: 400, error: 'Informe um e-mail válido.' };
    }

    const agora = Date.now();
    const ultimo = _recoverCooldown.get(ident) || 0;
    if (agora - ultimo < RECOVER_COOLDOWN_MS) {
      const rest = Math.ceil((RECOVER_COOLDOWN_MS - (agora - ultimo)) / 1000);
      throw { status: 429, error: 'Aguarde ' + rest + 's para solicitar novamente.' };
    }
    _recoverCooldown.set(ident, agora);

    const usuario = usuarioPorIdentidade(db, ident);
    if (!usuario) return { ok: true, expires_in_seconds: 900 };

    /* limpa tokens mágicos anteriores do usuário (sem stack) e insere um novo */
    db.magic_tokens = (db.magic_tokens || []).filter(t => t.user_id !== usuario.id);
    const token = require('crypto').randomBytes(32).toString('hex');
    const expira = new Date(agora + 15 * 60 * 1000);
    db.magic_tokens.push({
      id: DB.proximoId(),
      token: token,
      user_id: usuario.id,
      email: ident,
      expires_at: expira.toISOString(),
      used: 0,
      created_at: new Date(agora).toISOString()
    });
    DB.salvar();

    let enviado = false;
    try {
      const p = Mailer.enviarRecuperacao(ident, token, usuario.name);
      if (p && typeof p.then === 'function') p.then(function () { enviado = true; }).catch(function (e) { console.error('[auth][recuperacao] falha:', e); });
      else enviado = true;
    } catch (e) { console.error('[auth][recuperacao] indisponivel:', e); }

    /* Honestidade: se não há SMTP, avisa. O usuário sem e-mail funcional
       fica sabendo que o código não saiu — em vez de achar que vai chegar. */
    if (!enviado) {
      return { ok: true, expires_in_seconds: 900, enviado: false, aviso: 'Não foi possível enviar o e-mail de recuperação (SMTP não configurado). O código não foi entregue.' };
    }
    return { ok: true, expires_in_seconds: 900, enviado: true };
  }

  /**
   * Etapa 2 — verificar código e abrir sessão (RF-004/RF-005).
   * Provisionamento atômico do dono: usuário + loja + horários + trial.
   */
  function verifyCode(identBruto, codeBruto) {
    const db = DB._d();
    const ident = normalizarIdentidade(identBruto);
    const code = String(codeBruto || '').replace(/\D/g, '');
    const porEmail = ehEmail(ident);

    /* rate limiting login */
    const bloqueio = verificarBloqueioLogin(ident);
    if (bloqueio) {
      throw { status: 429, error: 'Muitas tentativas. Aguarde ' + bloqueio.minutos + ' min para tentar novamente.' };
    }

    const reg = codigoAtivo(ident);
    if (!reg) throw { status: 400, error: 'Nenhum código ativo. Solicite um novo código.' };
    if (reg.attempts >= MAX_TENTATIVAS) {
      db.sms_codes = db.sms_codes.filter(c => c.id !== reg.id);
      DB.salvar();
      throw { status: 400, error: 'Código bloqueado após 5 tentativas. Solicite um novo.' };
    }
    if (agoraMs() > reg.expires_at) {
      db.sms_codes = db.sms_codes.filter(c => c.id !== reg.id);
      DB.salvar();
      throw { status: 400, error: 'Código expirado. Solicite um novo código.' };
    }
    if (code.length !== 6) throw { status: 400, error: 'Informe o código de 6 dígitos.' };
    if (reg.code !== code) {
      reg.attempts += 1;
      DB.salvar();
      registrarFalhaLogin(ident);
      const restantes = MAX_TENTATIVAS - reg.attempts;
      throw { status: 400, error: 'Código incorreto.' + (restantes > 0 ? ' Tentativas restantes: ' + restantes + '.' : '') };
    }

    // sucesso - limpar falhas
    limparFalhasLogin(ident);

    // uso único (RF-002)
    db.sms_codes = db.sms_codes.filter(c => c.id !== reg.id);

    let usuario = usuarioPorIdentidade(db, ident);
    let barbearia = null;
    const p = reg.payload || {};

    if (!usuario) {
      if (p.modo === 'registro' && !p.aceite_privacidade) {
        throw { status: 400, error: 'O aceite da Política de Privacidade e Termos de Uso é obrigatório. Envie o campo aceite_privacidade (ou aceiteTermos) como true no registro.' };
      }
      /* O passo 1 (requestCode) já validou a senha e guardou só o hash no
         payload, então aqui basta exigir que ele exista: é ele que vira
         users.password_hash e permite o login por senha nos acessos
         seguintes, sem novo código. */
      if (p.modo === 'registro' && !p.senha_hash) {
        throw { status: 400, error: 'Cadastro incompleto: a senha não foi salva. Inicie o cadastro novamente.' };
      }
      // criação no verify (RF-004) — identidade por e-mail ou telefone
      usuario = {
        id: DB.proximoId(),
        role: p.role === 'dono' ? 'dono' : 'cliente',
        name: p.name || 'Usuário',
        email: p.email || (porEmail ? ident : ''),
        phone: p.phone || (porEmail ? '' : ident),
        verified: 1,
        password_hash: p.senha_hash || null,
        consentimentos: [{ tipo: 'privacidade', data: new Date().toISOString(), versao: '1.0' }],
        created_at: DB.hojeISO() + 'T' + DB.minToHHMM(DB.agoraMinutos()),
        prefs: { notif_email: 'sim', notif_sms: 'não', lembrete: '30' }
      };
      db.users.push(usuario);
      if (usuario.role === 'dono') barbearia = provisionarSalao(usuario, p.salon_name);
      /* email de onboarding para novo dono (10 dias grátis só quando a
         promoção está ligada pelo super-admin) */
      if (usuario.role === 'dono' && usuario.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(usuario.email)) {
        let trialDias = 0;
        try {
          const stTrial = (DB._d().platform_settings || []).find(s => s.chave === 'trial_10dias');
          if (!stTrial || !stTrial.valor || stTrial.valor.ativo !== false) trialDias = 10;
        } catch (e) { /* padrão: sem promessa de trial no e-mail */ }
        Mailer.enviarBoasVindas({
          email: usuario.email, nome: usuario.name,
          nomeSalao: p.salon_name || (barbearia && barbearia.name) || 'Seu salão',
          trialDias,
          shopId: barbearia && barbearia.id
        }).catch(function(e) { console.error('[onboarding] falha:', e); });
      }
      DB.salvar();
    } else {
      usuario.verified = 1;
      if (p.name) usuario.name = p.name;
      if (p.email) usuario.email = p.email;
      DB.salvar();
      if (usuario.role === 'dono' || usuario.role === 'barbeiro') {
        barbearia = salaoDoUsuario(usuario);
      }
    }

    criarSessao(usuario.id);

    /* audit log: login bem-sucedido */
    try {
      var _apiGlobal = (typeof window !== 'undefined') ? (window.API || null) : null;
      var _auditFn = _apiGlobal ? _apiGlobal._auditLog : null;
      if (typeof _auditFn === 'function') {
        _auditFn(usuario.id, 'login_sucesso');
      } else {
        console.warn('[auth] _auditLog indisponível no login');
      }
    } catch(e) { console.error('[auth] falha ao registrar login no audit log:', e); }

    return { token: localStorage.getItem('token'), user: publicUser(usuario), barbershop: barbearia };
  }

  /**
   * Login tradicional com e-mail OU telefone + senha (cliente/dono).
   * O front manda o que o usuário digitou no campo "e-mail/telefone";
   * a identidade é normalizada aqui (e-mail em minúsculas ou só dígitos).
   */
  function loginComSenha(identidade, senha) {
    if (!identidade || !senha) {
      throw { status: 400, error: 'Informe e-mail/telefone e senha.' };
    }
    const ident = normalizarIdentidade(identidade);
    if (!ehEmail(ident) && !/^\d{10,11}$/.test(ident)) {
      throw { status: 400, error: 'Informe um e-mail ou telefone válido.' };
    }

    /* rate limiting */
    const bloqueio = verificarBloqueioLogin(ident);
    if (bloqueio) {
      throw { status: 429, error: 'Muitas tentativas. Aguarde ' + bloqueio.minutos + ' min para tentar novamente.' };
    }

    const db = DB._d();
    let usuario = usuarioPorIdentidade(db, ident);
    if (usuario && usuario.role === 'dependente') usuario = null;
    /* conta sem senha na mesma identidade? tenta a outra que tem */
    if (usuario && !usuario.password_hash) {
      const comSenha = usuarioComSenhaPorIdentidade(db, ident);
      if (comSenha) usuario = comSenha;
    }
    if (!usuario) {
      throw { status: 401, error: 'E-mail/telefone ou senha incorretos.' };
    }
    if (!usuario.password_hash) {
      throw { status: 400, error: 'Esta conta não tem senha cadastrada. Entre com código de verificação ou defina uma senha.' };
    }
    if (!verificarSenha(senha, usuario.password_hash)) {
      registrarFalhaLogin(ident);
      throw { status: 401, error: 'E-mail/telefone ou senha incorretos.' };
    }

    limparFalhasLogin(ident);

    let barbearia = null;
    if (usuario.role === 'dono' || usuario.role === 'barbeiro') {
      barbearia = salaoDoUsuario(usuario);
    }

    criarSessao(usuario.id);
    _auditLog(usuario.id, 'login_sucesso');

    return { token: localStorage.getItem('token'), user: publicUser(usuario), barbershop: barbearia };
  }

  /**
   * Alterar senha — exige senha atual + nova + confirmação.
   * Usado pelo usuário logado no painel.
   * O userId NÃO vem do cliente: é derivado da sessão (RPC já validado
   * o token em _authRequired). Antes esta função exigia userId como 1º
   * argumento e o front enviava só as 3 senhas — o usuário caía no
   * lugar errado e a troca de senha era impossível.
   */
  function alterarSenha(senhaAtual, novaSenha, confirmarSenha) {
    if (!senhaAtual || !novaSenha || !confirmarSenha) {
      throw { status: 400, error: 'Todos os campos são obrigatórios.' };
    }
    if (novaSenha !== confirmarSenha) {
      throw { status: 400, error: 'A nova senha e a confirmação não coincidem.' };
    }
    validarForcaSenha(novaSenha);
    if (senhaAtual === novaSenha) {
      throw { status: 400, error: 'A nova senha deve ser diferente da atual.' };
    }

    const atual = usuarioAtual();
    if (!atual) throw { status: 401, error: 'Sessão expirada. Faça login novamente.' };
    const userId = atual.id;

    const db = DB._d();
    const usuario = IDX.usuarioPorId().get(userId);
    if (!usuario) throw { status: 404, error: 'Usuário não encontrado.' };
    if (!usuario.password_hash) {
      throw { status: 400, error: 'Esta conta não possui senha definida. Use a recuperação de acesso.' };
    }
    if (!verificarSenha(senhaAtual, usuario.password_hash)) {
      throw { status: 401, error: 'Senha atual incorreta.' };
    }

    usuario.password_hash = hashSenha(novaSenha);
    usuario.updated_at = new Date().toISOString();
    DB.salvar();
    _auditLog(userId, 'alterar_senha');
    logoutTodos(userId); // invalida todas as sessões
    return { ok: true };
  }

  /**
   * Solicitar redefinição de senha — exige e-mail + senha atual.
   * Se credenciais válidas, envia link mágico por e-mail.
   */
  function solicitarRedefinicaoSenha(email, senhaAtual) {
    const db = DB._d();
    const ident = normalizarIdentidade(email);
    if (!ehEmail(ident) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ident)) {
      throw { status: 400, error: 'Informe um e-mail válido.' };
    }
    if (!senhaAtual || String(senhaAtual).length === 0) {
      throw { status: 400, error: 'Informe sua senha atual para prosseguir.' };
    }

    const usuario = usuarioPorIdentidade(db, ident);
    if (!usuario) {
      // anti-enumeração: mesmo erro genérico
      throw { status: 401, error: 'E-mail ou senha incorretos.' };
    }
    if (!usuario.password_hash) {
      throw { status: 400, error: 'Esta conta não possui senha definida. Use a recuperação de acesso.' };
    }
    if (!verificarSenha(senhaAtual, usuario.password_hash)) {
      throw { status: 401, error: 'E-mail ou senha incorretos.' };
    }

    const agora = Date.now();
    /* limpa tokens anteriores e cria novo para redefinição */
    db.reset_tokens = (db.reset_tokens || []).filter(t => t.user_id !== usuario.id);
    const token = require('crypto').randomBytes(32).toString('hex');
    const expira = new Date(agora + 60 * 60 * 1000); // 1 hora
    db.reset_tokens.push({
      id: DB.proximoId(),
      token: token,
      user_id: usuario.id,
      email: ident,
      expires_at: expira.toISOString(),
      used: 0,
      created_at: new Date(agora).toISOString()
    });
    DB.salvar();

    let enviado = false;
    try {
      const p = Mailer.enviarRedefinicaoSenha(ident, token, usuario.name);
      if (p && typeof p.then === 'function') p.then(function () { enviado = true; }).catch(function (e) { console.error('[auth][reset] falha:', e); });
      else enviado = true;
    } catch (e) { console.error('[auth][reset] indisponivel:', e); }

    if (!enviado) {
      return { ok: true, enviado: false, aviso: 'Não foi possível enviar o e-mail (SMTP não configurado).' };
    }
    return { ok: true, enviado: true };
  }

  /**
   * Redefinir senha via token — nova senha + confirmação (sem senha atual).
   */
  function redefinirSenha(token, novaSenha, confirmarSenha) {
    if (!token || !novaSenha || !confirmarSenha) {
      throw { status: 400, error: 'Todos os campos são obrigatórios.' };
    }
    if (novaSenha !== confirmarSenha) {
      throw { status: 400, error: 'A nova senha e a confirmação não coincidem.' };
    }
    validarForcaSenha(novaSenha);

    const db = DB._d();
    const rt = (db.reset_tokens || []).find(t => t.token === token && !t.used);
    if (!rt) throw { status: 400, error: 'Token inválido ou já utilizado.' };
    if (new Date(rt.expires_at) < new Date()) {
      throw { status: 400, error: 'Token expirado. Solicite uma nova redefinição.' };
    }

    const usuario = IDX.usuarioPorId().get(rt.user_id);
    if (!usuario) throw { status: 404, error: 'Usuário não encontrado.' };

    usuario.password_hash = hashSenha(novaSenha);
    usuario.updated_at = new Date().toISOString();
    rt.used = 1;
    DB.salvar();
    _auditLog(usuario.id, 'redefinir_senha');
    logoutTodos(usuario.id);
    return { ok: true };
  }

  /**
   * RF-005 — provisionamento do dono.
   */
  function provisionarSalao(usuario, nomeSalao) {
    const db = DB._d();
    const slug = slugUnico(nomeSalao);

    const loja = {
      id: DB.proximoId(),
      owner_user_id: usuario.id,
      name: nomeSalao,
      description: '',
      slug,
      codigo_unico: gerarCodigoUnico(),
      phone: (() => {
        const d = String(usuario.phone || '').replace(/\D/g, '');
        return d ? '(' + String(d).slice(0, 2) + ') ' + String(d).slice(2) : '';
      })(),
      whatsapp: '', email: usuario.email || '', instagram: '',
      address: '', city: '', uf: '',
      lat: null, lng: null,
      logo_url: null, cover_url: null,
      tags: ['Corte', 'Barba'],
      ratingBase: 0, ratingCountBase: 0,
      horarios_configurados: 0,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    db.barbershops.push(loja);

    /* horários padrão da LOJA: seg–sáb 09–18 sem almoço, dom fechado */
    for (let dow = 1; dow <= 6; dow++) {
      db.working_hours.push({
        id: DB.proximoId(), barbershop_id: loja.id, professional_id: null,
        day_of_week: dow, start_time: '09:00', end_time: '18:00',
        lunch_start: null, lunch_end: null, is_open: 1
      });
    }
    db.working_hours.push({
      id: DB.proximoId(), barbershop_id: loja.id, professional_id: null,
      day_of_week: 0, start_time: '09:00', end_time: '18:00',
      lunch_start: null, lunch_end: null, is_open: 0
    });

    /* serviços iniciais para o catálogo já ter conteúdo */
    [
      { nome: 'Corte', dur: 30, preco: 40 },
      { nome: 'Barba', dur: 20, preco: 25 },
      { nome: 'Corte + Barba', dur: 45, preco: 60 }
    ].forEach((s, i) => {
      db.services.push({
        id: DB.proximoId(), barbershop_id: loja.id, name: s.nome,
        category: s.nome.includes('Barba') ? 'Barba' : 'Cabelo',
        description: '', duration_min: s.dur, price: s.preco,
        active: 1, sort_order: i + 1, created_at: new Date().toISOString()
      });
    });

    /* assinatura base (RF-058 v3): novo cadastro começa sem benefícios
       (trial de 10 dias é opcional via API.ativarTrial). Sem plano
       gratuito, a loja fica sem assinatura até assinar um plano pago. */
    const planoFree = db.plans.find(p => p.is_free);
    if (planoFree) {
      db.subscriptions.push({
        id: DB.proximoId(),
        barbershop_id: loja.id,
        plan_id: planoFree.id,
        status: 'ativa',
        trial_ends_at: null,
        current_period_end: null,
        trial_usado: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
    }

    return loja;
  }

  /* ---------------- API pública ---------------- */

  function logoutTodos(userId) {
    var d = DB._d();
    d.sessions = (d.sessions || []).filter(function(s) { return s.user_id !== userId; });
    DB.salvar();
  }

  return {
    normalizarTelefone,
    normalizarIdentidade,
    requestCode,
    reenviarCodigo,
    reenviarCodigoIdentidade,
    recuperarAcesso,
    solicitarRedefinicaoSenha,
    redefinirSenha,
    verifyCode,
    loginComSenha,
    usuarioAtual,
    publicUser,
    salaoDoUsuario,
    logout,
    logoutTodos,
    limparSessao,
    criarSessao,
    gerarCodigoUnico,
    hashSenha,
    verificarSenha,
    validarForcaSenha,
    alterarSenha
  };
})();
