/* ============================================================
   Corte Comigo – admin/js/redefinir-senha.js
   Página de redefinição de senha via token (link por e-mail).
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  /* ---------- obter token da URL ---------- */
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  if (!token) {
    document.getElementById('error-msg').textContent = 'Token inválido ou ausente. Solicite uma nova redefinição.';
    document.getElementById('error-msg').style.display = 'block';
    document.getElementById('btn-submit').disabled = true;
    return;
  }

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

  /* ---------- password strength meter ---------- */
  function atualizarForcaSenha(inputId, forcaId) {
    const input = document.getElementById(inputId);
    const forcaEl = document.getElementById(forcaId);
    if (!input || !forcaEl) return;
    input.addEventListener('input', () => {
      const s = input.value;
      const checks = [
        { re: /.{8,}/, label: '8+ chars' },
        { re: /.{13}/, label: '≤12 chars', invert: true },
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
      forcaEl.innerHTML = '<div class="strength-bar"><div class="strength-bar-fill" style="width:' + pct + '%; background:' + cor + ';"></div></div><span class="strength-text" style="color:' + cor + ';">' + txt + ' (' + ok + '/' + total + ')' + '</span>';
    });
  }
  atualizarForcaSenha('nova-senha', 'senha-forca');

  /* ---------- form submit ---------- */
  const form = document.getElementById('reset-form');
  const btn = document.getElementById('btn-submit');
  const errorEl = document.getElementById('error-msg');
  const successEl = document.getElementById('success-msg');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.style.display = 'none';
    successEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Salvando...';

    const novaSenha = document.getElementById('nova-senha').value;
    const confirmarSenha = document.getElementById('confirmar-senha').value;

    if (novaSenha !== confirmarSenha) {
      errorEl.textContent = 'As senhas não coincidem.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Salvar nova senha';
      return;
    }

    try {
      const r = await Auth.redefinirSenha(token, novaSenha, confirmarSenha);
      if (r.ok) {
        successEl.textContent = 'Senha redefinida com sucesso! Redirecionando para o login...';
        successEl.style.display = 'block';
        setTimeout(() => {
          window.location.href = '/admin/login.html';
        }, 2000);
      } else {
        errorEl.textContent = r.error || 'Erro ao redefinir senha.';
        errorEl.style.display = 'block';
        btn.disabled = false;
        btn.textContent = 'Salvar nova senha';
      }
    } catch (err) {
      errorEl.textContent = (err && err.error) || 'Erro de conexão. Tente novamente.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Salvar nova senha';
    }
  });
});