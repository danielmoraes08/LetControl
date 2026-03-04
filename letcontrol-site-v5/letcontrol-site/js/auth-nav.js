/**
 * js/auth-nav.js
 * Atualiza a navbar da landing page conforme o estado de autenticação.
 * Se o usuário já está logado, mostra "Meu Painel" no lugar de "Entrar".
 */

auth.onAuthStateChanged((user) => {
  const loginBtn     = document.getElementById('nav-login-btn');
  const dashboardBtn = document.getElementById('nav-dashboard-btn');

  if (user) {
    // Usuário logado → mostrar botão de painel
    if (loginBtn)     loginBtn.style.display     = 'none';
    if (dashboardBtn) dashboardBtn.style.display  = 'inline-flex';
  } else {
    // Não logado → mostrar botão de entrar
    if (loginBtn)     loginBtn.style.display     = 'inline-flex';
    if (dashboardBtn) dashboardBtn.style.display  = 'none';
  }
});
