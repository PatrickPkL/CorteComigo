/* ============================================================
   Corte Comigo – public/js/lgpd.js
   Exercício de direitos LGPD: envia a solicitação e mostra o
   protocolo. Em arquivo externo para o CSP não precisar de
   'unsafe-inline' em script-src.
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('lgpd-enviar');
  if (!btn) return;

  btn.addEventListener('click', () => {
    const nome = document.getElementById('lgpd-nome').value.trim();
    const email = document.getElementById('lgpd-email').value.trim();
    const telefone = document.getElementById('lgpd-telefone').value.trim();
    const tipo = document.getElementById('lgpd-tipo').value;
    const descricao = document.getElementById('lgpd-descricao').value.trim();

    if (!nome || !email || !tipo || !descricao) {
      alert('Preencha todos os campos obrigatórios.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      alert('E-mail inválido.');
      return;
    }
    const digitos = telefone.replace(/\D/g, '');
    if (telefone && (digitos.length < 10 || digitos.length > 13)) {
      alert('Telefone inválido: use de 10 a 13 dígitos.');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Enviando...';

    try {
      /* A solicitação é registrada no backend (protocolo real + aviso ao
         DPO). Antes este formulário gerava um protocolo fictício no
         navegador e imprimia no console: o titular recebia "solicitação
         registrada" sem existir registro nenhum. */
      const r = API.enviarSolicitacaoLGPD({
        nome: nome, email: email, telefone: telefone,
        tipo: tipo, descricao: descricao
      });

      document.getElementById('lgpd-form').style.display = 'none';
      document.getElementById('lgpd-sucesso').style.display = 'block';
      document.getElementById('lgpd-protocolo').textContent =
        'Protocolo: ' + ((r && r.protocolo) || 'registrado');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Enviar solicitação';
      const msg = (e && e.error) || 'Não foi possível registrar sua solicitação. Tente novamente.';
      alert(msg);
      if (window.console) console.error('[LGPD]', e);
    }
  });
});