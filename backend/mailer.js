"use strict";

var GMAIL_USER = process.env.GMAIL_USER || "";
var GMAIL_PASS = process.env.GMAIL_PASS || "";
var FROM_NAME = process.env.EMAIL_FROM || "Corte Comigo";
var APP_URL = process.env.APP_URL || "http://localhost:3000";
var DEMO_MODE = !GMAIL_USER || !GMAIL_PASS;

var transporter = null;
var transporterPorta = null;

/* Gmail aceita envio pelas portas 465 (SSL implícito) e 587 (STARTTLS).
   O Render só tem rota IPv4 — por isso resolvemos o IPv4 do Gmail de forma
   explícita e conectamos no IP (family:4 às vezes é ignorado/falha silenciosa).

   Importante: o DNS do Render pode devolver IPs errados/lixo para o Gmail
   (ex.: 192.179.26.109), travando a conexao. Por isso os IPs reais sao
   buscados via DNS-over-HTTPS (porta 443, sempre aberta) com fallback para
   o DNS do sistema. */
var PORTAS_SMTP = [465, 587];

var dns = require("dns");
var https = require("https");

/* Lista de enderecos "reservados" conhecidamente errados que o DNS de alguns
   provedores (Render) devolve para smtp.gmail.com. */
var IPsLixo = {
  "192.179.26.109": true,
  "192.179.27.109": true
};

function normalizarIPs(lista) {
  var vistos = {};
  var saida = [];
  (lista || []).forEach(function (ip) {
    var s = String(ip || "").trim();
    if (!s || !/^\d+\.\d+\.\d+\.\d+$/.test(s)) return;
    if (IPsLixo[s]) return;
    if (vistos[s]) return;
    vistos[s] = true;
    saida.push(s);
  });
  return saida;
}

/* Busca os enderecos IPv4 de smtp.gmail.com via DNS-over-HTTPS (dns.google). */
function resolverDoH() {
  return new Promise(function (resolve) {
    var req = https.get("https://dns.google/resolve?name=smtp.gmail.com&type=A", function (res) {
      var dados = "";
      res.on("data", function (c) { dados += c; });
      res.on("end", function () {
        try {
          var j = JSON.parse(dados);
          var ips = (j.Answer || []).filter(function (a) { return a && a.type === 1; }).map(function (a) { return a.data; });
          resolve(normalizarIPs(ips));
        } catch (e) {
          resolve([]);
        }
      });
    });
    req.setTimeout(8000, function () { req.destroy(); resolve([]); });
    req.on("error", function () { resolve([]); });
  });
}

/* Obtém a lista de IPs reais: DoH primeiro, depois DNS do sistema como fallback. */
function resolverIPv4() {
  return resolverDoH().then(function (ipsDoH) {
    return new Promise(function (resolve) {
      dns.resolve4("smtp.gmail.com", function (err, enderecos) {
        var ipsSistema = normalizarIPs(enderecos);
        var todos = [];
        (ipsDoH.concat(ipsSistema)).forEach(function (ip) {
          if (todos.indexOf(ip) === -1) todos.push(ip);
        });
        if (/^172\.217\./.test(todos.join(",")) && todos.length > 1) {
          todos.unshift(todos.splice(todos.findIndex(function (i) { return /^172\.217\./.test(i); }), 1)[0]);
        }
        resolve(todos);
      });
      if (!ipsDoH.length && typeof enderecos === "undefined") { /* noop */ }
    }).then(function (lista) {
      if (!lista.length) throw new Error("Sem IPs validos para smtp.gmail.com");
      return lista;
    });
  });
}

function criarTransporter(porta, ip) {
  var nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: ip,
    port: porta,
    secure: porta === 465,
    requireTLS: porta !== 465,
    connectionTimeout: 12000,
    greetingTimeout: 12000,
    socketTimeout: 25000,
    tls: { servername: "smtp.gmail.com" },
    auth: { user: GMAIL_USER, pass: GMAIL_PASS.replace(/\s/g, "") }
  });
}

/* Monta o transporter na primeira porta que verificar a conexão.
   Testa todas as combinações IP × porta em paralelo e usa a que responder primeiro. */
function garantirTransporter() {
  if (transporter) return Promise.resolve(transporter);
  return resolverIPv4().then(function (ips) {
    var tentativas = [];
    ips.forEach(function (ip) {
      PORTAS_SMTP.forEach(function (porta) {
        var t = criarTransporter(porta, ip);
        tentativas.push(t.verify()
          .then(function () {
            return { porta: porta, ip: ip, t: t, ok: true };
          })
          .catch(function (e) {
            return { porta: porta, ip: ip, t: t, ok: false, erro: e };
          }));
      });
    });
    return Promise.all(tentativas).then(function (resultados) {
      var ok = null;
      for (var i = 0; i < resultados.length; i++) {
        if (resultados[i] && resultados[i].ok) { ok = resultados[i]; break; }
      }
      if (!ok) {
        ok = { porta: PORTAS_SMTP[0], ip: (ips && ips[0]) || "smtp.gmail.com", t: criarTransporter(PORTAS_SMTP[0], (ips && ips[0]) || "smtp.gmail.com") };
      }
      transporter = ok.t;
      transporterPorta = ok.porta;
      console.log("[EMAIL] Conectado ao Gmail " + ok.ip + " via porta " + ok.porta);
      return transporter;
    });
  });
}

