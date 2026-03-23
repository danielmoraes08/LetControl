let isRegistering = false;

auth.onAuthStateChanged(user => {
  if (user && !isRegistering) window.location.href = 'dashboard.html';
});

async function handleGoogleLogin() {
  clearMessages(); clearErrors();
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const res = await auth.signInWithPopup(provider);
    const user = res.user;

    const uid = user.uid;
    const snap = await rtdb.ref(`users/${uid}`).once('value');
    if (!snap.exists()) {
      const now = Date.now();
      const name = user.displayName || user.email?.split('@')[0] || 'Usuário';
      const email = user.email || '';
      const updates = {};
      updates[`users/${uid}/name`] = name;
      updates[`users/${uid}/email`] = email;
      updates[`users/${uid}/plan`] = 'free';
      updates[`users/${uid}/created_at`] = now;
      updates[`users/${uid}/updated_at`] = now;
      updates[`users/${uid}/settings/timezone`] = 'America/Sao_Paulo';
      updates[`users/${uid}/settings/units/volume`] = 'L';
      updates[`users/${uid}/settings/units/flow`] = 'L/min';
      await rtdb.ref().update(updates);
    }
    showMessage('auth-success', 'Login com Google realizado! Entrando…');
    setTimeout(() => { window.location.href = 'dashboard.html'; }, 600);
  } catch (err) {
    const msgs = {
      'auth/operation-not-allowed': 'Ative o provedor Google no Firebase Authentication.',
      'auth/unauthorized-domain': 'Domínio não autorizado. Adicione seu domínio em Authentication → Settings.',
      'auth/popup-blocked': 'Pop-up bloqueado. Permita pop-ups para este site.',
      'auth/popup-closed-by-user': 'Login cancelado.',
      'auth/account-exists-with-different-credential': 'Este e-mail já está cadastrado com outro método de login.',
    };
    showMessage('auth-error', msgs[err.code] || 'Erro ao entrar com Google. Tente novamente.');
  }
}

function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('login-form').style.display = isLogin ? 'flex' : 'none';
  document.getElementById('register-form').style.display = isLogin ? 'none' : 'flex';
  document.getElementById('auth-title').textContent = isLogin ? 'Bem-vindo de volta' : 'Criar conta';
  document.getElementById('auth-subtitle').textContent = isLogin ? 'Acesse sua conta para ver o painel' : 'Preencha os dados para começar';
  clearMessages(); clearErrors();
}

async function handleLogin(e) {
  e.preventDefault(); clearMessages(); clearErrors();
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-password').value;
  let valid = true;
  if (!email || !/\S+@\S+\.\S+/.test(email)) { showError('err-login-email', 'E-mail inválido'); valid = false; }
  if (!pass || pass.length < 6) { showError('err-login-password', 'Senha muito curta'); valid = false; }
  if (!valid) return;
  setLoading('btn-login', true);
  try {
    const cred = await auth.signInWithEmailAndPassword(email, pass);
    const user = cred.user;
    if (user && user.email && !user.emailVerified) {
      try { await user.sendEmailVerification(); } catch { }
      await auth.signOut();
      setLoading('btn-login', false);
      showMessage('auth-error', 'Seu e-mail ainda não foi verificado. Enviamos um novo link para sua caixa de entrada.');
      return;
    }
    // FIX 2: resetar botão antes do redirect (via onAuthStateChanged)
    setLoading('btn-login', false);
  } catch (err) {
    setLoading('btn-login', false);
    const msgs = {
      'auth/user-not-found': 'Nenhuma conta com este e-mail.',
      'auth/wrong-password': 'Senha incorreta.',
      'auth/too-many-requests': 'Muitas tentativas. Aguarde.',
      'auth/invalid-credential': 'E-mail ou senha incorretos.',
      'auth/user-disabled': 'Esta conta foi desativada.',
    };
    showMessage('auth-error', msgs[err.code] || 'Erro ao entrar. Tente novamente.');
  }
}

