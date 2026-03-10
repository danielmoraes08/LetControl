/**
 * js/auth.js
 * Login e Cadastro — Firebase Auth + Realtime Database
 */

let isRegistering = false;

// Redireciona se já está logado
auth.onAuthStateChanged((user) => {
  if (user && !isRegistering) {
    window.location.href = 'dashboard.html';
  }
});

// ── TABS ──────────────────────────────────────────────────────────
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('login-form').style.display    = isLogin ? 'flex' : 'none';
  document.getElementById('register-form').style.display = isLogin ? 'none' : 'flex';
  document.getElementById('auth-title').textContent    = isLogin ? 'Bem-vindo de volta' : 'Criar sua conta';
  document.getElementById('auth-subtitle').textContent = isLogin
    ? 'Acesse sua conta para ver o painel'
    : 'Preencha os dados para começar';
  clearMessages();
}

// ── MENSAGENS ─────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
  document.getElementById('auth-success').style.display = 'none';
}
function showSuccess(msg) {
  const el = document.getElementById('auth-success');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
  document.getElementById('auth-error').style.display = 'none';
}
function showFieldError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.style.display = msg ? 'block' : 'none'; }
}
function clearMessages() {
  showError(''); showSuccess('');
  document.querySelectorAll('.field-error').forEach(el => {
    el.textContent = ''; el.style.display = 'none';
  });
}

// ── LOADING ───────────────────────────────────────────────────────
function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  const text = btn.querySelector('.btn-text');
  const spin = btn.querySelector('.btn-spinner');
  if (text) text.style.display = loading ? 'none' : 'inline';
  if (spin) spin.style.display = loading ? 'inline-block' : 'none';
}

// ── TOGGLE SENHA ──────────────────────────────────────────────────
function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input || !btn) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  const icon = btn.querySelector('svg');
  if (icon) icon.style.opacity = input.type === 'text' ? '.5' : '1';
}

// ── FORÇA DA SENHA ────────────────────────────────────────────────
document.getElementById('reg-password')?.addEventListener('input', function () {
  const val = this.value;
  const wrap = document.getElementById('pass-strength');
  const fill = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
  if (!val) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  let score = 0;
  if (val.length >= 6)            score++;
  if (val.length >= 10)           score++;
  if (/[A-Z]/.test(val))          score++;
  if (/[0-9]/.test(val))          score++;
  if (/[^A-Za-z0-9]/.test(val))   score++;
  const levels = [
    { pct: '20%',  color: '#ef4444', text: 'Muito fraca' },
    { pct: '40%',  color: '#f97316', text: 'Fraca' },
    { pct: '60%',  color: '#f59e0b', text: 'Moderada' },
    { pct: '80%',  color: '#10b981', text: 'Forte' },
    { pct: '100%', color: '#0AA1FF', text: 'Muito forte' },
  ];
  const lvl = levels[Math.min(score - 1, 4)] || levels[0];
  fill.style.width = lvl.pct;
  fill.style.background = lvl.color;
  label.textContent = lvl.text;
  label.style.color = lvl.color;
});

// ── LOGIN COM GOOGLE ──────────────────────────────────────────────
async function handleGoogleLogin() {
  clearMessages();
  const btn = document.getElementById('btn-google');
  if (btn) btn.disabled = true;
  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    const result = await auth.signInWithPopup(provider);
    const user = result.user;
    const userRef = rtdb.ref(`users/${user.uid}`);
    const snap = await userRef.once('value');
    if (!snap.exists()) {
      await userRef.set({
        name: user.displayName || user.email?.split('@')[0] || 'Usuário',
        email: user.email || '',
        plan: 'free',
        notifications: { push: true, email: true },
        created_at: Date.now(),
      });
    }
    showSuccess('Login realizado! Redirecionando...');
    setTimeout(() => { window.location.href = 'dashboard.html'; }, 800);
  } catch (err) {
    const msgs = {
      'auth/popup-closed-by-user': 'Login cancelado.',
      'auth/popup-blocked': 'Pop-up bloqueado. Permita pop-ups para este site.',
      'auth/cancelled-popup-request': 'Login cancelado.',
      'auth/account-exists-with-different-credential': 'Este e-mail já está cadastrado com outro método de login.',
    };
    showError(msgs[err.code] || 'Erro ao entrar com Google. Tente novamente.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── LOGIN ─────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  clearMessages();
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  let valid = true;
  if (!email) { showFieldError('err-login-email',    'Informe o e-mail'); valid = false; }
  if (!pass)  { showFieldError('err-login-password', 'Informe a senha');  valid = false; }
  if (!valid) return;

  setLoading('btn-login', true);
  try {
    await auth.signInWithEmailAndPassword(email, pass);
    // onAuthStateChanged redireciona automaticamente
  } catch (err) {
    const msgs = {
      'auth/user-not-found':     'Nenhuma conta com este e-mail.',
      'auth/wrong-password':     'Senha incorreta.',
      'auth/invalid-email':      'E-mail inválido.',
      'auth/user-disabled':      'Esta conta foi desativada.',
      'auth/too-many-requests':  'Muitas tentativas. Aguarde alguns minutos.',
      'auth/invalid-credential': 'E-mail ou senha incorretos.',
    };
    showError(msgs[err.code] || 'Erro ao entrar. Tente novamente.');
  } finally {
    setLoading('btn-login', false);
  }
}

// ── CADASTRO ──────────────────────────────────────────────────────
async function handleRegister(e) {
  e.preventDefault();
  clearMessages();
  const name    = document.getElementById('reg-name').value.trim();
  const email   = document.getElementById('reg-email').value.trim();
  const pass    = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;

  let valid = true;
  if (!name)            { showFieldError('err-reg-name',     'Informe seu nome');        valid = false; }
  if (!email)           { showFieldError('err-reg-email',    'Informe o e-mail');        valid = false; }
  if (pass.length < 6)  { showFieldError('err-reg-password', 'Mínimo de 6 caracteres'); valid = false; }
  if (pass !== confirm) { showFieldError('err-reg-confirm',  'As senhas não coincidem'); valid = false; }
  if (!valid) return;

  setLoading('btn-register', true);
  isRegistering = true;

  try {
    // 1. Cria conta no Firebase Auth
    const cred = await auth.createUserWithEmailAndPassword(email, pass);
    await cred.user.updateProfile({ displayName: name });

    // 2. Salva perfil no Realtime Database
    //    Caminho: /users/{uid}
    await rtdb.ref(`users/${cred.user.uid}`).set({
      name,
      email,
      plan: 'free',
      notifications: { push: true, email: true },
      created_at: Date.now(),
    });

    showSuccess('Conta criada com sucesso! Redirecionando...');

    setTimeout(() => {
      isRegistering = false;
      window.location.href = 'dashboard.html';
    }, 1000);

  } catch (err) {
    isRegistering = false;
    const msgs = {
      'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
      'auth/invalid-email':        'E-mail inválido.',
      'auth/weak-password':        'Senha muito fraca.',
    };
    showError(msgs[err.code] || 'Erro ao criar conta. Tente novamente.');
  } finally {
    setLoading('btn-register', false);
  }
}
