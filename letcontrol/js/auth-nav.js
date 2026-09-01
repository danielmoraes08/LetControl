
auth.onAuthStateChanged((user) => {
  const loginBtn     = document.getElementById('nav-login-btn');
  const signupBtn    = document.getElementById('nav-signup-btn');
  const dashboardBtn = document.getElementById('nav-dashboard-btn');
  const mobileBtn    = document.getElementById('mobile-nav-btn');

  if (user) {
    // Usuário logado → some com "Entrar" e "Começar grátis", só o painel aparece
    if (loginBtn)     loginBtn.style.display     = 'none';
    if (signupBtn)    signupBtn.style.display    = 'none';
    if (dashboardBtn) dashboardBtn.style.display  = 'inline-flex';
    if (mobileBtn) {
      mobileBtn.href = 'pages/dashboard.html';
      mobileBtn.textContent = 'Meu painel';
    }
  } else {
    // Não logado → mostra os botões de entrar / começar grátis
    if (loginBtn)     loginBtn.style.display     = 'inline-flex';
    if (signupBtn)    signupBtn.style.display    = 'inline-flex';
    if (dashboardBtn) dashboardBtn.style.display  = 'none';
    if (mobileBtn) {
      mobileBtn.href = 'pages/login.html';
      mobileBtn.textContent = 'Entrar na conta';
    }
  }
});
