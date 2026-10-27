/* LetControl — Service Worker (PWA shell + offline básico) */
const CACHE = 'letcontrol-v19';
// Paths relativos ao escopo do SW (= diretório onde sw.js vive).
// Funciona em qualquer base de URL (raiz do domínio, GitHub Pages, etc).
const APP_SHELL = [
  './',
  './index.html',
  './pages/dashboard.html',
  './pages/login.html',
  './pages/auth-action.html',
  './css/style.css',
  './css/dashboard.css',
  './css/login.css',
  './css/modals.css',
  './js/script.js',
  './js/dashboard.js',
  './js/firebase-config.js',
  './js/auth.js',
  './js/auth-nav.js',
  './js/auth-action.js',
  './js/login.js',
  './js/modals.js',
  './images/icons/icon-192.png',
  './images/icons/icon-512.png',
  './manifest.json',
];

self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(APP_SHELL).catch(err => {
      // Não bloqueia install se algum asset estiver indisponível
      console.warn('[sw] addAll parcial:', err?.message);
    }))
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

/* Estratégia:
 *  - GET de assets do app shell  → cache-first
 *  - Tudo o mais (Firebase, etc) → network-first (fallback cache se houver)
 */
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isFirebase = /firebase|googleapis|gstatic|cdnjs/.test(url.hostname);

  if (isFirebase) {
    e.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // App shell — cache-first
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      // Cacheia respostas próprias do mesmo origin
      if (res.ok && url.origin === self.location.origin) {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => { });
      }
      return res;
    }).catch(() => caches.match('./pages/dashboard.html')))
  );
});

const SCOPE_PATH = new URL(self.registration.scope).pathname;
const ICON = SCOPE_PATH + 'images/icons/icon-192.png';
const DEFAULT_PAGE = SCOPE_PATH + 'pages/dashboard.html';

// Nunca navega pra uma URL fora da própria origem do app — ver o mesmo
// comentário em firebase-messaging-sw.js.
function safeNotifUrl(raw, fallback) {
  try {
    const resolved = new URL(raw, self.registration.scope);
    return resolved.origin === self.location.origin ? resolved.href : fallback;
  } catch {
    return fallback;
  }
}

/* Push direto (caso o servidor envie via Web Push API).
 * FCM tem seu próprio handler em firebase-messaging-sw.js. */
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { data = { title: 'LetControl', body: e.data?.text() || '' }; }
  const title = data.title || 'LetControl';
  const opts = {
    body: data.body || '',
    icon: ICON,
    badge: ICON,
    tag: data.tag || 'letcontrol',
    data: { url: safeNotifUrl(data.url, DEFAULT_PAGE) },
    vibrate: [120, 60, 120],
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = safeNotifUrl(e.notification.data?.url, DEFAULT_PAGE);
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) return c.focus();
      }
      return clients.openWindow(url);
    })
  );
});