function temEmailReal() {
  return !DEMO_MODE;
}

function mascaraEmail(email) {
  var s = String(email || "").split("@");
  if (s.length !== 2) return "[oculto]";
  var local = s[0].slice(0, 2) + "***";
  var dom = s[1].split(".").map(function (p, i) { return i === 0 ? p.slice(0, 2) + "***" : p; }).join(".");
  return local + "@" + dom;
}

function enviarEmailComTimeout(destino, tag) {
  if (DEMO_MODE) {
    console.log("========================================");
    console.log("[EMAIL - MODO DEMO] " + (tag || ""));
    console.log("Para:", mascaraEmail(destino.to));
    console.log("Assunto:", destino.subject);
    console.log("========================================");
    return Promise.resolve();
  }

  var mailOptions = {
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: destino.to,
    subject: destino.subject,
    html: destino.html
  };

  return garantirTransporter().then(function () {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        console.log("[EMAIL] Timeout no envio de", tag || "email");
        reject(new Error("Timeout no envio de " + (tag || "email")));
      }, 25000);

      transporter.sendMail(mailOptions)
        .then(function () {
          clearTimeout(timer);
          console.log("[EMAIL] Enviado:", tag || "email", "->", destino.to);
          resolve();
        })
        .catch(function (err) {
          clearTimeout(timer);
          console.log("[EMAIL] Erro no envio de", tag || "email");
          console.log("[EMAIL] Erro:", err && err.message ? err.message : err);
          var detalhe = (err && err.response) ? (" — resposta SMTP: " + err.response) : "";
          console.log("[EMAIL] Dica:", "verifique GMAIL_USER/GMAIL_PASS (senha de app)", detalhe);
          reject(err);
        });
    });
  });
}

function cabecalhoHTML() {
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="margin:0;padding:0;background-color:#f4f4f4;font-family:system-ui,-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">';
}

function rodapeHTML() {
  return "</body></html>";
}

function containerHTML(conteudo) {
  return '<div style="max-width:480px;margin:0 auto;background-color:#ffffff;border-radius:8px;overflow:hidden;margin-top:20px;margin-bottom:20px;">' +
    '<div style="background-color:#b8863b;padding:30px 20px;text-align:center;">' +
      '<h1 style="color:#ffffff;margin:0;font-size:22px;font-weight:700;">Corte Comigo</h1>' +
    "</div>" +
    '<div style="padding:40px 20px;">' +
      conteudo +
    "</div>" +
    '<div style="padding:20px;text-align:center;background-color:#f9f9f9;border-top:1px solid #eeeeee;">' +
      '<p style="color:#999999;font-size:12px;margin:0;">Corte Comigo &copy; ' + new Date().getFullYear() + ' — Todos os direitos reservados.</p>' +
    "</div>" +
    "</div>";
}

function botaoHTML(href, texto) {
  return '<a href="' + href + '" style="display:inline-block;background-color:#b8863b;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:6px;font-size:16px;font-weight:600;margin:20px 0;">' + texto + "</a>";
}

function enviarLinkMagico(email, token, nome) {
  var link = APP_URL + "/magic-link?token=" + token;

  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá' + (nome ? ", " + nome : "") + "!</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Clique no botão abaixo para acessar sua conta no Corte Comigo. Não é necessário senha.</p>' +
    '<div style="text-align:center;">' +
      botaoHTML(link, "Entrar no Corte Comigo") +
    "</div>" +
    '<p style="color:#999999;font-size:12px;margin:24px 0 0 0;text-align:center;">Este link expira em 15 minutos.</p>';

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Confirme seu e-mail — Corte Comigo",
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "link-magico");
}

function enviarCodigoVerificacao(email, codigo) {
  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá!</p>' +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Use o código abaixo para concluir seu cadastro no Corte Comigo:</p>' +
    '<div style="text-align:center;background-color:#f9f9f9;border-radius:8px;padding:24px;margin:16px 0;">' +
      '<span style="display:inline-block;color:#b8863b;font-size:32px;font-weight:800;letter-spacing:8px;font-family:monospace;">' + String(codigo) + "</span>" +
    "</div>" +
    '<p style="color:#999999;font-size:12px;margin:16px 0 0 0;text-align:center;">Este código expira em 10 minutos.</p>';

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Seu código de verificação — Corte Comigo",
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "codigo-verificacao");
}

