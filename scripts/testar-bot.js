// Testes do atendente automático (bot) — rodar com:  node scripts/testar-bot.js
// Requer o servidor rodando (npm run dev ou node server.js).
//
// A loja usada nos testes é descoberta em tempo de execução via RPC
// público `lojasProximas`. Antes era um UUID fixo que quebrava sempre que
// o banco era reseeded. Para forçar uma loja específica:
//     TEST_LOJA=<uuid> node scripts/testar-bot.js
const BASE = process.env.APP_URL || 'http://localhost:3000';

let LOJA = process.env.TEST_LOJA || null;
let nomeLoja = LOJA || '(a descobrir)';

let aprovados = 0, reprovados = 0, pulados = 0;
let ultimaThreadId = null;

async function rpc(metodo, args) {
  const resp = await fetch(BASE + '/api/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: metodo, args: args || [] })
  });
  const data = await resp.json();
  if (!resp.ok || !data || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + resp.status));
  return data.data;
}

/* Descobre uma loja real do banco. O antigo UUID fixo
   (00000000-0000-4000-8000-000000000001) só existia em seeds antigos.
   Usa `listarLojasPublicas` (não depende de lat/lng, que aqui são null). */
async function descobrirLoja() {
  if (LOJA) return LOJA;
  const r = await rpc('listarLojasPublicas', [{}]);
  const itens = (r && r.items) || [];
  if (!itens.length) {
    throw new Error('Nenhuma loja encontrada no banco. Rode `npm run seed` ou defina TEST_LOJA=<uuid>.');
  }
  LOJA = itens[0].id;
  nomeLoja = itens[0].name + (itens[0].city ? ' (' + itens[0].city + ')' : '');
  return LOJA;
}

function threadId() { return globalThis.crypto.randomUUID(); }

async function enviar({ email, nome, mensagem, localizacao, pagina }) {
  nome = nome || 'Teste';
  email = email || 'teste@chat.com';
  const id = threadId();
  const r = await rpc('chatEnviar', [{
    threadId: id, lojaId: LOJA, nome, email,
    mensagem, pagina: pagina || '/public/catalogo.html',
    ...(localizacao ? { localizacao } : {})
  }]);
  ultimaThreadId = id;
  const bot = (r.msgs || []).filter(m => m.rem === 'bot').pop();
  return { ...r, textoBot: (bot && bot.texto) || '' };
}

function checa(nome, cond, texto, esperado) {
  if (cond) { aprovados++; console.log('  [OK] ' + nome); }
  else {
    reprovados++;
    console.log('  [FALHOU] ' + nome + (esperado ? '\n     esperado: ' + esperado : ''));
    if (texto) console.log('     bot disse: ' + texto.split('\n')[0].slice(0, 140) + (texto.length > 140 ? '…' : ''));
  }
}

function pula(nome, motivo) { pulados++; console.log('  [PULADO] ' + nome + ' — ' + motivo); }

/* O teste "logado" só significa algo com um e-mail que EXISTE no banco:
   o bot personaliza a resposta quando reconhece o cliente. Buscamos um
   usuário real em vez de chutar um e-mail que pode não existir. */
async function usuarioReal() {
  try {
    const boot = require('../backend/boot');
    await boot.init();
    const db = boot.DB._d();
    const u = (db.users || []).find(x => x && x.email && x.email.includes('@'));
    return u ? { email: u.email, nome: (u.name || '').split(' ')[0] } : null;
  } catch (e) { return null; }
}

