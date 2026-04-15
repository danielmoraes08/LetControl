
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