function enviarRecuperacao(email, token, nome) {
  var link = APP_URL + "/magic-link?token=" + token;

  if (DEMO_MODE) {
    console.log("[EMAIL - MODO DEMO] link de recuperacao -> " + link);
  }

  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá' + (nome ? ", " + nome : "") + "!</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Recebemos um pedido para recuperar o acesso à sua conta no Corte Comigo.</p>' +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Clique no botão abaixo para entrar na sua conta. Não é necessária senha.</p>' +
    '<div style="text-align:center;">' +
      botaoHTML(link, "Recuperar acesso") +
    "</div>" +
    '<p style="color:#999999;font-size:12px;margin:24px 0 0 0;text-align:center;">Este link expira em 15 minutos. Se você não pediu isso, pode ignorar este e-mail.</p>';

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Recupere seu acesso — Corte Comigo",
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "recuperar-acesso");
}

function enviarRedefinicaoSenha(email, token, nome) {
  var link = APP_URL + "/admin/redefinir-senha.html?token=" + token;

  if (DEMO_MODE) {
    console.log("[EMAIL - MODO DEMO] link de redefinição de senha -> " + link);
  }

  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá' + (nome ? ", " + nome : "") + "!</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Recebemos um pedido para redefinir a senha da sua conta no Corte Comigo.</p>' +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Clique no botão abaixo para criar uma nova senha.</p>' +
    '<div style="text-align:center;">' +
      botaoHTML(link, "Redefinir senha") +
    "</div>" +
    '<p style="color:#999999;font-size:12px;margin:24px 0 0 0;text-align:center;">Este link expira em 1 hora. Se você não pediu isso, pode ignorar este e-mail.</p>';

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Redefina sua senha — Corte Comigo",
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "redefinir-senha");
}

function enviarConfirmacaoAgendamento(email, dados) {
  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá, ' + (dados.clienteNome || "cliente") + "!</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 8px 0;">Seu agendamento em <strong>' + (dados.salaoNome || "") + "</strong> foi confirmado:</p>" +
    '<div style="background-color:#f9f9f9;border-radius:6px;padding:16px;margin:16px 0;">' +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Serviço:</strong> ' + (dados.servicos || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Data:</strong> ' + (dados.data || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0;"><strong>Hora:</strong> ' + (dados.hora || "") + "</p>" +
    "</div>" +
    '<p style="color:#555555;font-size:14px;margin:16px 0 0 0;">Até lá!</p>';

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Agendamento confirmado — " + (dados.salaoNome || "Corte Comigo"),
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "confirmacao-agendamento");
}

function enviarNovoAgendamento(email, dados) {
  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Novo agendamento recebido!</p>' +
    '<div style="background-color:#f9f9f9;border-radius:6px;padding:16px;margin:16px 0;">' +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Cliente:</strong> ' + (dados.clienteNome || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Salaão:</strong> ' + (dados.salaoNome || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Serviço:</strong> ' + (dados.servicos || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Data:</strong> ' + (dados.data || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0;"><strong>Hora:</strong> ' + (dados.hora || "") + "</p>" +
    "</div>";

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Novo agendamento — " + (dados.clienteNome || "Cliente"),
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "novo-agendamento");
}

function enviarCodigoExclusao(email, codigo) {
  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá!</p>' +
    '<p style="color:#555555;font-size:14px;margin:0 0 24px 0;">Recebemos um pedido para excluir a sua conta no Corte Comigo. Para concluir, digite o código abaixo:</p>' +
    '<div style="text-align:center;background-color:#f9f9f9;border-radius:8px;padding:24px;margin:16px 0;">' +
      '<span style="display:inline-block;color:#b8863b;font-size:40px;font-weight:800;letter-spacing:10px;font-family:monospace;">' + String(codigo) + "</span>" +
    "</div>" +
    '<p style="color:#999999;font-size:12px;margin:16px 0 0 0;text-align:center;">Este código expira em 5 minutos. Se você não pediu isso, ignore este e-mail.</p>';

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: "Código para excluir sua conta — Corte Comigo",
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "codigo-exclusao");
}

