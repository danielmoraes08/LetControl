/* LetControl — Firebase Cloud Messaging Service Worker
 * Recebe pushes em background (app fechado/inativo) e exibe notificação.
 */
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyDMbNYMcQXNaSVht25kCQZ2e0T9rza3F8g",
  authDomain: "letcontrol-database.firebaseapp.com",
  databaseURL: "https://letcontrol-database-default-rtdb.firebaseio.com",
  projectId: "letcontrol-database",
  storageBucket: "letcontrol-database.firebasestorage.app",
  messagingSenderId: "993338285265",
  appId: "1:993338285265:web:08cb2d6330f2433d5679f0",
});

const messaging = firebase.messaging();

// Resolve URLs relativas usando o scope do SW (ex.: "/LetControl/" no GH Pages).
const SCOPE_URL = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE_URL).pathname;
const ICON = SCOPE_PATH + 'images/icons/icon-192.png';
const DEFAULT_PAGE = SCOPE_PATH + 'pages/dashboard.html';

// Nunca navega pra uma URL fora da própria origem do app — o payload do
// push vem do servidor hoje, mas o client não pode assumir que sempre vai
// vir confiável (o campo é texto livre; um bug ou payload adulterado
// poderia apontar pra um site de phishing). Só aceita caminho relativo ou
// URL absoluta da MESMA origem; qualquer outra coisa cai no fallback.
function safeNotifUrl(raw, fallback) {
  try {
    const resolved = new URL(raw, SCOPE_URL);
    return resolved.origin === self.location.origin ? resolved.href : fallback;
  } catch {
    return fallback;
  }
}

messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || 'LetControl';
  const body = n.body || d.body || '';
  const opts = {
    body,
    icon: ICON,
    badge: ICON,
    tag: d.tag || 'letcontrol-' + (d.type || 'generic'),
    // url por último no objeto: garante que a versão validada nunca seja
    // sobrescrita por um d.url cru vindo do spread.
    data: { ...d, url: safeNotifUrl(d.url, DEFAULT_PAGE) },
    vibrate: [180, 80, 180],
    requireInteraction: d.severity === 'high',
  };
  return self.registration.showNotification(title, opts);
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  // Revalida mesmo assim (defesa em profundidade, caso data.url chegue
  // por outro caminho que não passe por onBackgroundMessage).
  const url = safeNotifUrl(e.notification.data?.url, DEFAULT_PAGE);
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.startsWith(SCOPE_URL) && 'focus' in c) {
          c.navigate(url).catch(() => { });
          return c.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
