/**
 * js/auth.js
 */

let isRegistering = false; // ← flag para segurar o redirect durante cadastro

// Redirecionar se já está logado
auth.onAuthStateChanged((user) => {
  if (user && !isRegistering) {
    window.location.href = 'dashboard.html';
  }
});

// ── TABS ─────────────────────────────────────────────────────────
function switchTab(tab) {
  const isLogin = tab === 'login';
  document.getElementById('tab-login').classList.toggle('active', isLogin);
  document.getElementById('tab-register').classList.toggle('active', !isLogin);
  document.getElementById('login-form').style.display    = isLogin ? 'flex' : 'none';
  document.getElementById('register-form').style.display = isLogin ? 'none' : 'flex';
  document.getElementById('auth-title').textContent    = isLogin ? 'Bem-vindo de volta' : 'Criar sua conta';
  document.getElementById('auth-subtitle').textContent = isLogin ? 'Acesse sua conta para ver o painel' : 'Preencha os dados para começar';
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
  const btn     = document.getElementById(btnId);
  const text    = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btn.disabled          = loading;
  text.style.display    = loading ? 'none' : 'inline';
  spinner.style.display = loading ? 'inline-block' : 'none';
}

// ── MOSTRAR / OCULTAR SENHA ───────────────────────────────────────
function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  const isPass = input.type === 'password';
  input.type = isPass ? 'text' : 'password';
  btn.querySelector('svg').style.opacity = isPass ? '.5' : '1';
}

// ── FORÇA DA SENHA ────────────────────────────────────────────────
document.getElementById('reg-password')?.addEventListener('input', function () {
  const val   = this.value;
  const wrap  = document.getElementById('pass-strength');
  const fill  = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
  if (!val) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'flex';
  let score = 0;
  if (val.length >= 6)           score++;
  if (val.length >= 10)          score++;
  if (/[A-Z]/.test(val))         score++;
  if (/[0-9]/.test(val))         score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const levels = [
    { pct: '20%',  color: '#ef4444', text: 'Muito fraca'  },
    { pct: '40%',  color: '#f97316', text: 'Fraca'        },
    { pct: '60%',  color: '#f59e0b', text: 'Moderada'     },
    { pct: '80%',  color: '#10b981', text: 'Forte'        },
    { pct: '100%', color: '#0AA1FF', text: 'Muito forte'  },
  ];
  const lvl = levels[Math.min(score - 1, 4)] || levels[0];
  fill.style.width      = lvl.pct;
  fill.style.background = lvl.color;
  label.textContent     = lvl.text;
  label.style.color     = lvl.color;
});

// ── LOGIN ─────────────────────────────────────────────────────────
async function handleLogin(e) {
  e.preventDefault();
  clearMessages();
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-password').value;
  let valid = true;
  if (!email) { showFieldError('err-login-email', 'Informe o e-mail'); valid = false; }
  if (!pass)  { showFieldError('err-login-password', 'Informe a senha'); valid = false; }
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
  if (!name)            { showFieldError('err-reg-name',     'Informe seu nome');         valid = false; }
  if (!email)           { showFieldError('err-reg-email',    'Informe o e-mail');          valid = false; }
  if (pass.length < 6)  { showFieldError('err-reg-password', 'Mínimo de 6 caracteres');  valid = false; }
  if (pass !== confirm) { showFieldError('err-reg-confirm',  'As senhas não coincidem');  valid = false; }
  if (!valid) return;

  setLoading('btn-register', true);
  isRegistering = true; // ← segura o redirect do onAuthStateChanged

  try {
    // 1. Cria a conta no Firebase Auth
    const cred = await auth.createUserWithEmailAndPassword(email, pass);

    // 2. Atualiza o nome do perfil
    await cred.user.updateProfile({ displayName: name });

    // 3. Salva o documento no Firestore (agora sem ser interrompido)
    await db.collection('users').doc(cred.user.uid).set({
      name,
      email,
      notification_prefs: { push: true, sms: false, email: true },
      plan: 'free',
      created_at: firebase.firestore.FieldValue.serverTimestamp(),
    });

    showSuccess('Conta criada com sucesso! Redirecionando...');

    // 4. Só redireciona depois que tudo foi salvo
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