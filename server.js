'use strict';
/* ============================================================
   Corte Comigo – server.js
   Servidor de desenvolvimento, sem dependências externas.

   POST /api/rpc  → dispatch direto para as funções do backend
   GET  /*        → arquivos estáticos de frontend/

   O token de sessão viaja no header "x-cc-token".
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

/* Render/Neon não têm rota IPv6 — sem isso o envio de e-mail (Gmail)
   falha com "connect ENETUNREACH <ipv6>". Obriga IPv4 primeiro no DNS. */
try { require('dns').setDefaultResultOrder('ipv4first'); } catch (e) { /* Node antigo */ }

/* Carrega o .env da raiz (KEY=VALUE por linha) antes do boot —
   sem sobrescrever variáveis já definidas no ambiente */
(function carregarDotEnv() {
  try {
    const conteudo = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
    conteudo.split(/\r?\n/).forEach(linha => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(linha);
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    });
  } catch (e) { /* projeto sem .env — ok */ }
})();

/* ---- Segurança (fail-closed): sem DB_ENCRYPT_KEY o servidor NÃO sobe.
   A ausência da chave faria o crypt.js persistir PII (e-mails/telefones)
   em texto puro silenciosamente. Desative a proteção apenas em ambientes
   de demonstração com CC_CRYPT_INSECURE_PLAINTEXT=1 (default inseguro). ---- */
if (!String(process.env.DB_ENCRYPT_KEY || '').trim() &&
    !String(process.env.CC_CRYPT_INSECURE_PLAINTEXT || '').trim()) {
  console.error(
    '[SEGURANÇA][BOOT] DB_ENCRYPT_KEY não configurado. ' +
    'Sem a chave a aplicação falha fechada (não sobe) para nunca gravar ' +
    'dados sensíveis em claro. Defina DB_ENCRYPT_KEY no .env ' +
    'ou, APENAS em demo, CC_CRYPT_INSECURE_PLAINTEXT=1.'
  );
  escreverBootErro('DB_ENCRYPT_KEY não configurado no servidor Hostinger.', 'Defina DB_ENCRYPT_KEY nas variáveis de ambiente do app (hPanel -> Node.js -> Environment variables).');
  process.exit(1);
}

/* Guard de boot: se alguma etapa crítica falhar, escreve o MOTIVO em
   boot-error.log (raiz do projeto) para diagnóstico no painel do
   Hostinger, mesmo sem acesso aos logs do processo. */
function escreverBootErro(motivo, detalhe) {
  try {
    const corpo =
      '[' + new Date().toISOString() + '] ' + String(motivo || 'erro') +
      (detalhe ? '\n' + String(detalhe) : '') + '\n';
    fs.appendFileSync(path.join(__dirname, 'boot-error.log'), corpo, 'utf8');
    console.error('[boot][erro] ' + String(motivo || 'erro') + ' — detalhes em backend/boot-error.log');
  } catch (e) { /* diagnóstico não pode quebrar mais ainda */ }
}

/* Timeout em operações de boot que podem travar (ex.: conexão IPv6 que
   não responde): em vez de "inicializando..." para sempre, vira erro visível. */
function comTimeout(prom, ms, msg) {
  let t;
  const timer = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(msg || ('timeout de ' + ms + 'ms'))), ms);
  });
  return Promise.race([prom, timer]).finally(() => clearTimeout(t));
}

let MODULOS_BOOT = null;
try {
  MODULOS_BOOT = require('./backend/boot');
} catch (e) {
  /* Ex.: DATABASE_URL ausente lança dentro de backend/pool.js */
  escreverBootErro('Falha ao carregar o backend (require):', (e && (e.stack || e.message)) || e);
  process.exit(1);
}
const { API, Auth, Bot } = MODULOS_BOOT;

const PORTA = Number(process.env.PORT || 3000);
const RAIZ = path.join(__dirname, 'frontend');

/* Rótulo do build no ar (ver /api/versao e o rodapé da tela de login). */
const VERSAO_BUILD = (() => {
  let deploy = null;
  try { deploy = fs.statSync(__filename).mtime.toISOString(); } catch (e) { /* sem mtime */ }
  const carimbo = { deploy };
  try {
    if (process.env.VERSAO_BUILD) {
      carimbo.versao = String(process.env.VERSAO_BUILD).slice(0, 40);
      return carimbo;
    }
    const head = fs.readFileSync(path.join(__dirname, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*(refs\/heads\/.+)$/);
    if (m) {
      carimbo.branch = m[1].replace('refs/heads/', '');
      try {
        carimbo.versao = fs.readFileSync(path.join(__dirname, '.git', m[1]), 'utf8').trim().slice(0, 7);
      } catch (e) {
        /* ref pode estar compactada em .git/packed-refs */
        const packed = fs.readFileSync(path.join(__dirname, '.git', 'packed-refs'), 'utf8');
        const linha = packed.split(/\r?\n/).find(l => l.endsWith(' ' + m[1]));
        if (linha) carimbo.versao = linha.split(' ')[0].slice(0, 7);
      }
    } else {
      carimbo.versao = head.slice(0, 7);
    }
  } catch (e) { /* .git não publicado no hosting */ }
  if (!carimbo.versao) carimbo.versao = 'sem-git';
  return carimbo;
})();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json'
};

/* Cabeçalhos de segurança aplicados a TODAS as respostas (RNF-14) */
function headersPadrao(extra) {
  const base = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-XSS-Protection': '1; mode=block',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; " +
      "font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; " +
      "base-uri 'self'; form-action 'self'; upgrade-insecure-requests"
  };
  return Object.assign(base, extra || {});
}

function json(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
    'Cache-Control': 'no-store'
  });
  res.end(corpo);
}

// [SEGURANÇA] Helper para mascarar e-mail em logs
function mascararEmail(e) {
  const [u, d] = String(e || '').split('@');
  return (u && u[0] ? u[0] : '') + '***@' + (d || '');
}

/* ---------------- rate-limit ---------------- */
const _rateMap = new Map();
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 300;

/* Atrás do proxy (Render) o remoteAddress é o IP do proxy, compartilhado
   por todos os clientes — o teto viraria global e estouraria com o polling
   do painel. Resolve o IP real do cliente via X-Forwarded-For (primeiro
   hop) quando presente. */
/* [SEGURANÇA] X-Forwarded-For só é confiável atrás de um proxy que o
   sobrescreve. Aceitar o header unconditionally deixava qualquer cliente
   forjar o IP e zerar o rate-limit por IP a cada requisição. Só usamos o
   header quando TRUST_PROXY=1 (configurado em ambientes com proxy). */
const _confiaProxy = process.env.TRUST_PROXY === '1';