function enviarBoasVindas(dados) {
  var link = APP_URL + "/painel";
  var linkAgend = dados.shopId
    ? (APP_URL + "/public/salao-publico.html?id=" + encodeURIComponent(dados.shopId))
    : null;

  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Bem-vindo ao Corte Comigo, ' + (dados.nome || "") + "!</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 8px 0;">Sua conta no salão <strong>' + (dados.nomeSalao || "") + "</strong> foi criada." +
    (dados.trialDias ? " Você tem <strong>" + dados.trialDias + " dias</strong> de teste grátis." : "") +
    "</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 16px 0;">Comece agora mesmo:</p>' +
    '<div style="background-color:#f9f9f9;border-radius:6px;padding:16px;margin:16px 0;">' +
      '<p style="color:#333333;font-size:14px;margin:0 0 10px 0;">1. Cadastre seus serviços e preços</p>' +
      '<p style="color:#333333;font-size:14px;margin:0 0 10px 0;">2. Adicione seus profissionais</p>' +
      '<p style="color:#333333;font-size:14px;margin:0 0 10px 0;">3. Compartilhe o link de agendamento com seus clientes</p>' +
      '<p style="color:#333333;font-size:14px;margin:0;">4. Acompanhe seus agendamentos no painel</p>' +
    "</div>" +
    (linkAgend
      ? '<p style="color:#555555;font-size:14px;margin:0 0 6px 0;">Seu link exclusivo de agendamento:</p>' +
        '<p style="font-size:13px;word-break:break-all;margin:0 0 16px 0;"><a href="' + linkAgend + '" style="color:#b8863b;">' + linkAgend + "</a></p>"
      : "") +
    '<div style="text-align:center;">' +
      (linkAgend ? botaoHTML(linkAgend, "Abrir meu link de agendamento") + "<br><br>" : "") +
      botaoHTML(link, "Acessar meu painel") +
    "</div>";

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: dados.email,
    subject: "Bem-vindo ao Corte Comigo, " + (dados.nome || "") + "!",
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "boas-vindas");
}

function enviarLembrete(email, dados) {
  var quando = dados.quando || "amanh\u00e3";
  var assunto;
  if (dados.isCliente) {
    assunto = "Lembrete: agendamento " + quando + " \u00e0s " + (dados.hora || "") + " em " + (dados.salaoNome || "");
  } else {
    assunto = "Lembrete: " + (dados.nome || "Cliente") + " tem agendamento " + quando + " \u00e0s " + (dados.hora || "");
  }

  var urlPainel = dados.appUrl || APP_URL + "/painel";
  var linkAgenda = dados.linkAgendamento || null;

  var conteudo =
    '<p style="color:#333333;font-size:16px;margin:0 0 16px 0;">Olá' + (dados.nome ? ", " + dados.nome : "") + "!</p>" +
    '<p style="color:#555555;font-size:14px;margin:0 0 8px 0;">Este é um aviso do compromisso que você marcou no site:</p>' +
    '<p style="color:#555555;font-size:14px;margin:0 0 8px 0;">Seu agendamento é <strong>' + quando + "</strong>:</p>" +
    '<div style="background-color:#f9f9f9;border-radius:6px;padding:16px;margin:16px 0;">' +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Salão:</strong> ' + (dados.salaoNome || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Serviço:</strong> ' + (dados.servicos || "") + "</p>" +
      '<p style="color:#333333;font-size:14px;margin:0 0 6px 0;"><strong>Hora:</strong> ' + (dados.hora || "") + "</p>" +
      (dados.endereco ? '<p style="color:#333333;font-size:14px;margin:0;"><strong>Endereço:</strong> ' + dados.endereco + "</p>" : "") +
    "</div>" +
    (dados.isCliente && linkAgenda
      ? '<p style="color:#555555;font-size:14px;margin:0 0 6px 0;">Precisa marcar outro horário? Use seu link:</p>' +
        '<p style="font-size:13px;word-break:break-all;margin:0 0 16px 0;"><a href="' + linkAgenda + '" style="color:#b8863b;">' + linkAgenda + "</a></p>"
      : "") +
    '<div style="text-align:center;">' +
      (dados.isCliente && linkAgenda
        ? botaoHTML(linkAgenda, "Ver salão e agendar")
        : botaoHTML(urlPainel, dados.isCliente ? "Gerenciar agendamento" : "Ver no painel")) +
    "</div>";

  return enviarEmailComTimeout({
    from: FROM_NAME + " <" + GMAIL_USER + ">",
    to: email,
    subject: assunto,
    html: cabecalhoHTML() + containerHTML(conteudo) + rodapeHTML()
  }, "lembrete");
}

module.exports = {
  enviarLinkMagico: enviarLinkMagico,
  enviarCodigoVerificacao: enviarCodigoVerificacao,
  enviarCodigoExclusao: enviarCodigoExclusao,
  temEmailReal: temEmailReal,
  enviarRecuperacao: enviarRecuperacao,
  enviarRedefinicaoSenha: enviarRedefinicaoSenha,
  enviarConfirmacaoAgendamento: enviarConfirmacaoAgendamento,
  enviarNovoAgendamento: enviarNovoAgendamento,
  enviarBoasVindas: enviarBoasVindas,
  enviarLembrete: enviarLembrete,
  criarTransporterEmail: criarTransporter,
  resolverIPsGmail: resolverIPv4
};
