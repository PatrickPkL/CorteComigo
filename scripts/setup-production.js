#!/usr/bin/env node
'use strict';
/* ============================================================
   Corte Comigo – setup-production.js
   Script interativo para configurar o ambiente de produção.

   Uso:
     node scripts/setup-production.js

   O script:
   1. Gera DB_ENCRYPT_KEY (AES-256-GCM)
   2. Gera SUPER_ADMIN_HASH (bcrypt) a partir de senha escolhida
   3. Cria .env pronto para produção
   4. (Opcional) Roda migrations e seeds via knex
   ============================================================ */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const ENV_EXAMPLE = path.join(ROOT, '.env.example');

function pergunta(rl, texto) {
  return new Promise(resolve => rl.question(texto, resolve));
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n=== Corte Comigo – Configuração de Produção ===\n');

  // 1. Ler .env.example como base
  let envBase = '';
  if (fs.existsSync(ENV_EXAMPLE)) {
    envBase = fs.readFileSync(ENV_EXAMPLE, 'utf8');
  } else {
    console.error('❌ .env.example não encontrado.');
    process.exit(1);
  }

  // 2. Gerar DB_ENCRYPT_KEY
  const encryptKey = crypto.randomBytes(32).toString('hex');
  console.log('🔐 DB_ENCRYPT_KEY gerada: ' + encryptKey);

  // 3. Perguntar senha do super-admin e gerar hash
  console.log('\n--- Super-Admin ---');
  const superAdminEmail = await pergunta(rl, 'E-mail do super-admin [admin@cortecomigo.com]: ') || 'admin@cortecomigo.com';
  const superAdminPass = await pergunta(rl, 'Senha do super-admin (mín. 8 chars): ');
  if (superAdminPass.length < 8) {
    console.error('❌ Senha deve ter pelo menos 8 caracteres.');
    process.exit(1);
  }
  const superAdminHash = bcrypt.hashSync(superAdminPass, 10);
  console.log('🔐 SUPER_ADMIN_HASH gerado (bcrypt, cost=10).');

  // 4. Perguntar IPs permitidos (opcional)
  const superAdminIps = await pergunta(rl, 'IPs permitidos para super-admin (separados por vírgula, vazio = qualquer): ');

  // 5. Configurações de banco
  console.log('\n--- Banco de Dados ---');
  const pgHost = await pergunta(rl, 'Host do PostgreSQL [127.0.0.1]: ') || '127.0.0.1';
  const pgPort = await pergunta(rl, 'Porta do PostgreSQL [5432]: ') || '5432';
  const pgDatabase = await pergunta(rl, 'Nome do banco [cortecerto]: ') || 'cortecerto';
  const pgSuperUser = await pergunta(rl, 'Usuário superuser (para migrações) [postgres]: ') || 'postgres';
  const pgSuperPass = await pergunta(rl, 'Senha do superuser: ');
  if (!pgSuperPass) {
    console.error('❌ Senha do superuser é obrigatória.');
    process.exit(1);
  }
  const pgAppUser = await pergunta(rl, 'Usuário da aplicação (role multi-tenant) [cortecerto_app]: ') || 'cortecerto_app';
  const pgAppPass = await pergunta(rl, 'Senha do usuário da aplicação: ');
  if (!pgAppPass) {
    console.error('❌ Senha do usuário da aplicação é obrigatória.');
    process.exit(1);
  }
  const pgReadonlyPass = await pergunta(rl, 'Senha do usuário readonly [cortecerto_readonly]: ') || pgAppPass;
  const pgAdminPass = await pergunta(rl, 'Senha do usuário admin (schema) [cortecerto_admin]: ') || pgAppPass;

  // 6. AbacatePay
  console.log('\n--- AbacatePay (Pagamentos) ---');
  const abacateApiKey = await pergunta(rl, 'ABACATEPAY_API_KEY (obrigatório em produção): ');
  const abacateWebhookSecret = await pergunta(rl, 'ABACATEPAY_WEBHOOK_HMAC_SECRET (obrigatório): ');
  if (!abacateApiKey || !abacateWebhookSecret) {
    console.error('❌ Chaves da AbacatePay são obrigatórias para produção.');
    process.exit(1);
  }

  // 7. Gmail/SMTP
  console.log('\n--- Gmail / SMTP (E-mails) ---');
  const gmailUser = await pergunta(rl, 'GMAIL_USER (e-mail remetente): ');
  const gmailPass = await pergunta(rl, 'GMAIL_PASS (senha de app do Google): ');
  if (!gmailUser || !gmailPass) {
    console.log('⚠️  Sem credenciais Gmail: recuperação de senha, LGPD e notificações não funcionarão.');
  }

  // 8. DPO / LGPD
  console.log('\n--- LGPD / DPO ---');
  const dpoEmail = await pergunta(rl, 'DPO_EMAIL [dpo@cortecomigo.com]: ') || 'dpo@cortecomigo.com';
  const dpoName = await pergunta(rl, 'DPO_NAME [Encarregado de Dados]: ') || 'Encarregado de Dados';

  // 9. App URL
  const appUrl = await pergunta(rl, 'APP_URL (URL pública da aplicação) [https://seudominio.com]: ') || 'https://seudominio.com';

  // 10. Bot (opcional)
  console.log('\n--- Bot de Atendimento (opcional) ---');
  const botForward = await pergunta(rl, 'BOT_FORWARD_TO [atendimento@seudominio.com]: ') || 'atendimento@seudominio.com';
  const botName = await pergunta(rl, 'BOT_ASSISTANT_NAME [Equipe Corte Comigo]: ') || 'Equipe Corte Comigo';
  const geminiKey = await pergunta(rl, 'GEMINI_API_KEY (opcional, para IA): ');

  // 11. Montar .env final
  const now = new Date().toISOString();
  const envContent = `# ============================================================
# Corte Comigo – .env de PRODUÇÃO
# Gerado automaticamente em ${now}
# NÃO COMITE ESTE ARQUIVO — contém segredos!
# ============================================================

# === PostgreSQL ===
MIGRATION_DATABASE_URL=postgres://${pgSuperUser}:${encodeURIComponent(pgSuperPass)}@${pgHost}:${pgPort}/${pgDatabase}
AUTO_MIGRATE=1
DATABASE_URL=postgres://${pgAppUser}:${encodeURIComponent(pgAppPass)}@${pgHost}:${pgPort}/${pgDatabase}
CC_APP_DB_PASSWORD=${pgAppPass}
CC_READONLY_DB_PASSWORD=${pgReadonlyPass}
CC_ADMIN_DB_PASSWORD=${pgAdminPass}
PGHOST=${pgHost}
PGPORT=${pgPort}
PGUSER=${pgAppUser}
PGPASSWORD=${pgAppPass}
PGDATABASE=${pgDatabase}
PGSSL_STRICT=
TZ=America/Sao_Paulo

# === AbacatePay ===
ABACATEPAY_API_KEY=${abacateApiKey}
ABACATEPAY_WEBHOOK_HMAC_SECRET=${abacateWebhookSecret}
ABACATEPAY_WEBHOOK_SECRET=${abacateWebhookSecret}

# === Gmail Email via Nodemailer ===
GMAIL_USER=${gmailUser}
GMAIL_PASS=${gmailPass}
EMAIL_FROM=Corte Comigo

# === Bot Atendente de E-mail ===
BOT_FORWARD_TO=${botForward}
BOT_ASSISTANT_NAME=${botName}
BOT_CHECK_SECONDS=30

# === Bot: IA Gemini ===
GEMINI_API_KEY=${geminiKey}
GEMINI_MODEL=gemini-2.0-flash

# === App URL ===
APP_URL=${appUrl}

# === Super-Admin ===
SUPER_ADMIN_EMAIL=${superAdminEmail}
SUPER_ADMIN_HASH=${superAdminHash}
SUPER_ADMIN_IPS=${superAdminIps}

# === LGPD / DPO ===
DPO_EMAIL=${dpoEmail}
DPO_NAME=${dpoName}

# === Criptografia em Repouso (OBRIGATÓRIO) ===
DB_ENCRYPT_KEY=${encryptKey}
# CC_CRYPT_INSECURE_PLAINTEXT=1  # NUNCA em produção!

# === Server ===
PORT=3000
`;

  // 12. Escrever .env
  fs.writeFileSync(ENV_FILE, envContent);
  console.log('\n✅ .env criado em: ' + ENV_FILE);

  // 13. Perguntar se roda migrações
  const runMigrate = await pergunta(rl, '\nRodar migrações agora? (s/N): ');
  if (runMigrate.toLowerCase() === 's') {
    console.log('\n📦 Rodando migrações...');
    const { spawn } = require('child_process');
    await new Promise((resolve, reject) => {
      const proc = spawn('npm', ['run', 'migrate'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...require('dotenv').parse(envContent) } });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error('Migrações falharam (código ' + code + ')')) );
    });
    console.log('✅ Migrações concluídas.');

    const runSeed = await pergunta(rl, 'Rodar seed de demonstração? (s/N): ');
    if (runSeed.toLowerCase() === 's') {
      console.log('\n🌱 Rodando seed...');
      await new Promise((resolve, reject) => {
        const proc = spawn('npm', ['run', 'seed'], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...require('dotenv').parse(envContent) } });
        proc.on('close', code => code === 0 ? resolve() : reject(new Error('Seed falhou (código ' + code + ')')) );
      });
      console.log('✅ Seed concluído.');
    }
  }

  console.log('\n=== PRONTO PARA PRODUÇÃO ===');
  console.log('Variáveis críticas definidas:');
  console.log('  DB_ENCRYPT_KEY          ✅');
  console.log('  SUPER_ADMIN_HASH        ✅');
  console.log('  MIGRATION_DATABASE_URL  ✅');
  console.log('  DATABASE_URL            ✅');
  console.log('  ABACATEPAY_API_KEY      ✅');
  console.log('  ABACATEPAY_WEBHOOK_HMAC_SECRET ✅');
  console.log('  GMAIL_USER / GMAIL_PASS ' + (gmailUser && gmailPass ? '✅' : '⚠️  (não configurado)'));
  console.log('\nPróximos passos:');
  console.log('1. Configure o webhook na AbacatePay apontando para ' + appUrl + '/webhook/abacatepay?webhookSecret=SEU_SEGREDO');
  console.log('2. Inicie o servidor: npm start');
  console.log('3. Acesse ' + appUrl + '/super-admin para o painel do super-admin');
  console.log('4. Login: ' + superAdminEmail + ' / (sua senha)');

  rl.close();
}

main().catch(err => {
  console.error('\n❌ Erro:', err.message);
  process.exit(1);
});