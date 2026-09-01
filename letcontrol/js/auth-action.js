/**
 * auth-action.js — trata os links de ação do Firebase Auth (redefinir
 * senha, verificar e-mail) numa página com a cara do LetControl, em vez
 * da página genérica que o Firebase mostraria por padrão.
 *
 * O Firebase manda o usuário pra cá com ?mode=...&oobCode=... — esse
 * código (oobCode) é o que autoriza a ação; ele é de uso único e expira.
 */

const params = new URLSearchParams(window.location.search);
const mode = params.get('mode');
const oobCode = params.get('oobCode');

const elTitle = document.getElementById('action-title');
const elSubtitle = document.getElementById('action-subtitle');

function showPanel(id) {
  ['panel-loading', 'panel-reset-password', 'panel-done'].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.style.display = 'none';
  });
  const el = document.getElementById(id);
  if (el) el.style.display = id === 'panel-loading' ? 'flex' : (id === 'panel-reset-password' ? 'flex' : 'block');
}

function showError(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
function clearErrors() { document.querySelectorAll('.field-error').forEach(el => { el.style.display = 'none'; el.textContent = ''; }); }
function showMessage(id, msg) { const el = document.getElementById(id); if (el) { el.textContent = msg; el.style.display = 'block'; } }
function clearMessages() { ['auth-error', 'auth-success'].forEach(id => { const el = document.getElementById(id); if (el) { el.style.display = 'none'; el.textContent = ''; } }); }
function setLoading(id, v) {
  const b = document.getElementById(id);
  if (!b) return;
  b.disabled = v;
  const t = b.querySelector('.btn-text');
  const s = b.querySelector('.btn-spinner');
  if (t) t.style.display = v ? 'none' : 'inline';
  if (s) s.style.display = v ? 'inline-block' : 'none';
}

/* ── Logo fallback ─────────────────────────────────── */
const logoImg = document.getElementById('auth-logo-img');
if (logoImg) {
  logoImg.addEventListener('error', () => {
    logoImg.style.display = 'none';
    const fb = document.getElementById('auth-brand-fallback');
    if (fb) fb.style.display = 'flex';
  });
}

/* ── Mostrar/ocultar senha ──────────────────────────── */
document.querySelectorAll('.toggle-pass').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    input.type = input.type === 'password' ? 'text' : 'password';
  });
});

/* ── Força da senha ──────────────────────────────────── */
function checkStrength(value) {
  const bar = document.getElementById('pass-strength');
  const fill = document.getElementById('strength-fill');
  const label = document.getElementById('strength-label');
  if (!bar || !fill || !label) return;
  if (!value) { bar.style.display = 'none'; return; }
  bar.style.display = 'flex';
  let score = 0;
  if (value.length >= 6) score++;
  if (value.length >= 10) score++;
  if (/[A-Z]/.test(value)) score++;
  if (/[0-9]/.test(value)) score++;
  if (/[^A-Za-z0-9]/.test(value)) score++;
  const levels = [
    { pct: '20%', color: '#ef4444', text: 'Muito fraca' },
    { pct: '40%', color: '#f97316', text: 'Fraca' },
    { pct: '60%', color: '#eab308', text: 'Razoável' },
    { pct: '80%', color: '#3b82f6', text: 'Forte' },
    { pct: '100%', color: '#10b981', text: 'Muito forte' },
  ];
  const level = levels[Math.min(score - 1, 4)] || levels[0];
  fill.style.width = level.pct;
  fill.style.background = level.color;
  label.textContent = level.text;
  label.style.color = level.color;
}
document.getElementById('new-password')?.addEventListener('input', e => checkStrength(e.target.value));

/* ── Fluxo principal ─────────────────────────────────── */
async function init() {
  if (!mode || !oobCode) {
    elTitle.textContent = 'Link inválido';
    elSubtitle.textContent = 'Este link está incompleto ou não é reconhecido.';
    showMessage('auth-error', 'Verifique se copiou o link inteiro do e-mail, ou solicite um novo.');
    showPanel('panel-done');
    return;
  }

  if (mode === 'resetPassword') {
    try {
      const email = await auth.verifyPasswordResetCode(oobCode);
      elTitle.textContent = 'Crie uma nova senha';
      elSubtitle.textContent = `Redefinindo a senha de ${email}`;
      showPanel('panel-reset-password');
    } catch {
      elTitle.textContent = 'Link expirado';
      elSubtitle.textContent = 'Este link de redefinição não é mais válido.';
      showMessage('auth-error', 'Solicite um novo link em "Esqueci minha senha" na tela de login.');
      showPanel('panel-done');
    }
    return;
  }

  if (mode === 'verifyEmail') {
    try {
      await auth.applyActionCode(oobCode);
      elTitle.textContent = 'E-mail confirmado!';
      elSubtitle.textContent = 'Sua conta já está verificada.';
      showMessage('auth-success', 'Tudo certo — você já pode fazer login normalmente.');
    } catch {
      elTitle.textContent = 'Link inválido';
      elSubtitle.textContent = 'Este link de verificação não é mais válido.';
      showMessage('auth-error', 'Faça login novamente para receber um novo e-mail de verificação.');
    }
    showPanel('panel-done');
    return;
  }

  // recoverEmail e outros modos não usados por este app hoje
  elTitle.textContent = 'Link não suportado';
  elSubtitle.textContent = 'Esse tipo de ação não é tratado por aqui.';
  showMessage('auth-error', 'Volte para a tela de login.');
  showPanel('panel-done');
}

document.getElementById('panel-reset-password')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearErrors(); clearMessages();
  const pass = document.getElementById('new-password').value;
  const confirm = document.getElementById('new-password-confirm').value;
  let valid = true;
  if (!pass || pass.length < 6) { showError('err-new-password', 'Mínimo 6 caracteres'); valid = false; }
  if (pass !== confirm) { showError('err-new-password-confirm', 'As senhas não coincidem'); valid = false; }
  if (!valid) return;

  setLoading('btn-confirm-reset', true);
  try {
    await auth.confirmPasswordReset(oobCode, pass);
    setLoading('btn-confirm-reset', false);
    elTitle.textContent = 'Senha alterada!';
    elSubtitle.textContent = 'Sua nova senha já está ativa.';
    showMessage('auth-success', 'Pronto! Você já pode entrar com a nova senha.');
    showPanel('panel-done');
  } catch (err) {
    setLoading('btn-confirm-reset', false);
    const msgs = {
      'auth/expired-action-code': 'Este link expirou. Solicite um novo.',
      'auth/invalid-action-code': 'Este link já foi usado ou é inválido.',
      'auth/weak-password': 'Senha muito fraca.',
    };
    showMessage('auth-error', msgs[err.code] || 'Erro ao redefinir a senha. Tente novamente.');
  }
});

init();