function ipDoRequest(req) {
  if (_confiaProxy) {
    const fwd = req.headers && req.headers['x-forwarded-for'];
    if (fwd) {
      const primeiro = String(fwd).split(',')[0].trim();
      if (primeiro) return primeiro;
    }
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

/* Limpa os rate/burte-force maps periodicamente: registros fora da janela
   não voltam mais a ser consultados (_rateMap acumulava um IP por cliente
   ao dia). Roda a cada 10 min — nunca afeta contadores de requisições
   ativas (esses são consultados e renovados continuamente). */
setInterval(() => {
  const agora = Date.now();
  for (const [ip, rec] of _rateMap) {
    if (agora >= rec.reset) _rateMap.delete(ip);
  }
  for (const [k, rec] of _failedAuth) {
    const janelaExpirada = agora >= (rec.windowStart + AUTH_FAIL_WINDOW_MS);
    const bloqueioExpirado = agora >= rec.blockedUntil;
    if (rec.count === 0 || (janelaExpirada && bloqueioExpirado)) _failedAuth.delete(k);
  }
  for (const [k, rec] of _failedAuthByIdent) {
    if (agora >= rec.blockedUntil) _failedAuthByIdent.delete(k);
  }
}, 10 * 60 * 1000);

/* ---------------- auth-brute-force ---------------- */
const _failedAuth = new Map();
const AUTH_FAIL_MAX = 5;
const AUTH_FAIL_WINDOW_MS = 15 * 60 * 1000;
const AUTH_BLOCK_MS = 15 * 60 * 1000;

// [SEGURANÇA] Rate-limit por identidade (e-mail/CPF) além de IP
const _failedAuthByIdent = new Map();
const AUTH_FAIL_MAX_IDENT = 10;
const AUTH_BLOCK_MS_IDENT = 30 * 60 * 1000; // 30 minutos

/* Métodos RPC que exigem sessão válida (segunda camada de defesa) */
const _authRequired = new Set([
  'criarAgendamento', 'listarAgendamentos', 'atualizarAgendamento',
  'excluirAgendamento', 'meusAgendamentos', 'getAgendamento',
  'listarClientes', 'getCliente', 'criarCliente', 'atualizarCliente', 'agendamentosDoCliente',
  'dashboardStats', 'exportarCSV', 'gerarRelatorio', 'gerarRelatorioDiario',
  'minhaLoja', 'atualizarLoja', 'excluirLoja',
  'criarServico', 'atualizarServico', 'excluirServico',
  'criarProfissional', 'atualizarProfissional', 'desativarProfissional',
  'meuCodigoEmpresa', 'listarDependentes', 'criarDependente', 'excluirDependente',
  'vincularDependente', 'sairDeDependente', 'desvincularDependente',
  'salvarHorariosLoja', 'atualizarLinhaHorario',
  'listarExcecoes', 'criarExcecao', 'excluirExcecao',
  'minhaAssinatura', 'trocarPlano', 'cancelarAssinatura',
  'minhasNotificacoes', 'naoLidasCount', 'marcarNotificacaoLida', 'marcarTodasLidas',
  'mePerfil', 'atualizarMe', 'atualizarPreferencias', 'excluirMinhaConta',
  'exportarMeusDados', 'revogarConsentimento', 'solicitarExclusao',
  /* enviarSolicitacaoLGPD NÃO exige sessão: a página /lgpd é pública e
     é justamente o canal para quem NÃO tem conta exercer o direito de
     acesso (art. 18 LGPD). Exigir login deixava o formulário público
     retornando 401 para quem mais precisa dele. O limite por IP e a
     validação de campos no backend continuam valendo. */
  'meusLogsDeAcesso', 'logoutTodosDispositivos',
  'alterarSenha',
  'gerarCodigoExclusao', 'confirmarExclusao',
  'alternarFavorito', 'meusFavoritos',
  'criarTicket', 'ticketsDoSalao',
  'reembolsoDisponivel', 'solicitarReembolso', 'meusReembolsos', 'confirmarEnvioGmail',
  'definirLogo', 'definirCapa',
  'adicionarGaleria', 'removerGaleria',
  'gerarLembretesAmanha', 'gerarLembretesPendentes',
  'ativarTrial', 'assinarComTrial',
  'criarCobrancaPlano', 'statusCobranca', 'listarMinhasCobrancas',
  'confirmarCobrancaDemo', 'simularCobranca',
  'estornarArrependimento',
  'criarReview', 'minhasReviews',
  'denunciarPerfil', 'minhasDenuncias',
  'bloquearCliente', 'desbloquearCliente', 'clienteBloqueado',
  'logout'
]);

/* ---------------- RPC ---------------- */

/* Allowlist do RPC: apenas métodos PROPRIEDADES PRÓPRIAS do API/Auth
   (nunca herdadas do protótipo — elimina `constructor`, `__proto__`
   etc.). Bloqueia ainda internos e todo o super-admin, que tem rotas
   REST próprias com needAuth() + rate-limit. */
const _RPC_BLOQUEADOS = new Set([
  'err', '_auditLog', 'processarEventoWebhook',
  'definirModoGratuito',
  'superAdminLogin', 'superAdminAuth', 'superAdminLogout',
  'saListarLojas', 'saListarUsuarios', 'saDetalheLoja',
  'saAtualizarPlano', 'saExcluirLoja', 'saDashboard', 'saRelatorios',
  'saTickets', 'saResponderTicket',
  'saListarReembolsos', 'saMarcarReembolsoRealizado', 'saOcultarReembolso',
  'saListarDenuncias', 'saResolverDenuncia',
  'saListarPlanos', 'saAtualizarPrecosPlano', 'saCriarPlano', 'saEditarPlano', 'saExcluirPlano',
  'saObterConfig', 'saDefinirSiteGratis', 'saDefinirTrial',
  'saSituacao', 'saLogs',
  'definirModoTrial'
]);
/* Métodos de Auth (backend/auth.js) que NÃO exigem sessão. */
const _RPC_AUTH_PUBLICOS = new Set([
  'requestCode', 'reenviarCodigo', 'reenviarCodigoIdentidade', 'verifyCode',
  'recuperarAcesso', 'logout', 'loginComSenha',
  'solicitarRedefinicaoSenha', 'redefinirSenha'
]);
/* Métodos de Auth que EXIGEM sessão válida (também em _authRequired). */
const _RPC_AUTH_COM_SESSAO = new Set([
  'alterarSenha'
]);
const _RPC_API = new Set();
Object.keys(API).forEach(nome => {
  if (_RPC_BLOQUEADOS.has(nome)) return;
  if (nome.charCodeAt(0) === 95) return; // _-prefixo = interno
  if (!Object.prototype.hasOwnProperty.call(API, nome)) return;
  if (typeof API[nome] !== 'function') return;
  _RPC_API.add(nome);
});

/* ---- Invariante de segurança (fail-closed): nenhum método
   administrativo/super-admin pode vazar para o RPC público. Se isso
   acontecer, o servidor NÃO sobe — impede regressões silenciosas. ---- */
for (const nome of _RPC_API) {
  if (/^sa[A-Z]/.test(nome) || /^superAdmin[A-Z]/.test(nome)) {
    throw new Error(
      '[SEGURANÇA][BOOT] Método restrito exposto no RPC público: ' + nome +
      '. Adicione-o a _RPC_BLOQUEADOS ou remova da exportação do API.'
    );
  }
}

/* Invariante de segurança (fail-closed): todo método de Auth allowlisted
   precisa existir de fato em backend/auth.js. Sem isso, um nome errado
   (ou um método removido do Auth) cai no `fn = null` e responde 401
   "Sessão expirada" — foi exatamente o que quebrou o login por senha
   (loginComSenha fora da allowlist). */
for (const nome of [..._RPC_AUTH_PUBLICOS, ..._RPC_AUTH_COM_SESSAO]) {
  if (typeof Auth[nome] !== 'function') {
    throw new Error(
      '[SEGURANÇA][BOOT] Método de Auth allowlisted não existe: ' + nome +
      '. Remova da allowlist ou restaure em backend/auth.js.'
    );
  }
}

/* Métodos públicos do Bot (atendente + chat do site) expostos via RPC.
   Mesmo critério da allowlist de API: nenhum `_`-prefixo, nenhum interno.
   Bot atendente e chats do painel saíram do RPC: são super-admin agora
   (rotas REST /api/super-admin/*). Só restam os 2 públicos do widget. */
const _RPC_BOT = new Set(['chatEnviar', 'chatBuscar']);

/* Rejeita chaves perigosas em payloads aninhados (defesa em
   profundidade contra prototype pollution via dados mesclados). */
function sanitizarParams(v, profundidade) {
  if (profundidade > 12) return undefined;
  if (Array.isArray(v)) {
    return v.map(x => sanitizarParams(x, profundidade + 1))
            .filter(x => x !== undefined);
  }
  if (v && typeof v === 'object' && v.constructor === Object) {
    const limpo = {};
    for (const chave of Object.keys(v)) {
      if (chave === '__proto__' || chave === 'prototype' || chave === 'constructor') continue;
      limpo[chave] = sanitizarParams(v[chave], profundidade + 1);
    }
    return limpo;
  }
  return v;
}

/* Identidade usada no rate-limit por identidade.
   Métodos cujo 1º argumento é a própria identidade (verifyCode,
   recuperarAcesso, reenviarCodigo) recebem uma STRING — ler
   args[0].email desses retornava sempre undefined e o limite por
   identidade nunca era aplicado, sobrando só o contador global por IP. */
function extrairIdentidade(args) {
  const a0 = Array.isArray(args) ? args[0] : null;
  if (typeof a0 === 'string' && a0.trim()) return a0.trim();
  if (a0 && typeof a0 === 'object') {
    return a0.email || a0.ident || a0.cpf || a0.login || a0.phone || null;
  }
  return null;
}

function handleRpc(req, res) {
  /* rate-limit por IP */
  const ip = ipDoRequest(req);
  const now = Date.now();
  const rec = _rateMap.get(ip);
  if (rec && now < rec.reset) {
    rec.count++;
    if (rec.count > RATE_MAX) {
      const retryAfter = Math.ceil((rec.reset - now) / 1000);
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
      return res.end(JSON.stringify({ ok: false, error: 'Muitas requisições. Aguarde ' + retryAfter + 's.' }));
    }
  } else {
    _rateMap.set(ip, { count: 1, reset: now + RATE_WINDOW_MS });
  }

  let corpo = '';
  req.on('data', c => {
    corpo += c;
    // [SEGURANÇA] Reduzido de 2MB para 500KB — galeria envia 1 foto por chamada
    if (corpo.length > 500 * 1024) req.destroy();
  });
  req.on('end', () => {
    let metodo;
    let args;
    try {
      ({ method: metodo, args } = JSON.parse(corpo || '{}'));
    } catch (e) {
      return json(res, 400, { ok: false, error: 'JSON inválido.' });
    }
    if (!metodo) {
      return json(res, 400, { ok: false, error: 'Requisição inválida.' });
    }
/* Allowlist estrita: só métodos próprios e aprovados. Métodos
       inexistentes/não permitidos respondem 401 idêntico ao de sessão
       inválida — impede enumeração de métodos pelo erro. A allowlist
       cobre API, métodos públicos de Auth e o Bot (chat + painel). */
    let fn = null;
    if (_RPC_API.has(metodo) && typeof API[metodo] === 'function') {
      fn = API[metodo];
    } else if ((_RPC_AUTH_PUBLICOS.has(metodo) || _RPC_AUTH_COM_SESSAO.has(metodo)) && typeof Auth[metodo] === 'function') {
      fn = Auth[metodo];
    } else if (_RPC_BOT.has(metodo) && typeof Bot[metodo] === 'function') {
      fn = Bot[metodo];
    }

    /* método inexistente/não permitido: responde 401 idêntico ao de
       sessão inválida — sem enumeração e sem vazar dados (fail-closed) */
    if (!fn) {
      return json(res, 401, { ok: false, error: 'Sessão expirada. Faça login novamente.' });
    }

    /* argumentos: apenas array; qualquer outra forma é rejeitada.
       Sanitiza __proto__/prototype/constructor em payloads aninhados. */
    const argList = Array.isArray(args) ? args.map(a => sanitizarParams(a, 0)) : [];

    // [SEGURANÇA] Rate-limit por identidade (e-mail/telefone/login) além do IP
    const ident = extrairIdentidade(args);
    if (ident) {
      const identKey = 'ident:' + String(ident).toLowerCase().trim();
      const recIdent = _failedAuthByIdent.get(identKey);
      if (recIdent && Date.now() < recIdent.blockedUntil) {
        return json(res, 429, { ok: false, error: 'Muitas tentativas. Aguarde ' +
          Math.ceil((recIdent.blockedUntil - Date.now()) / 60000) + ' min.' });
      }
    }

    /* segunda camada: métodos autenticados exigem token válido */
    if (_authRequired.has(metodo)) {
      const tk = req.headers['x-cc-token'] || null;
      if (!tk) {
        return json(res, 401, { ok: false, error: 'Sessão expirada. Faça login novamente.' });
      }
      global.__CC_REQUEST_TOKEN = tk;
      global.__CC_HTTP = true;
      try {
        const u = Auth.usuarioAtual();
        if (!u) {
          return json(res, 401, { ok: false, error: 'Sessão expirada. Faça login novamente.' });
        }
      } catch (e) {
        return json(res, 401, { ok: false, error: 'Sessão expirada. Faça login novamente.' });
      } finally {
        delete global.__CC_REQUEST_TOKEN;
        delete global.__CC_HTTP;
      }
    }

    global.__CC_REQUEST_TOKEN = req.headers['x-cc-token'] || null;
    global.__CC_HTTP = true;
    const ip = ipDoRequest(req);
    const ts = new Date().toISOString();
    // [SEGURANÇA] Nunca logar tokens, e-mails, telefones ou payloads de request

    /* brute-force guard para verifyCode */
    if (metodo === 'verifyCode') {
      const rec = _failedAuth.get(ip);
      if (rec && Date.now() < rec.blockedUntil) {
        const retryAfter = Math.ceil((rec.blockedUntil - Date.now()) / 1000);
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
        return res.end(JSON.stringify({ ok: false, status: 429, error: 'Muitas tentativas. Aguarde ' + retryAfter + 's.' }));
      }
    }

    try {
      const dados = fn.apply(null, argList);
      /* função assíncrona: resolve a resposta fora daqui — sem isso,
         uma Promise rejeitada seria serializada como {} com status 200 */
      if (dados && typeof dados.then === 'function') {
        return void dados
          .then(
            valor => {
              if (metodo === 'verifyCode') _failedAuth.delete(ip);
              json(res, 200, { ok: true, data: valor === undefined ? null : valor });
            },
            e => {
              const st = (e && e.status) || 500;
              if (metodo === 'verifyCode' && st >= 400 && st < 500) {
                const prev = _failedAuth.get(ip) || { count: 0, blockedUntil: 0 };
                prev.count++;
                if (prev.count >= AUTH_FAIL_MAX) {
                  prev.blockedUntil = Date.now() + AUTH_BLOCK_MS;
                }
                prev.windowStart = prev.windowStart || Date.now();
                if (Date.now() - prev.windowStart > AUTH_FAIL_WINDOW_MS) {
                  prev.count = 1;
                  prev.windowStart = Date.now();
                  prev.blockedUntil = 0;
                }
                _failedAuth.set(ip, prev);
                // [SEGURANÇA] Incrementa tbm por identidade (e-mail/CPF)
                if (ident && metodo === 'verifyCode') {
                  const identKey = 'ident:' + String(ident).toLowerCase().trim();
                  const recIdent = _failedAuthByIdent.get(identKey) || { count: 0, blockedUntil: 0 };
                  recIdent.count++;
                  if (recIdent.count >= AUTH_FAIL_MAX_IDENT) {
                    recIdent.blockedUntil = Date.now() + AUTH_BLOCK_MS_IDENT;
                  }
                  _failedAuthByIdent.set(identKey, recIdent);
                }
              }
              // [SEGURANÇA] Nunca logar tokens, e-mails, telefones ou payloads de request
              if (st >= 500) console.error('[rpc][ERR]', ts, 'method=' + metodo, 'ip=' + ip, 'status=' + st, 'args=[REDACTED]', e);
              json(res, st, Object.assign({ ok: false, status: st, error: (e && e.error) || 'Erro interno.' },
                (e && e.code) ? { code: e.code } : null));
            })
          .finally(() => {
            /* limpa o contexto HTTP somente depois de a Promise resolver —
               funções async chamam Auth.usuarioAtual() internamente. */
            delete global.__CC_REQUEST_TOKEN;
            delete global.__CC_HTTP;
          });
      }
      if (metodo === 'verifyCode') _failedAuth.delete(ip);
      const saida = json(res, 200, { ok: true, data: dados === undefined ? null : dados });
      delete global.__CC_REQUEST_TOKEN;
      delete global.__CC_HTTP;
      return saida;
    } catch (e) {
      const status = (e && e.status) || 500;
      if (metodo === 'verifyCode' && status >= 400 && status < 500) {
        const prev = _failedAuth.get(ip) || { count: 0, blockedUntil: 0 };
        prev.count++;
        if (prev.count >= AUTH_FAIL_MAX) {
          prev.blockedUntil = Date.now() + AUTH_BLOCK_MS;
        }
        prev.windowStart = prev.windowStart || Date.now();
        if (Date.now() - prev.windowStart > AUTH_FAIL_WINDOW_MS) {
          prev.count = 1;
          prev.windowStart = Date.now();
          prev.blockedUntil = 0;
        }
        _failedAuth.set(ip, prev);
        // [SEGURANÇA] Incrementa tambem por identidade (e-mail/CPF)
        if (ident && metodo === 'verifyCode') {
          const identKey = 'ident:' + String(ident).toLowerCase().trim();
          const recIdent = _failedAuthByIdent.get(identKey) || { count: 0, blockedUntil: 0 };
          recIdent.count++;
          if (recIdent.count >= AUTH_FAIL_MAX_IDENT) {
            recIdent.blockedUntil = Date.now() + AUTH_BLOCK_MS_IDENT;
          }
          _failedAuthByIdent.set(identKey, recIdent);
        }
      }
      // [SEGURANÇA] Nunca logar tokens, e-mails, telefones ou payloads de request
      if (status >= 500) console.error('[rpc][ERR]', ts, 'method=' + metodo, 'ip=' + ip, 'status=' + status, 'args=[REDACTED]', e);
      const saida = json(res, status, Object.assign({ ok: false, status, error: (e && e.error) || 'Erro interno.' },
        (e && e.code) ? { code: e.code } : null));
      delete global.__CC_REQUEST_TOKEN;
      delete global.__CC_HTTP;
      return saida;
    }
  });
}

/* ---------------- super-admin routes ---------------- */

function handleSuperAdmin(req, res, pathname, url) {
  const sub = pathname.replace('/api/super-admin/', '');
  const parts = sub.split('/').filter(Boolean);
  const rota = parts[0] || '';
  const idParam = parts[1] || null;

  const authHeader = req.headers['authorization'] || req.headers['x-super-admin-token'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();

  function readBody() {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
      req.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); }
        catch (e) { reject(new Error('JSON inválido.')); }
      });
    });
  }

  function needAuth() {
    if (!token) { json(res, 401, { ok: false, error: 'Token ausente.' }); return false; }
    try { API.superAdminAuth(token); }
    catch (e) { json(res, 401, { ok: false, error: (e && e.error) || 'Não autorizado.' }); return false; }
    return true;
  }

  /* POST /api/super-admin/login — sem auth */
  if (rota === 'login' && req.method === 'POST') {
    return readBody().then(dados => {
      const r = API.superAdminLogin(dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, (e && e.status) || 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* rotas autenticadas abaixo */
  if (!needAuth()) return;

  /* POST /api/super-admin/logout */
  if (rota === 'logout' && req.method === 'POST') {
    try { const r = API.superAdminLogout(token); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/dashboard */
  if (rota === 'dashboard' && req.method === 'GET') {
    try { const r = API.saDashboard(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/relatorios */
  if (rota === 'relatorios' && req.method === 'GET') {
    try { const r = API.saRelatorios(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/config — configurações globais da plataforma */
  if (rota === 'config' && !idParam && req.method === 'GET') {
    try { const r = API.saObterConfig(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/config — liga/desliga modo grátis do site e trial */
  if (rota === 'config' && !idParam && req.method === 'PUT') {
    return readBody().then(dados => {
      if (typeof dados.site_gratis !== 'undefined') API.saDefinirSiteGratis(dados.site_gratis);
      if (typeof dados.trial_10dias !== 'undefined') API.saDefinirTrial(dados.trial_10dias);
      const r = API.saObterConfig();
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* GET /api/super-admin/planos — planos e preços */
  if (rota === 'planos' && !idParam && req.method === 'GET') {
    try { const r = API.saListarPlanos(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/plano/:id/precos — atualiza preços do plano */
  if (rota === 'plano' && idParam && parts[2] === 'precos' && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = API.saAtualizarPrecosPlano(idParam, dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* POST /api/super-admin/planos — cria plano (CRUD de planos) */
  if (rota === 'planos' && !idParam && req.method === 'POST') {
    return readBody().then(dados => {
      const r = API.saCriarPlano(dados);
      json(res, 201, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* PUT /api/super-admin/plano/:id — edita dados do plano (CRUD) */
  if (rota === 'plano' && idParam && parts[2] === undefined && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = API.saEditarPlano(idParam, dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* DELETE /api/super-admin/plano/:id — exclui plano (se não estiver em uso) */
  if (rota === 'plano' && idParam && parts[2] === undefined && req.method === 'DELETE') {
    try { const r = API.saExcluirPlano(idParam); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, (e && e.status) || 409, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/lojas */
  if (rota === 'lojas' && req.method === 'GET' && !idParam) {
    try { const r = API.saListarLojas(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/usuarios */
  if (rota === 'usuarios' && req.method === 'GET') {
    try { const r = API.saListarUsuarios(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/loja/:id */
  if (rota === 'loja' && idParam && parts[2] === undefined && req.method === 'GET') {
    try { const r = API.saDetalheLoja(idParam); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/loja/:id/plan */
  if (rota === 'loja' && idParam && parts[2] === 'plan' && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = API.saAtualizarPlano(idParam, dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* DELETE /api/super-admin/loja/:id */
  if (rota === 'loja' && idParam && parts[2] === undefined && req.method === 'DELETE') {
    try { const r = API.saExcluirLoja(idParam); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/tickets?status=... */
  if (rota === 'tickets' && req.method === 'GET') {
    try {
      var qs = new URL(url, 'http://localhost').searchParams;
      var r = API.saTickets({ status: qs.get('status') || 'todos' });
      json(res, 200, { ok: true, data: r });
    } catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/ticket/:id — responde/atualiza status */
  if (rota === 'ticket' && idParam && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = API.saResponderTicket(idParam, dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* GET /api/super-admin/reembolsos?status=EM_ANALISE|REEMBOLSADO|todos
     PENDENTE_GMAIL nunca aparece aqui: o filtro de status o mantém
     oculto enquanto o barbeiro não confirma o envio do e-mail. */
  if (rota === 'reembolsos' && !idParam && req.method === 'GET') {
    try {
      var qsReb = new URL(url, 'http://localhost').searchParams;
      var rReb = API.saListarReembolsos({ status: qsReb.get('status') || 'todos' });
      json(res, 200, { ok: true, data: rReb });
    } catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/reembolso/:id — marca como realizado e dispara
     a notificação de sucesso para o barbeiro */
  if (rota === 'reembolso' && idParam && parts[2] === undefined && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = API.saMarcarReembolsoRealizado(idParam, dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, (e && e.status) || 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* DELETE /api/super-admin/reembolso/:id — soft delete de VISUALIZAÇÃO.
     Despite o verbo HTTP, a linha NÃO é removida: a API só grava
     visible_to_admin = false (trilha de auditoria preservada). */
  if (rota === 'reembolso' && idParam && parts[2] === undefined && req.method === 'DELETE') {
    try { const r = API.saOcultarReembolso(idParam); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, (e && e.status) || 404, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/denuncias?status=...&tipo=... */
  if (rota === 'denuncias' && req.method === 'GET') {
    try {
      var qs = new URL(url, 'http://localhost').searchParams;
      var r = API.saListarDenuncias({
        status: qs.get('status') || 'todos',
        tipo: qs.get('tipo') || 'todos'
      });
      json(res, 200, { ok: true, data: r });
    } catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/denuncia/:id — atualiza status/nota */
  if (rota === 'denuncia' && idParam && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = API.saResolverDenuncia(idParam, dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* ---------------- bot atendente + chats (super-admin) ---------------- */

  /* GET /api/super-admin/bot — config atual */
  if (rota === 'bot' && !idParam && req.method === 'GET') {
    try { const r = Bot.saBotConfig(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* PUT /api/super-admin/bot — salva config */
  if (rota === 'bot' && !idParam && req.method === 'PUT') {
    return readBody().then(dados => {
      const r = Bot.saBotSalvar(dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* POST /api/super-admin/bot/verificar — testa a config (sem salvar) */
  if (rota === 'bot' && idParam === 'verificar' && req.method === 'POST') {
    return readBody().then(dados => {
      const r = Bot.saBotVerificar(dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* POST /api/super-admin/bot/testar — dispara processamento manual */
  if (rota === 'bot' && idParam === 'testar' && req.method === 'POST') {
    return readBody().then(dados => {
      const r = Bot.saBotTestar(dados);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* GET /api/super-admin/bot/historico */
  if (rota === 'bot' && idParam === 'historico' && req.method === 'GET') {
    try {
      const r = Bot.saBotHistorico();
      json(res, 200, { ok: true, data: r });
    } catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* DELETE /api/super-admin/bot/historico */
  if (rota === 'bot' && idParam === 'historico' && req.method === 'DELETE') {
    try { const r = Bot.saBotLimparHistorico(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/chats */
  if (rota === 'chats' && !idParam && req.method === 'GET') {
    try { const r = Bot.saChatsListar(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* POST /api/super-admin/chats/:id/responder */
  if (rota === 'chats' && idParam && parts[2] === 'responder' && req.method === 'POST') {
    return readBody().then(dados => {
      const r = Bot.saChatsResponder(idParam, dados.texto);
      json(res, 200, { ok: true, data: r });
    }).catch(e => json(res, 400, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }));
  }

  /* GET /api/super-admin/situacao */
  if (rota === 'situacao' && !idParam && req.method === 'GET') {
    try { const r = API.saSituacao(); json(res, 200, { ok: true, data: r }); }
    catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  /* GET /api/super-admin/logs?tipo=erro&horas=24 */
  if (rota === 'logs' && !idParam && req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const tipo = url.searchParams.get('tipo') || 'erro';
      const horas = parseInt(url.searchParams.get('horas') || '24', 10);
      const r = API.saLogs(tipo, horas);
      json(res, 200, { ok: true, data: r });
    } catch (e) { json(res, 500, { ok: false, error: (e && (e.error || e.message)) || 'Erro.' }); }
    return;
  }

  json(res, 404, { ok: false, error: 'Rota super-admin não encontrada.' });
}

/* ---------------- webhook AbacatePay ---------------- */

/* Chave do HMAC. O nome antigo era ABACATEPAY_PUBLIC_KEY, mas uma chave
   PÚBLICA não pode ser segredo de HMAC: se ela estiver publicada (painel,
   log, resposta de API), qualquer um forja a assinatura. Aceitamos a
   variável antiga por compatibilidade, mas a nova é a correta. */
function chaveHmacWebhook() {
  return String(process.env.ABACATEPAY_WEBHOOK_HMAC_SECRET || '').trim() ||
         String(process.env.ABACATEPAY_WEBHOOK_SECRET || '').trim();
}

/* Assinatura HMAC-SHA256 (base64) no header x-webhook-signature */
function assinaturaValida(corpo, recebida) {
  try {
    const chave = chaveHmacWebhook();
    if (!chave || !recebida) return false;
    const esperada = crypto.createHmac('sha256', chave)
      .update(Buffer.from(corpo, 'utf8')).digest('base64');
    const a = Buffer.from(esperada);
    const b = Buffer.from(String(recebida));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) { return false; }
}

/* Anti-replay: o evento precisa recair numa janela curta de tempo. Sem
   isso, um payload capturado em trânsito pode ser reenviado à vontade. */
const WEBHOOK_TOLERANCIA_MS = 5 * 60 * 1000;
function timestampEventoValido(ev) {
  try {
    const dados = (ev && ev.data) || {};
    const cand = [dados.timestamp, dados.date, ev.timestamp, ev.date];
    for (const t of cand) {
      if (t === undefined || t === null || t === '') continue;
      const ms = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : Date.parse(t);
      if (Number.isFinite(ms)) return Math.abs(Date.now() - ms) <= WEBHOOK_TOLERANCIA_MS;
    }
    /* Sem timestamp não dá para detectar replay — recusa (fail-closed). */
    return false;
  } catch (e) { return false; }
}

function handleWebhookAbacate(req, res, url) {
  let corpo = '';
  let estourou = false;
  req.on('data', c => {
    corpo += c;
    if (corpo.length > 256 * 1024) { estourou = true; req.destroy(); }
  });
  req.on('error', () => { /* cliente abortou */ });
  req.on('end', () => {
    if (estourou) return;
    /* [SEGURANÇA] FAIL-CLOSED. Antes a validação inteira vivia dentro de
       `if (secretEnv)`: sem a variável configurada, NENHUMA checagem
       acontecia e qualquer POST anônimo chegava a processarEventoWebhook,
       que ativa o plano pago. Sem segredo configurado => 503 sempre. */
    const secretEnv = chaveHmacWebhook();
    if (!secretEnv) {
      console.error('[webhook] ABACATEPAY_WEBHOOK_HMAC_SECRET/ABACATEPAY_WEBHOOK_SECRET não configurado — webhook rejeitado (fail-closed).');
      return json(res, 503, { ok: false, error: 'Webhook não configurado.' });
    }
    var urlOk = false;
    var hmacOk = false;
    {
      const secretUrl = url.searchParams.get('webhookSecret') || '';
      if (secretUrl) {
        /* [SEGURANÇA] Segredo em query string vaza em log de proxy, Referer
           e histórico. Mantido por compatibilidade, mas avisado. */
        console.warn('[webhook] autenticação por ?webhookSecret= está depreciada — migre para o header x-webhook-signature.');
        const a = Buffer.from(secretEnv, 'utf8');
        const b = Buffer.from(secretUrl, 'utf8');
        urlOk = a.length === b.length && crypto.timingSafeEqual(a, b);
      }
      if (!urlOk) {
        hmacOk = assinaturaValida(corpo, req.headers['x-webhook-signature']);
      }
      if (!urlOk && !hmacOk) {
        return json(res, 401, { ok: false, error: 'Unauthorized' });
      }
    }
    let ev;
    try { ev = JSON.parse(corpo || '{}'); }
    catch (e) { return json(res, 400, { ok: false, error: 'JSON inválido.' }); }
    /* Anti-replay: rejeita evento com timestamp ausente ou fora da janela.
       Uma assinatura válida de um payload antigo não pode reativar plano. */
    if (!timestampEventoValido(ev)) {
      console.warn('[webhook] evento sem timestamp válido — rejeitado (anti-replay).');
      return json(res, 400, { ok: false, error: 'Evento expirado ou sem timestamp.' });
    }
    try {
      const r = API.processarEventoWebhook(ev);
      // [SEGURANÇA] Não logar dados do evento (podem conter PII)
      console.log('[webhook] event=' + (ev.event || '?') + ' ok=' + !r.ignored);
      return json(res, 200, { ok: true, data: r });
    } catch (e) {
      console.error('[webhook]', e);
      /* 500 faz a AbacatePay retentar — o processamento é idempotente */
      return json(res, 500, { ok: false, error: 'Falha ao processar evento.' });
    }
  });
}

/* ---------------- estáticos ---------------- */

function servirEstatico(req, res, url) {
  let caminho = decodeURIComponent(url.pathname);
  const MAPA_LIMPO = {
    '/catalogo': '/public/catalogo.html',
    '/salao': '/public/salao-publico.html',
    '/perfil': '/public/perfil.html',
    '/login': '/admin/login.html',
    '/privacidade': '/public/privacidade.html',
    '/termos': '/public/termos.html',
    '/lgpd': '/public/lgpd.html',
    '/painel': '/admin/index.html',
    '/agendamentos': '/admin/agendamentos.html',
    '/clientes': '/admin/clientes.html',
    '/servicos': '/admin/servicos.html',
    '/profissionais': '/admin/profissionais.html',
    '/horarios': '/admin/horarios.html',
    '/funcionarios': '/admin/funcionarios.html',
    '/relatorios': '/admin/relatorios.html',
    '/assinatura': '/admin/assinatura.html',
    '/configuracoes': '/admin/configuracoes.html',
    '/suporte': '/admin/suporte.html',
    '/relatorios-unica': '/admin/relatorios-unica.html'
  };
  if (caminho === '/' || caminho === '/index.html') {
    caminho = '/public/telainicial.html';
  } else if (MAPA_LIMPO[caminho]) {
    caminho = MAPA_LIMPO[caminho];
  } else if (caminho.startsWith('/') && caminho.endsWith('.html')) {
    const naRaiz = path.join(RAIZ, caminho);
    const noPublic = path.join(RAIZ, 'public' + caminho);
    if (!fs.existsSync(naRaiz) && fs.existsSync(noPublic)) {
      caminho = '/public' + caminho;
    }
  }

  const alvo = path.normalize(path.join(RAIZ, caminho));
  if (!alvo.startsWith(RAIZ)) {
    res.writeHead(403);
    return res.end('Proibido');
  }

  let arquivo = alvo;
  try {
    if (fs.statSync(alvo).isDirectory()) {
      const index = path.join(alvo, 'index.html');
      /* Pasta sem index (ex.: /public/, gerado por link relativo em página
         com <base href="/public/">) vai para a tela inicial em vez de
         responder um 404 cru no meio do site. */
      if (!fs.existsSync(index)) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        return res.end();
      }
      arquivo = index;
    }
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404 — não encontrado: ' + caminho);
  }

  fs.readFile(arquivo, (err, dados) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 — não encontrado: ' + caminho);
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(arquivo).toLowerCase()] || 'application/octet-stream',
      'Content-Length': dados.length,
      'Cache-Control': 'no-store'
    });
    res.end(req.method === 'HEAD' ? undefined : dados);
  });
}

/* ---------------- servidor ---------------- */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  /* Durante o boot o servidor JÁ escuta (Hostinger exige listen() rápido).
     Antes de pronto: responde 503 "inicializando". Se o boot falhou,
     responde com o MOTIVO no corpo (a app fica viva só para diagnóstico;
     em produção ela nunca serve a aplicação nesse estado). */
  if (global.__CC_BOOT_ERROR) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('Corte Comigo — erro de inicialização:\n\n' +
      String(global.__CC_BOOT_ERROR) + '\n\nDetalhes em boot-error.log na raiz do app.');
  }
  if (!global.__CC_BOOT_READY) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end('Corte Comigo inicializando... recarregue em instantes.');
  }

  if (req.method === 'GET' && pathname === '/health') {
    return void (async () => {
      let ok = false;
      try {
        const { knex } = require('./backend/pool');
        const r = await knex.raw('SELECT 1 AS ok');
        ok = !!(r && r.rows && r.rows[0] && r.rows[0].ok === 1);
      } catch (e) { ok = false; }
      /* resposta mínima — sem versão/stack/nome de servidor */
      json(res, ok ? 200 : 503, { ok });
    })();
  }
  /* Identifica qual build esta no ar — a tela de login mostra isso para
     confirmar, em 1 segundo, se o redeploy realmente subiu o código novo.
     Ordem: VERSAO_BUILD (hosting nem sempre publica o .git) -> .git/HEAD
     -> data do deploy (mtime de server.js). */
  if (req.method === 'GET' && pathname === '/api/versao') {
    return json(res, 200, VERSAO_BUILD, { 'Cache-Control': 'no-store' });
  }

  /* magic-link */
  if (req.method === 'GET' && url.pathname === '/magic-link') {
    const tk = url.searchParams.get('token');
    if (!tk) { res.writeHead(400, headersPadrao({ 'Content-Type': 'text/plain; charset=utf-8' })); return res.end('Token ausente.'); }
    const html = '<!DOCTYPE html>\n<html lang="pt-BR">\n<head><meta charset="UTF-8"><meta http-equiv="refresh" content="0;url=../admin/">\n<title>Entrando...</title></head>\n<body><p>Entrando no Corte Comigo...</p><script src="../shared/js/magic-link.js"></script></body></html>';
    res.writeHead(200, headersPadrao({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), 'Cache-Control': 'no-store' }));
    return res.end(html);
  }
  /* super-admin routes */
  if (pathname.indexOf('/api/super-admin/') === 0) {
    return void handleSuperAdmin(req, res, pathname, url);
  }
  if (req.method === 'POST' && pathname === '/api/rpc') return handleRpc(req, res);
  if (req.method === 'POST' && pathname === '/webhooks/abacatepay') {
    return handleWebhookAbacate(req, res, url);
  }
  if (req.method === 'GET' || req.method === 'HEAD') return servirEstatico(req, res, url);
  res.writeHead(405);
  res.end('Método não permitido');
});

/* Inicializa a persistência (PostgreSQL) antes de atender requisições */
const boot = require('./backend/boot');

/* Se o PostgreSQL local (portátil em .pg/) não estiver na porta 5432,
   inicia-o automaticamente — assim `npm run dev` funciona sem setup. */
const net = require('net');
const child_process = require('child_process');

function portaAberta(porta, ms) {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: porta });
    s.setTimeout(ms || 1200);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

function iniciarPostgresLocal() {
  const pgCtl = path.join(__dirname, '.pg', 'pgsql', 'bin', 'pg_ctl.exe');
  const dataDir = path.join(__dirname, '.pg', 'data');
  const logFile = path.join(__dirname, '.pg', 'pg.log');
  if (!fs.existsSync(pgCtl) || !fs.existsSync(dataDir)) return Promise.resolve(false);
  console.log('  [postgres] porta 5432 fechada — iniciando banco local (.pg)...');
  return new Promise(resolve => {
    child_process.execFile(pgCtl, ['-D', dataDir, '-l', logFile, 'start'], { timeout: 30000 }, err => {
      if (err) {
        console.log('  [postgres] já estava em execução ou houve erro: ' + (err.message || err));
        return resolve(true);
      }
      resolve(true);
    });
  });
}

/* Banco é remoto (Render/Neon etc.) quando DATABASE_URL existe e aponta
   para um host diferente de localhost. Nesse caso NÃO checamos a porta
   local 5432 — a conexão é do pool e o boot decide por ela. */
function bancoRemoto() {
  const url = process.env.DATABASE_URL || '';
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return !(h === '127.0.0.1' || h === 'localhost' || h === '::1');
  } catch (e) {
    return false;
  }
}

(async function iniciar() {
  /* LISTEN IMEDIATO: a Hostinger mata o processo se listen() não vier em
     ~3 segundos. O boot (migrações + carga do banco) demora mais que isso,
     então escutamos já, com o handler respondendo "inicializando..." e o
     suporte a responder a APP só depois de `__CC_BOOT_READY=true`. */
  server.listen(PORTA, () => {
    console.log('  [boot] servidor escutando na porta ' + PORTA + ' (aguardando boot...)');
  });

  if (!bancoRemoto()) {
    let bancoOk = await portaAberta(5432);
    /* Só auto-inicia o PostgreSQL portátil (.pg/) quando ele EXISTE no
       diretório — ou seja, ambiente local de desenvolvimento. Em servidor
       (ex.: Hostinger) ".pg" não existe: nenhum PG local deve ser tentado,
       o banco obrigatoriamente vem de DATABASE_URL. */
    const temPgPortatil = fs.existsSync(path.join(__dirname, '.pg', 'pgsql', 'bin', 'pg_ctl.exe'));
    if (!bancoOk && temPgPortatil) {
      await iniciarPostgresLocal();
      for (let i = 0; i < 24 && !bancoOk; i++) {
        await new Promise(r => setTimeout(r, 500));
        bancoOk = await portaAberta(5432);
      }
    }
    if (!bancoOk) {
      const urlInfo = process.env.DATABASE_URL
        ? 'DATABASE_URL está definida mas o host "' + (function () { try { return String(new URL(process.env.DATABASE_URL).host); } catch (e) { return '<URL inválida>'; } })() + '" não respondeu na porta 5432.'
        : 'DATABASE_URL NÃO está definida no servidor.';
      console.error('[boot] PostgreSQL inacessível. ' + urlInfo);
      console.error('[boot] No servidor, configure DATABASE_URL apontando para um PostgreSQL acessível (ex.: servidor do próprio plano, Supabase ou Neon).');
      escreverBootErro('PostgreSQL inacessível no servidor.', urlInfo);
      global.__CC_BOOT_ERROR = 'PostgreSQL inacessível. ' + urlInfo;
      return; /* mantém o processo vivo só para devolver o erro via HTTP */
    }
  }

  /* Auto-migração: aplica migrações pendentes ANTES de carregar o schema.
     Só roda quando MIGRATION_DATABASE_URL está configurada (role privilegiada,
     necessária para criar tipos/roles/RLS); desligue com AUTO_MIGRATE=0.
     Sem isso, tabelas novas (ex.: reports) faltam e o boot morre em
     "relation ... does not exist". Mantém o deploy em dia sem passo manual. */
  if (process.env.MIGRATION_DATABASE_URL && process.env.AUTO_MIGRATE !== '0') {
    /* Guard: o deploy é remoto mas MIGRATION_DATABASE_URL aponta para o host
       local (127.0.0.1/localhost) — erro clássico de copiar o .env.example.
       Em vez de um ECONNREFUSED sem contexto, orientamos sobre como corrigir. */
    if (bancoRemoto()) {
      let migHost = null;
      try { migHost = new URL(process.env.MIGRATION_DATABASE_URL).hostname; } catch (e) { /* não é uma URL */ }
      if (migHost === '127.0.0.1' || migHost === 'localhost' || migHost === '::1') {
        console.error('[migrate] MIGRATION_DATABASE_URL aponta para "' + migHost +
          ':5432", mas o banco do app é remoto (Render/Neon).');
        console.error('[migrate] Configure MIGRATION_DATABASE_URL com a "Internal Database URL" do Postgres');
        console.error('[migrate] no painel do Render (mesmo host e usuário dono do DATABASE_URL de produção).');
        escreverBootErro('MIGRATION_DATABASE_URL aponta para localhost mas o banco do app é remoto.',
          'Use a URL do PostgreSQL remoto (mesmo host do DATABASE_URL) na MIGRATION_DATABASE_URL.');
        process.exit(1);
      }
    }
    try {
      const knexFactory = require('knex');
      const cfg = require('./knexfile').production;
      const dbMig = knexFactory({
        client: cfg.client,
        connection: cfg.connection,
        migrations: cfg.migrations,
        pool: { min: 0, max: 1 }
      });
      const res = await dbMig.migrate.latest();
      const lote = Array.isArray(res) ? res[0] : res;
      const aplicadas = Array.isArray(res) && Array.isArray(res[1]) ? res[1] : [];
      console.log('[migrate] schema OK (lote ' + lote +
        (aplicadas.length ? ', ' + aplicadas.length + ' migração(ões) aplicada(s)' : ', nada pendente') + ').');
      await dbMig.destroy();
    } catch (e) {
      console.error('[migrate] falha ao aplicar migrações:', (e && (e.message || e)) || e);
      escreverBootErro('Falha ao aplicar as migrações no PostgreSQL:',
        (e && e.stack) || (e && (e.message || e)) || e);
      global.__CC_BOOT_ERROR = 'Falha ao aplicar as migrações: ' + ((e && (e.message || e)) || e);
      return;
    }
  }

  try {
    await comTimeout(boot.init(), 240000,
      '[boot] boot.init excedeu 240s (conexao com o banco travou?)');
  } catch (e) {
    console.error('[boot] Falha ao carregar o banco de dados:', e);
    escreverBootErro('Falha ao carregar o banco de dados (boot.init):', (e && e.stack) || (e && (e.message || e)) || e);
    global.__CC_BOOT_ERROR = 'Falha ao carregar o banco de dados: ' + ((e && ((e.message || e))) || e);
    return;
  }

  /* A partir daqui a aplicação JÁ responde — jobs e bot rodam em
     paralelo e NUNCA podem segurar o boot. (Antes, Bot.start() vinha
     antes do flag; se ele travasse, ficava "inicializando..." para sempre.) */
  global.__CC_BOOT_READY = true;
  try { fs.writeFileSync(path.join(__dirname, 'boot-error.log'), ''); } catch (e) { /* opcional */ }

  /* Vigia: se algo segurar o boot, registra para diagnóstico em boot-error.log */
  setInterval(() => {
    if (global.__CC_BOOT_READY || global.__CC_BOOT_ERROR) return;
    try { fs.appendFileSync(path.join(__dirname, 'boot-error.log'),
      '[' + new Date().toISOString() + '] boot ainda nao pronto...\n', 'utf8'); } catch (e) { /* opcional */ }
  }, 30000);

  /* Job diário dos relatórios: padrão de TODOS os planos pagos.
     Ao virar o dia (00:00) grava o snapshot de faturamento por loja;
     no boot de um dia novo também cobre o dia anterior (catch-up).
     Roda a cada 10 min (não a cada 60s) — o cálculo já é O(agendamentos)
     em passada única; frequência maior não muda o dado, só o snapshot
     do dia corrente, e sobrecarrega o event loop à toa. */
  {
    async function garantirRelatoriosDiarios() {
      try {
        const hoje = global.DB.hojeISO();
        const internos = global.__CC_INTERNAL || {};
        if (typeof internos.gerarDiariosParaData === 'function') {
          internos.gerarDiariosParaData(hoje);
          console.log('[relatorios] snapshot diário atualizado (' + hoje + ')');
        }
      } catch (e) {
        console.error('[relatorios][job]', e);
      }
    }
    garantirRelatoriosDiarios();
    setInterval(garantirRelatoriosDiarios, 10 * 60 * 1000);
  }

  /* Job de lembretes por e-mail (Gmail): envia 1 dia antes e no dia do
     agendamento. As marcas persistidas (lembrete_email_em /
     lembrete_dia_email_em) evitam reenvio; roda no boot e a cada 30
     minutos, sem depender de o dono abrir o painel. */
  {
    async function enviarLembretesAmanha() {
      try {
        const internos = global.__CC_INTERNAL || {};
        if (typeof internos.gerarLembretesAmanha === 'function') {
          const r = internos.gerarLembretesAmanha();
          if (r && r.enviados) console.log('[lembretes] e-mails de lembrete enviados: ' + r.enviados);
        }
      } catch (e) {
        console.error('[lembretes][job]', e);
      }
    }
    enviarLembretesAmanha();
    setInterval(enviarLembretesAmanha, 30 * 60 * 1000);
  }

  /* Job de assinatura: ao terminar os 10 dias grátis de uma loja, marca a
     assinatura como expirada e avisa o dono para escolher o plano que deseja
     renovar (a cobrança é gerada quando ele escolhe). Roda no boot e a cada
     30 minutos. */
  {
    async function vencerTrialsExpirados() {
      try {
        const internos = global.__CC_INTERNAL || {};
        if (typeof internos.vencerTrialsExpirados === 'function') {
          const r = await internos.vencerTrialsExpirados();
          if (r && r.vencidos) console.log('[assinatura] trials vencidos processados: ' + r.vencidos);
        }
      } catch (e) {
        console.error('[assinatura][job]', e);
      }
    }
    vencerTrialsExpirados();
    setInterval(vencerTrialsExpirados, 30 * 60 * 1000);
  }

  try { Promise.resolve(Bot.start()).catch(e => console.error('[boot][bot]', (e && (e.message || e)) || e)); }
  catch (e) { console.error('[boot][bot]', (e && (e.message || e)) || e); }
  console.log('');
  console.log('  Corte Comigo rodando:');
  console.log('  Catálogo público : http://localhost:' + PORTA + '/public/catalogo.html');
  console.log('  Painel admin     : http://localhost:' + PORTA + '/admin/login.html');
  console.log('  Banco de dados   : PostgreSQL (cortecerto)');
  console.log('  Códigos de acesso são enviados por e-mail (Gmail), com código demo no terminal e na tela de login.');
  if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
    // [SEGURANÇA] Mascarar e-mail no log de boot
    console.log('  E-mail (código)  : Gmail real (' + mascararEmail(process.env.GMAIL_USER) + ')');
  } else {
    console.log('  E-mail (código)  : MODO DEMO — configure GMAIL_USER/GMAIL_PASS no painel do Render para o código chegar no e-mail.');
  }
  console.log(process.env.ABACATEPAY_API_KEY
    ? '  Pagamentos PIX   : AbacatePay (' +
      (/^abc_/.test(process.env.ABACATEPAY_API_KEY) ? 'dev mode' : 'chave configurada') + ')'
    : '  Pagamentos PIX   : MODO SIMULADO — configure ABACATEPAY_API_KEY no .env');
  if (process.env.GEMINI_API_KEY) {
    console.log('  Atendente bot    : IA Gemini ativa (' + (process.env.GEMINI_MODEL || 'gemini-2.0-flash') + ')');
  } else {
    console.log('  Atendente bot    : classificação por palavras-chave — coloque GEMINI_API_KEY no .env para usar a IA Gemini');
  }
  console.log('');
})();
