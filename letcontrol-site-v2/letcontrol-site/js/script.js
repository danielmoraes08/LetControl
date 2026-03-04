/**
 * js/script.js
 * Lógica da landing page: FAQ accordion e scroll reveal.
 * Usado em: index.html
 */

// ── FAQ TOGGLE ────────────────────────────────────────────────────
function toggleQ(box) {
  const isOpen = box.classList.contains('open');
  document.querySelectorAll('.question-box.open').forEach(b => b.classList.remove('open'));
  if (!isOpen) box.classList.add('open');
}

// ── SCROLL REVEAL ─────────────────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      revealObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));
