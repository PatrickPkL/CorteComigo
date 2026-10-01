/* ============================================================
   Corte Comigo – admin/js/funcionarios.js
   Gestão de contas Dependente/Funcionário:
   · mostra cota do plano e o Código Único da empresa
   · cria credenciais (Login + Senha)
   · lista e remove funcionários
   ============================================================ */

document.addEventListener('DOMContentLoaded', () => {
  const usuario = exigirLogin(['dono', 'barbeiro']);
  if (!usuario) return;
  const loja = Auth.salaoDoUsuario(usuario);
  if (!loja) {
    showToast('Nenhum salão vinculado a esta conta.', 'error');
    setTimeout(() => { window.location.href = '/login'; }, 1200);
    return;
  }

  const ehDono = usuario.role === 'dono';

  /* barbeiro vê só a lista (p/ desligar); criação e remoção em definitivo
     são do dono */
  if (!ehDono) {
    const formCriar = document.getElementById('form-criar-funcionario');
    if (formCriar) formCriar.closest('.card').style.display = 'none';
  }

  let dados = null;

  function carregar() {
    try {
      dados = API.listarDependentes();
    } catch (e) {
      showToast(msgErro(e), 'error');
      return;
    }
    renderCota();
    renderLista();
  }

  function renderCota() {
    const el = document.getElementById('cota-plano');
    if (!el) return;
    const codigo = datos.codigo_unico ? ' · Código único: ' + datos.codigo_unico : '';
    el.textContent = 'Plano ' + (dados.plano || '—') + ' · ' +
      dados.dependentes_ativos + ' de ' +
      (dados.max_dependents == null ? 'ilimitados' : dados.max_dependents) +
      ' funcionário(s) em uso' + (ehDono ? codigo : '') + '.';
  }

  function renderLista() {
    const tb = document.getElementById('tb-funcionarios');
    const vazio = document.getElementById('sem-funcionarios');
    if (!tb) return;
    tb.innerHTML = '';
    const lista = dados.dependentes || [];

    if (vazio) vazio.style.display = lista.length ? 'none' : '';

    lista.forEach(dep => {
      const tr = document.createElement('tr');
      const nome = document.createElement('td');
      nome.textContent = dep.name;
      const login = document.createElement('td');
      login.textContent = dep.email;
      const criado = document.createElement('td');
      criado.innerHTML = fmtDataHoraBR(dep.created_at) || '—';
      const acoes = document.createElement('td');

      /* Dois botões com o MESMO estilo e nomes parecidos ("Desligar" /
         "Remover") para ações com consequências opostas: um só desvincula,
         o outro APAGA a conta. Rótulos explícitos + tooltips. */
      const btnDesligar = document.createElement('button');
      btnDesligar.type = 'button';
      btnDesligar.className = 'btn btn-outline';
      btnDesligar.style.cssText = 'padding:6px 10px;font-size:12.5px;';
      btnDesligar.textContent = 'Desvincular';
      btnDesligar.title = 'Remove só o vínculo com a empresa. O login, a senha e o histórico continuam existindo.';
      btnDesligar.addEventListener('click', () => desligar(dep));
      acoes.appendChild(btnDesligar);

      if (ehDono) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-outline';
        btn.style.cssText = 'padding:6px 10px;font-size:12.5px;color:var(--danger-text, #e5484d);border-color:var(--danger-text, #e5484d);';
        btn.textContent = 'Excluir conta';
        btn.title = 'APAGA a conta e o acesso permanentemente. Use "Desvincular" se a pessoa só foi desligada.';
        btn.addEventListener('click', () => remover(dep));
        acoes.appendChild(btn);
      }

      tr.appendChild(nome); tr.appendChild(login); tr.appendChild(criado); tr.appendChild(acoes);
      tb.appendChild(tr);
    });
  }

  const form = document.getElementById('form-criar-funcionario');
  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const nomeEl = document.getElementById('fun-nome');
    const loginEl = document.getElementById('fun-login');
    const senhaEl = document.getElementById('fun-senha');
    try {
      const r = API.criarDependente({
        name: nomeEl.value,
        login: loginEl.value,
        senha: senhaEl.value
      });
      showToast('Acesso criado para ' + r.name + '!');
      form.reset();
      carregar();
    } catch (erro) {
      showToast(msgErro(erro), 'error');
    }
  });

  function desligar(dep) {
    if (!window.confirm(
      'Desvincular "' + dep.name + '" (' + dep.email + ')?\n\n' +
      'A empresa perde o acesso à agenda e aos clientes deste funcionário. ' +
      'A CONTA CONTINUA EXISTINDO: login, senha e histórico pessoal são preservados.'
    )) return;
    try {
      API.desvincularDependente(dep.id);
      showToast('Vínculo desfeito. A conta continua existindo.');
      carregar();
    } catch (e) {
      showToast(msgErro(e), 'error');
    }
  }

  function remover(dep) {
    if (!window.confirm(
      'EXCLUIR A CONTA de "' + dep.name + '" (' + dep.email + ')?\n\n' +
      'Isto apaga a conta e o acesso permanentemente, junto das referências ' +
      'a ela (agendamentos e clientes vinculados).\n\n' +
      'Se a pessoa só foi desligada e você quer preservar o histórico, ' +
      'use "Desvincular" em vez disto.\n\nEsta ação não pode ser desfeita.'
    )) return;
    try {
      API.excluirDependente(dep.id);
      showToast('Conta excluída permanentemente.', 'success');
      carregar();
    } catch (e) {
      showToast(msgErro(e), 'error');
    }
  }

  carregar();
});
