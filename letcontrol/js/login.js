/**
 * login.js — UI interactions for the login/register page.
 * Depends on: auth.js (handleLogin, handleRegister, handleGoogleLogin)
 */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Logo fallback ─────────────────────────────────── */
  const logoImg      = document.getElementById('auth-logo-img');
  const brandFallback = document.getElementById('auth-brand-fallback');

  if (logoImg) {
    logoImg.addEventListener('error', () => {
      logoImg.style.display = 'none';
      if (brandFallback) brandFallback.style.display = 'flex';
    });
  }

  /* ── Tab switching ─────────────────────────────────── */
  // switchTab() é definida em auth.js (é quem sabe restaurar o painel de
  // "esqueci minha senha" também). Não redeclarar aqui — uma versão local
  // chegou a existir e, por causa da ordem de carregamento, sobrescrevia
  // window.switchTab bem depois de auth.js já ter definido a de verdade.
  const tabs = document.querySelectorAll('.auth-tab');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  /* ── Form submissions ──────────────────────────────── */
  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  document.getElementById('forgot-form')?.addEventListener('submit', handleForgotPassword);

  /* ── Esqueci minha senha ────────────────────────────── */
  document.getElementById('link-forgot-password')?.addEventListener('click', showForgotPanel);
  document.getElementById('link-back-to-login')?.addEventListener('click', () => switchTab('login'));

  /* ── Google buttons ────────────────────────────────── */
  document.getElementById('btn-google-login').addEventListener('click', handleGoogleLogin);
  document.getElementById('btn-google-register').addEventListener('click', handleGoogleLogin);

  /* ── Toggle password visibility ────────────────────── */
  document.querySelectorAll('.toggle-pass').forEach(btn => {
    btn.addEventListener('click', () => togglePass(btn.dataset.target, btn));
  });

  /* ── Password strength meter ───────────────────────── */
  const regPasswordInput = document.getElementById('reg-password');
  if (regPasswordInput) {
    regPasswordInput.addEventListener('input', e => checkStrength(e.target.value));
  }

});

/* ── Painel "esqueci minha senha" ────────────────────── */
function showForgotPanel() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('register-form').style.display = 'none';
  document.getElementById('forgot-form').style.display = 'flex';
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.style.display = 'none';
  document.getElementById('auth-title').textContent = 'Redefinir senha';
  document.getElementById('auth-subtitle').textContent = 'Vamos te ajudar a recuperar o acesso';
  clearMessages();
  document.getElementById('forgot-email')?.focus();
}
window.showForgotPanel = showForgotPanel;

/* ── Toggle password field type ─────────────────────── */
function togglePass(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const isPassword = input.type === 'password';
  input.type = isPassword ? 'text' : 'password';

  btn.innerHTML = isPassword
    ? `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
         <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
         <line x1="1" y1="1" x2="23" y2="23"/>
       </svg>`
    : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
         <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
         <circle cx="12" cy="12" r="3"/>
       </svg>`;
}

/* ── Password strength check ─────────────────────────── */
function checkStrength(value) {
  const bar    = document.getElementById('pass-strength');
  const fill   = document.getElementById('strength-fill');
  const label  = document.getElementById('strength-label');

  if (!bar || !fill || !label) return;

  if (!value) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'flex';

  let score = 0;
  if (value.length >= 6)  score++;
  if (value.length >= 10) score++;
  if (/[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;

  const levels = [
    { pct: '20%', color: '#ef4444', text: 'Muito fraca' },
    { pct: '40%', color: '#f97316', text: 'Fraca'       },
    { pct: '60%', color: '#eab308', text: 'Razoável'    },
    { pct: '80%', color: '#3b82f6', text: 'Forte'       },
    { pct: '100%',color: '#10b981', text: 'Muito forte' },
  ];

  const level = levels[Math.min(score - 1, 4)] || levels[0];
  fill.style.width      = level.pct;
  fill.style.background = level.color;
  label.textContent     = level.text;
  label.style.color     = level.color;
}

/* ── Clear error/success messages ────────────────────── */
function clearMessages() {
  const error   = document.getElementById('auth-error');
  const success = document.getElementById('auth-success');
  if (error)   { error.style.display   = 'none'; error.textContent   = ''; }
  if (success) { success.style.display = 'none'; success.textContent = ''; }
}