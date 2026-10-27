// ── SCROLL REVEAL ─────────────────────────────────────────────
const revealObserver = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('visible'); revealObserver.unobserve(e.target); }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -48px 0px' });
document.querySelectorAll('.reveal').forEach(el => revealObserver.observe(el));

// ── NAV SCROLL → fundo branco sólido ao rolar ─────────────────
const nav = document.getElementById('main-nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 30);
}, { passive: true });

// ── HAMBURGER MOBILE ──────────────────────────────────────────
const hamburger  = document.getElementById('nav-hamburger');
const mobileMenu = document.getElementById('mobile-menu');
if (hamburger && mobileMenu) {
  hamburger.addEventListener('click', () => {
    const open = mobileMenu.classList.toggle('open');
    hamburger.classList.toggle('open', open);
    hamburger.setAttribute('aria-expanded', String(open));
  });
  mobileMenu.querySelectorAll('a').forEach(a => {
    a.addEventListener('click', () => {
      mobileMenu.classList.remove('open');
      hamburger.classList.remove('open');
      hamburger.setAttribute('aria-expanded', 'false');
    });
  });
}

// ── FAQ ───────────────────────────────────────────────────────
function toggleFaq(item) {
  const wasOpen = item.classList.contains('open');
  document.querySelectorAll('.faq-item.open').forEach(i => i.classList.remove('open'));
  if (!wasOpen) item.classList.add('open');
}

// ── STAT COUNTER ──────────────────────────────────────────────
const statObserver = new IntersectionObserver(entries => {
  entries.forEach(e => {
    if (!e.isIntersecting) return;
    const el    = e.target.querySelector('.stat-number');
    if (!el) return;
    const text  = el.textContent.trim();
    const match = text.match(/^([\d.]+)(.*)$/);
    if (!match) return;
    const target = parseFloat(match[1]);
    const suffix = match[2];
    const isFloat = text.includes('.');
    const dur = 1300, start = performance.now();
    const tick = now => {
      const t    = Math.min((now - start) / dur, 1);
      const ease = 1 - Math.pow(1 - t, 3);
      el.textContent = (isFloat ? (target * ease).toFixed(1) : Math.round(target * ease)) + suffix;
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    statObserver.unobserve(e.target);
  });
}, { threshold: 0.5 });
document.querySelectorAll('.stat-item').forEach(el => statObserver.observe(el));

// ── HERO VIDEO ────────────────────────────────────────────────
(function () {
  const v = document.getElementById('hero-video');
  if (!v) return;
  const ready = () => v.classList.add('is-ready');
  v.addEventListener('loadeddata', ready, { once: true });
  v.addEventListener('canplay',    ready, { once: true });
  new IntersectionObserver(entries => {
    entries.forEach(e => { e.isIntersecting ? v.play().catch(()=>{}) : v.pause(); });
  }, { threshold: 0.15 }).observe(v);
}());

// ── SHOWCASE VIDEO ────────────────────────────────────────────
(function () {
  const video    = document.getElementById('showcase-video');
  const playBtn  = document.getElementById('video-play-btn');
  const loader   = document.getElementById('video-loader');
  const fallback = document.getElementById('video-fallback');
  const iconPlay  = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  if (!video) return;

  function setLoader(show) {
    if (!loader) return;
    loader.classList.toggle('hidden', !show);
  }

  function setPlaying(playing) {
    if (iconPlay)  iconPlay.style.display  = playing ? 'none'  : 'block';
    if (iconPause) iconPause.style.display = playing ? 'block' : 'none';
    if (playBtn)   playBtn.classList.toggle('playing', playing);
  }

  // Esconde loader quando vídeo estiver pronto
  function onReady() { setLoader(false); }
  video.addEventListener('loadeddata', onReady, { once: true });
  video.addEventListener('canplay',    onReady, { once: true });
  // Se já carregado antes do evento
  if (video.readyState >= 3) setLoader(false);

  video.addEventListener('waiting', () => setLoader(true));
  video.addEventListener('playing', () => { setLoader(false); setPlaying(true); });
  video.addEventListener('pause',   () => setPlaying(false));
  video.addEventListener('ended',   () => setPlaying(false));

  video.addEventListener('error', () => {
    setLoader(false);
    if (fallback) { fallback.style.display = 'flex'; }
    if (playBtn)  { playBtn.style.display  = 'none'; }
  });

  // Clique no botão play/pause
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (video.paused) {
        setLoader(true);
        video.play().catch(() => {
          setLoader(false);
          if (fallback) fallback.style.display = 'flex';
          playBtn.style.display = 'none';
        });
      } else {
        video.pause();
      }
    });
  }

  // Auto-play quando a section entrar na viewport
  const shell = document.getElementById('video-shell');
  if (shell) {
    new IntersectionObserver(entries => {
      entries.forEach(e => {
        if (e.isIntersecting && video.paused) {
          video.play().catch(() => {});
        } else if (!e.isIntersecting && !video.paused) {
          video.pause();
        }
      });
    }, { threshold: 0.4 }).observe(shell);
  }
}());

// ── SMOOTH SCROLL COM OFFSET ──────────────────────────────────
document.querySelectorAll('a[href^="#"]').forEach(link => {
  link.addEventListener('click', e => {
    const id = link.getAttribute('href').slice(1);
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;
    e.preventDefault();
    window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 80, behavior: 'smooth' });
  });
});

// ── PWA: SERVICE WORKER ───────────────────────────────────────
// index.html vive na raiz do site, então "sw.js" já é o escopo certo.
// Sem SW registrado o Chrome não oferece a instalação.
// Em dev local o SW só atrapalha (cache-first de arquivos que acabaram de
// mudar) — não registra em localhost/127.0.0.1, só em produção. Ver o
// mesmo guard em dashboard.js.
const isLocalDev = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.hostname.endsWith('.local');
if ('serviceWorker' in navigator && isLocalDev) {
  navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => { });
} else if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' })
      .catch(e => console.warn('SW falhou:', e?.message));
  });
}

// ── PWA: BOTÃO "INSTALAR APP" ─────────────────────────────────
// O Chrome dispara beforeinstallprompt só quando os critérios de
// instalação estão OK (manifest válido + ícone quadrado ≥192 + SW +
// HTTPS). Guardamos o evento e mostramos o botão; sem ele, o botão
// fica escondido e o usuário usa o menu do navegador.
(function pwaInstall() {
  const btn = document.getElementById('btn-install-pwa');
  const mobileBtn = document.getElementById('mobile-install-pwa');
  if (!btn && !mobileBtn) return;

  let deferredPrompt = null;
  // Classe, não style inline: a media query de mobile precisa poder
  // esconder o botão da nav (lá ele aparece no menu hambúrguer).
  const show = on => {
    if (btn) btn.classList.toggle('is-visible', on);
    if (mobileBtn) mobileBtn.classList.toggle('is-visible', on);
  };

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    show(true);
  });

  const install = async e => {
    e.preventDefault();
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') show(false);
    deferredPrompt = null; // o evento é de uso único
  };
  if (btn) btn.addEventListener('click', install);
  if (mobileBtn) mobileBtn.addEventListener('click', install);

  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    show(false);
  });

  // Já instalado (aberto em janela standalone) → nunca mostra o botão
  if (window.matchMedia('(display-mode: standalone)').matches || navigator.standalone) {
    show(false);
  }
})();