(async () => {
  await descobrirLoja();
  console.log('== Atendente automatico — testes ==');
  console.log('Base: ' + BASE);
  console.log('Loja: ' + nomeLoja + '  [' + LOJA + ']\n');

  let r = await enviar({ mensagem: 'oi, tudo bem?' });
  checa('saudacao responde', /assistente virtual.*Corte Comigo|Ol[áa]|Oi|E a[ií]|Hey/i.test(r.textoBot), r.textoBot);

  r = await enviar({ mensagem: 'onde eu faco meu agendamento?' });
  checa('agendar: guia passo a passo', !r.acionadoHumano && /cat[aá]logo/i.test(r.textoBot) && /\b1\)|\b2\)/.test(r.textoBot), r.textoBot, 'guiar sem encaminhar');

  r = await enviar({ mensagem: 'me explica como agendar um horario ai' });
  checa('agendar: tenta orientar no site', !r.acionadoHumano && /agendar|hor[aá]rio/i.test(r.textoBot), r.textoBot);

  r = await enviar({ mensagem: 'tem vaga hoje?' });
  checa('vaga: resolve com link+turma', !r.acionadoHumano && /catalogo|cortecomigo|localhost/i.test(r.textoBot), r.textoBot);

  r = await enviar({ mensagem: 'quero cancelar meu agendamento de hoje' });
  checa('cancelar: tutorial autosservico', !r.acionadoHumano && /Meus agendamentos/i.test(r.textoBot), r.textoBot);

  r = await enviar({ mensagem: 'esqueci minha senha para entrar' });
  checa('senha: resolve sozinho', !r.acionadoHumano && /senha/i.test(r.textoBot), r.textoBot);

  r = await enviar({ mensagem: 'aceitam cartao?' });
  checa('pagamento: nao encaminha em duvida basica', !r.acionadoHumano && r.textoBot.length > 20, r.textoBot);

  r = await enviar({ mensagem: 'que horas voces fecham hoje?' });
  checa('horarios: lista funcionamento', !r.acionadoHumano && /Funcionamento|às|geralmente|S[aá]bado/i.test(r.textoBot), r.textoBot);

  r = await enviar({ mensagem: 'asdasdasd zzzqqq111' });
  checa('fallback: NAO encaminha sem motivo', !r.acionadoHumano && r.textoBot.length > 20, r.textoBot, 'mostrar menu/opcoes e manter no bot');

  const cliente = await usuarioReal();
  if (cliente) {
    r = await enviar({ email: cliente.email, nome: cliente.nome, mensagem: 'como agendo um horario?' });
    checa('logado: guia personalizado na conta', !r.acionadoHumano && /conta|Marcos/i.test(r.textoBot), r.textoBot);
  } else {
    pula('logado: guia personalizado na conta', 'nenhum usuário com e-mail no banco');
  }

  r = await enviar({ mensagem: 'me da um reembolso, cobraram errado' });
  checa('critico(reembolso): encaminha 24h', r.acionadoHumano && r.prazo === 24, r.textoBot, 'acionadoHumano true pr=24');

  r = await enviar({ mensagem: 'quero falar com um atendente humano agora' });
  checa('humano explicito: encaminha 32h', r.acionadoHumano && r.prazo === 32, r.textoBot, 'acionadoHumano true pr=32');

  r = await enviar({ mensagem: 'vou procurar outro salao, nao volto mais' });
  checa('desistencia grave: encaminha 24h', r.acionadoHumano && r.prazo === 24, r.textoBot, 'acionadoHumano true pr=24');

  const hist = await rpc('chatBuscar', [ultimaThreadId]);
  checa('chatBuscar devolve a conversa', hist && Array.isArray(hist.msgs) && hist.msgs.length > 0, '');

  console.log('\nResultado: ' + aprovados + ' aprovados, ' + reprovados + ' falhas, ' + pulados + ' pulados.');
  process.exit(reprovados ? 1 : 0);
})().catch(e => {
  console.error('\nERRO: ' + e.message);
  if (String(e.message).includes('fetch failed') || String(e.message).includes('ECONNREFUSED')) {
    console.error('O servidor esta rodando? Suba com: npm run dev');
  } else if (String(e.message).includes('Salão não encontrado')) {
    console.error('A loja usada nao existe mais. A discovery automatica falhou — defina TEST_LOJA=<uuid>.');
  }
  if (!String(e.message).includes('HTTP') && !String(e.message).includes('fetch failed')) console.error(e);
  process.exit(2);
});