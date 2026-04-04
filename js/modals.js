// ── MODAL: ABRIR / FECHAR ─────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeModal(id) {
  const m = document.getElementById(id);
  if (!m) return;
  m.classList.remove('open');
  document.body.style.overflow = '';
}

// Fechar ao clicar no overlay
document.querySelectorAll('.page-modal').forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) closeModal(m.id); });
});

// Fechar com Escape
document.addEventListener('keydown', e => {
  if (e.key === 'Escape')
    document.querySelectorAll('.page-modal.open').forEach(m => closeModal(m.id));
});

// ── TOAST ─────────────────────────────────────────────────────
function showToast(msg) {
  const t = document.getElementById('global-toast');
  document.getElementById('toast-message').textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3500);
}

// ── FORMULÁRIO: CONTATO ───────────────────────────────────────
function sendContactEmail() {
  const name    = document.getElementById('c-name').value.trim();
  const email   = document.getElementById('c-email').value.trim();
  const subject = document.getElementById('c-subject').value;
  const message = document.getElementById('c-message').value.trim();
  if (!name || !email || !subject || !message) {
    showToast('⚠️ Preencha todos os campos.');
    return;
  }
  const body = encodeURIComponent('Nome: ' + name + '\nE-mail: ' + email + '\n\n' + message);
  const sub  = encodeURIComponent('[LetControl] ' + subject);
  window.location.href = 'mailto:letcontrol.contact@gmail.com?subject=' + sub + '&body=' + body;
  showToast('✓ Cliente de e-mail aberto!');
}

// ── FORMULÁRIO: REPORTAR ERRO ─────────────────────────────────
function sendBugReport() {
  const name  = document.getElementById('r-name').value.trim();
  const email = document.getElementById('r-email').value.trim();
  const where = document.getElementById('r-where').value;
  const desc  = document.getElementById('r-desc').value.trim();
  const sev   = document.querySelector('input[name="severity"]:checked');
  if (!name || !email || !where || !desc) {
    showToast('⚠️ Preencha todos os campos.');
    return;
  }
  const body = encodeURIComponent(
    'Nome: ' + name +
    '\nE-mail: ' + email +
    '\nGravidade: ' + (sev ? sev.value : 'não informada') +
    '\nÁrea: ' + where +
    '\n\nDescrição:\n' + desc
  );
  window.location.href =
    'mailto:letcontrol.contact@gmail.com?subject=' +
    encodeURIComponent('[LetControl] Relatório de erro') +
    '&body=' + body;
  showToast('✓ Relatório enviado — obrigado!');
}

// ── NEWSLETTER ────────────────────────────────────────────────
function handleNewsletter() {
  const input = document.getElementById('newsletter-email');
  const email = input ? input.value.trim() : '';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('⚠️ Digite um e-mail válido.');
    return;
  }
  const body = encodeURIComponent(
    'Novo cadastro na newsletter LetControl.\nE-mail: ' + email
  );
  window.location.href =
    'mailto:letcontrol.contact@gmail.com?subject=' +
    encodeURIComponent('[LetControl] Newsletter — novo cadastro') +
    '&body=' + body;
  const success = document.getElementById('newsletter-success');
  if (success) success.style.display = 'flex';
  if (input) input.value = '';
}