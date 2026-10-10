'use strict';
/* ============================================================
   Corte Comigo – teste de integração da RECUPERAÇÃO DE SENHA.

   Cobre o novo fluxo: recuperar acesso por código de e-mail e, no
   mesmo passo, definir a nova senha (Auth.redefinirSenhaComCodigo).

     · código errado => 400 e senha NÃO muda
     · senha fraca / confirmação diferente => 400
     · código certo => grava a senha, invalida sessões antigas e loga
     · o código é de uso único (não reaproveita)
     · depois, login e-mail + senha nova funciona e a antiga falha
     · persistência no PostgreSQL (users.password_hash / sms_codes)

   Boota o backend real e remove TUDO que criou no final.

   Uso:  node scripts/testar-recuperacao-senha.js
   ============================================================ */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const crypto = require('crypto');
const boot = require('../backend/boot');
const pg = require('../backend/pool');

let passou = 0, falhou = 0;
function ok(nome, cond, extra) {
  if (cond) { passou++; console.log('  PASS  ' + nome); }
  else { falhou++; console.log('  FAIL  ' + nome + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); }
}
function secao(t) { console.log('\n=== ' + t + ' ==='); }
function esperaErro(fn) { try { fn(); return null; } catch (e) { return e; } }

const EMAIL = 'rec-teste-' + Date.now() + '@cortecomigo.test';
const SENHA_ANTIGA = 'SenhaAntiga1@';
const SENHA_NOVA = 'SenhaNova1@';
const CODIGO = '123456';