async function handleRegister(e) {
  e.preventDefault(); clearMessages(); clearErrors();
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;
  let valid = true;
  if (!name || name.length < 2) { showError('err-reg-name', 'Digite seu nome completo'); valid = false; }
  if (!email || !/\S+@\S+\.\S+/.test(email)) { showError('err-reg-email', 'E-mail inválido'); valid = false; }
  if (!pass || pass.length < 6) { showError('err-reg-password', 'Mínimo 6 caracteres'); valid = false; }
  if (pass !== confirm) { showError('err-reg-confirm', 'As senhas não coincidem'); valid = false; }
  if (!valid) return;

  isRegistering = true;
  setLoading('btn-register', true);
  try {
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });
    try { await cred.user.sendEmailVerification(); } catch { }
    const uid = cred.user.uid;
    const now = Date.now();

    const updates = {};

    // Perfil do usuário
    updates[`users/${uid}/name`] = name;
    updates[`users/${uid}/email`] = email;
    updates[`users/${uid}/plan`] = 'free';
    updates[`users/${uid}/created_at`] = now;
    updates[`users/${uid}/updated_at`] = now;
    updates[`users/${uid}/settings/timezone`] = 'America/Sao_Paulo';
    updates[`users/${uid}/settings/units/volume`] = 'L';
    updates[`users/${uid}/settings/units/flow`] = 'L/min';

    // Metas padrão (goals — sem notificações)
    updates[`goals/${uid}/daily_l`] = 175;
    updates[`goals/${uid}/weekly_l`] = 1225;
    updates[`goals/${uid}/monthly_l`] = 5250;
    updates[`goals/${uid}/leak_min`] = 30;
    updates[`goals/${uid}/leak_lpm`] = 0.5;

    // Preferências separadas (preferences — sem dados de consumo)
    updates[`preferences/${uid}/notify/push`] = true;
    updates[`preferences/${uid}/notify/email`] = true;
    updates[`preferences/${uid}/notify/leak`] = true;
    updates[`preferences/${uid}/notify/goal`] = true;

    await rtdb.ref().update(updates);
    await auth.signOut();

    // FIX 1: resetar isRegistering após cadastro bem-sucedido,
    // caso o usuário faça login na mesma sessão de página.
    isRegistering = false;
    setLoading('btn-register', false);

    showMessage('auth-success', 'Conta criada! Enviamos um e-mail de verificação. Confirme e depois faça login.');
  } catch (err) {
    isRegistering = false;
    setLoading('btn-register', false);
    const msgs = {
      'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
      'auth/weak-password': 'Senha muito fraca.',
      'auth/invalid-email': 'E-mail inválido.',
    };
    showMessage('auth-error', msgs[err.code] || 'Erro ao criar conta. Tente novamente.');
  }
}

function checkStrength(val) {
  const wrap = document.getElementById('pass-strength');
  const fill = document.getElementById('strength-fill');
  const lbl = document.getElementById('strength-label');
  if (!val) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  let s = 0;
  if (val.length >= 6) s++; if (val.length >= 10) s++;
  if (/[A-Z]/.test(val)) s++; if (/[0-9]/.test(val)) s++; if (/[^A-Za-z0-9]/.test(val)) s++;
  const lvls = [
    { pct: '16%', color: '#ef4444', text: 'Muito fraca' }, { pct: '33%', color: '#f97316', text: 'Fraca' },
    { pct: '50%', color: '#f59e0b', text: 'Razoável' }, { pct: '75%', color: '#3b82f6', text: 'Boa' },
    { pct: '100%', color: '#10b981', text: 'Muito forte' },
  ];
  const lvl = lvls[Math.max(0, s - 1)];
  fill.style.width = lvl.pct; fill.style.background = lvl.color;
  lbl.textContent = lvl.text; lbl.style.color = lvl.color;
}

function togglePass(id, btn) {
  const input = document.getElementById(id);
  if (!input || !btn) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = show
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
}

function setLoading(id, v) {
  const b = document.getElementById(id);
  if (!b) return;
  b.disabled = v;
  const t = b.querySelector('.btn-text');
  const s = b.querySelector('.btn-spinner');
  if (t) t.style.display = v ? 'none' : 'inline';
  if (s) s.style.display = v ? 'inline-block' : 'none';
}
function showError(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
function clearErrors() { document.querySelectorAll('.field-error').forEach(el => { el.style.display = 'none'; el.textContent = ''; }); }
function showMessage(id, msg) { const el = document.getElementById(id); el.textContent = msg; el.style.display = 'block'; }
function clearMessages() { ['auth-error', 'auth-success'].forEach(id => { const el = document.getElementById(id); el.style.display = 'none'; el.textContent = ''; }); }