(async function run() {
  await boot.init();
  const { Auth, DB } = boot;
  const db = DB._d();

  /* ---------- fixture: usuário cliente com senha antiga + sessão ativa ---------- */
  const user = {
    id: crypto.randomUUID(),
    role: 'cliente',
    name: 'Usuário Teste Recuperação',
    email: EMAIL,
    phone: '',
    verified: 1,
    password_hash: Auth.hashSenha(SENHA_ANTIGA),
    barbershop_id: null,
    prefs: { notif_email: 'sim', notif_sms: 'não', lembrete: '30' },
    consentimentos: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  db.users.push(user);

  /* sessão antiga (deve ser derrubada após a redefinição) */
  const sessaoAntiga = {
    id: DB.proximoId(), user_id: user.id, token: 'teste-rec-' + crypto.randomBytes(6).toString('hex'),
    expires_at: new Date(Date.now() + 3600e3).toISOString()
  };
  db.sessions.push(sessaoAntiga);

  /* código de recuperação ativo (equivale ao enviado por e-mail) */
  db.sms_codes = db.sms_codes.filter(c => c.ident !== EMAIL);
  db.sms_codes.push({
    id: DB.proximoId(), ident: EMAIL, phone: '', code: CODIGO,
    expires_at: Date.now() + 10 * 60 * 1000, attempts: 0, used: 0,
    next_allowed_at: 0, payload: { modo: 'recuperacao' }, created_at: new Date().toISOString()
  });

  console.log('E-mail de teste: ' + EMAIL);

  /* ============================================================ */
  secao('1. Validações de entrada');
  const eEmail = esperaErro(() => Auth.redefinirSenhaComCodigo('nao-e-email', CODIGO, SENHA_NOVA, SENHA_NOVA));
  ok('e-mail inválido => 400', !!eEmail && eEmail.status === 400, eEmail && eEmail.status);

  const eConfirma = esperaErro(() => Auth.redefinirSenhaComCodigo(EMAIL, CODIGO, SENHA_NOVA, 'OutraSenha1@'));
  ok('confirmação diferente => 400', !!eConfirma && eConfirma.status === 400, eConfirma && eConfirma.error);

  const eFraca = esperaErro(() => Auth.redefinirSenhaComCodigo(EMAIL, CODIGO, 'fraca', 'fraca'));
  ok('senha fraca => 400', !!eFraca && eFraca.status === 400, eFraca && eFraca.error);

  ok('senha NÃO mudou após entradas inválidas',
    Auth.verificarSenha(SENHA_ANTIGA, db.users.find(u => u.id === user.id).password_hash));

  /* ============================================================ */
  secao('2. Código errado não altera a senha');
  const eCodigo = esperaErro(() => Auth.redefinirSenhaComCodigo(EMAIL, '000000', SENHA_NOVA, SENHA_NOVA));
  ok('código errado => 400', !!eCodigo && eCodigo.status === 400, eCodigo && eCodigo.error);
  ok('senha antiga ainda vale', Auth.verificarSenha(SENHA_ANTIGA, db.users.find(u => u.id === user.id).password_hash));
  const regAposErro = db.sms_codes.find(c => c.ident === EMAIL && !c.used);
  ok('tentativa contabilizada (attempts=1)', !!regAposErro && regAposErro.attempts === 1, regAposErro && regAposErro.attempts);

  /* ============================================================ */
  secao('3. Código certo define a nova senha e loga');
  const r = Auth.redefinirSenhaComCodigo(EMAIL, CODIGO, SENHA_NOVA, SENHA_NOVA);
  ok('retorna usuário', !!r && !!r.user && r.user.id === user.id, r && r.user);
  ok('retorna token de sessão', !!r && !!r.token, r && r.token);
  const uDepois = db.users.find(u => u.id === user.id);
  ok('senha nova confere', Auth.verificarSenha(SENHA_NOVA, uDepois.password_hash));
  ok('senha antiga não confere mais', !Auth.verificarSenha(SENHA_ANTIGA, uDepois.password_hash));
  ok('sessões antigas invalidadas', !db.sessions.some(s => s.id === sessaoAntiga.id));
  ok('nova sessão criada', db.sessions.some(s => s.user_id === user.id));
  ok('código consumido (uso único)', !db.sms_codes.some(c => c.ident === EMAIL && !c.used));

  /* ============================================================ */
  secao('4. Código não pode ser reaproveitado');
  const eReuso = esperaErro(() => Auth.redefinirSenhaComCodigo(EMAIL, CODIGO, 'OutraNova1@', 'OutraNova1@'));
  ok('reuso => 400', !!eReuso && eReuso.status === 400, eReuso && eReuso.error);
  ok('senha continua a do passo 3', Auth.verificarSenha(SENHA_NOVA, db.users.find(u => u.id === user.id).password_hash));

  /* ============================================================ */
  secao('5. Login e-mail + senha após a recuperação');
  Auth.limparSessao();
  const semSessao = { id: DB.proximoId(), user_id: user.id, token: 'teste-bloqueio-' + crypto.randomBytes(4).toString('hex'),
    expires_at: new Date(Date.now() + 3600e3).toISOString() };
  /* login com a senha NOVA deve funcionar */
  const loginNovo = Auth.loginComSenha(EMAIL, SENHA_NOVA);
  ok('login com senha nova funciona', !!loginNovo && !!loginNovo.user && loginNovo.user.id === user.id, loginNovo && loginNovo.user);
  /* login com a senha ANTIGA deve falhar */
  const eAntiga = esperaErro(() => Auth.loginComSenha(EMAIL, SENHA_ANTIGA));
  ok('login com senha antiga falha (401)', !!eAntiga && eAntiga.status === 401, eAntiga && eAntiga.status);
  void semSessao;

  /* ============================================================ */
  secao('6. Persistência no PostgreSQL');
  DB.salvar();
  await new Promise(res => setTimeout(res, 2500));
  const rows = await pg.asAdmin(trx => trx('users').where('id', user.id).select('id', 'password_hash'));
  ok('usuário no banco', rows.length === 1, rows.length);
  ok('password_hash persistido é o da senha NOVA',
    rows.length === 1 && Auth.verificarSenha(SENHA_NOVA, rows[0].password_hash), rows[0] && rows[0].password_hash);
  const codigos = await pg.asAdmin(trx => trx('sms_codes').where('ident', EMAIL).select('id'));
  ok('código de recuperação não ficou no banco', codigos.length === 0, codigos.length);

  /* ============================================================ */
  secao('7. RPC allowlist (server.js)');
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  ok('redefinirSenhaComCodigo está em _RPC_AUTH_PUBLICOS', /'redefinirSenhaComCodigo'/.test(src));
  ok('método incluído no guarda de força bruta', /_metodosComCodigo/.test(src) && /'verifyCode', 'redefinirSenhaComCodigo'/.test(src));

  /* ---------- limpeza ---------- */
  db.users = db.users.filter(u => u.id !== user.id);
  db.sessions = db.sessions.filter(s => s.user_id !== user.id);
  db.sms_codes = db.sms_codes.filter(c => c.ident !== EMAIL);
  Auth.limparSessao();
  DB.salvar();
  await new Promise(res => setTimeout(res, 2500));
  await pg.asAdmin(trx => trx('users').where('id', user.id).del());
  await pg.asAdmin(trx => trx('sessions').where('user_id', user.id).del());
  await pg.asAdmin(trx => trx('sms_codes').where('ident', EMAIL).del());
  const resto = await pg.asAdmin(trx => trx('users').where('id', user.id).select('id'));
  ok('limpeza: usuário de teste removido do banco', resto.length === 0, resto.length);

  console.log('\n==================================================');
  console.log('  PASSOU: ' + passou + '   FALHOU: ' + falhou);
  console.log('==================================================');
  process.exit(falhou ? 1 : 0);
})().catch(e => { console.error('\nERRO NO TESTE:', e && e.stack || e); process.exit(1); });
