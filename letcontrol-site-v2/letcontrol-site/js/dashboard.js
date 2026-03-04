/**
 * js/dashboard.js
 * Guard de autenticação + painel em tempo real via Firebase.
 * Usado em: pages/dashboard.html
 */

let unsubReading = null;
let unsubAlerts  = null;
let flowHistory  = [];
let hourlyData   = Array(24).fill(0);
let alertsData   = [];
const GOAL_LIMIT = 175;

// ── AUTH GUARD ────────────────────────────────────────────────────
auth.onAuthStateChanged((user) => {
  if (user) {
    showApp();
    setupDashboard(user);
  } else {
    window.location.href = 'login.html';
  }
});

function showApp() {
  document.getElementById('auth-loading').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  updateDate();
  renderHourlyBars();
}

// ── SETUP ─────────────────────────────────────────────────────────
function setupDashboard(user) {
  const name  = user.displayName || user.email?.split('@')[0] || 'Usuário';
  const email = user.email || '';
  document.getElementById('user-name').textContent  = name;
  document.getElementById('user-email').textContent = email;
  document.getElementById('user-avatar').textContent = name[0].toUpperCase();
  startFirestoreListeners(user.uid);
}

function startFirestoreListeners(userId) {
  // Última leitura em tempo real
  unsubReading = db.collection('readings')
    .where('user_id', '==', userId)
    .orderBy('timestamp', 'desc')
    .limit(1)
    .onSnapshot((snap) => {
      if (!snap.empty) {
        const data = snap.docs[0].data();
        flowHistory.push(data.flow_rate_lpm || 0);
        if (flowHistory.length > 40) flowHistory.shift();
        updateMetrics(data);
        updateGoalBar(data.volume_accumulated_l || 0, GOAL_LIMIT);
        drawSparkline(flowHistory);
        document.getElementById('last-seen').textContent = 'agora';
      }
    }, () => {});

  // Alertas em tempo real
  unsubAlerts = db.collection('alerts')
    .where('user_id', '==', userId)
    .orderBy('created_at', 'desc')
    .limit(10)
    .onSnapshot((snap) => {
      alertsData = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderAlerts();
    }, () => {});

  // Device info (one-time)
  db.collection('devices')
    .where('user_id', '==', userId)
    .limit(1).get()
    .then((snap) => {
      if (!snap.empty) {
        const d   = snap.docs[0];
        const dev = d.data();
        setText('device-name',     dev.name || 'Sensor');
        setText('device-id-label', d.id);
        setText('fw-val',          dev.firmware_version || '--');
        setText('battery-val',     dev.battery_pct ?? '--');
        setText('rssi-val',        dev.wifi_rssi ?? '--');
        const statusEl = document.getElementById('device-status');
        statusEl.className = 'device-status ' + (dev.status || 'offline');
        statusEl.innerHTML = `<span class="status-dot"></span>${dev.status === 'online' ? 'Online' : 'Offline'}`;
      }
    }).catch(() => {});

  // Relatório de hoje para gráfico horário
  const today = new Date().toISOString().split('T')[0];
  db.collection('daily_reports')
    .where('user_id', '==', userId)
    .where('date', '==', today)
    .limit(1).get()
    .then((snap) => {
      if (!snap.empty) {
        const rep = snap.docs[0].data();
        if (rep.usage_periods) {
          rep.usage_periods.forEach(p => { hourlyData[p.hour] = p.volume_l; });
          renderHourlyBars();
        }
      }
    }).catch(() => {});
}

// ── LOGOUT ────────────────────────────────────────────────────────
function handleLogout() {
  if (unsubReading) unsubReading();
  if (unsubAlerts)  unsubAlerts();
  auth.signOut().then(() => { window.location.href = '../index.html'; });
}

// ── MÉTRICAS ──────────────────────────────────────────────────────
function updateMetrics(data) {
  const flow  = data.flow_rate_lpm        ?? 0;
  const vol   = data.volume_accumulated_l ?? 0;
  const pres  = data.pressure_bar         ?? 0;
  const temp  = data.temperature_c        ?? 0;

  setText('flow-val',     flow.toFixed(1));
  setText('volume-val',   vol.toFixed(0));
  setText('pressure-val', pres.toFixed(2));
  setText('temp-val',     temp.toFixed(1));

  // Variação de vazão
  const prev = flowHistory[flowHistory.length - 2] ?? flow;
  const diff = flow - prev;
  const fcEl = document.getElementById('flow-change');
  fcEl.className = 'mc-change ' + (diff >= 0 ? 'up' : 'down');
  fcEl.textContent = (diff >= 0 ? '↑' : '↓') + ' ' + Math.abs(diff).toFixed(2) + ' L/min';

  // Status pressão
  const presEl = document.getElementById('pressure-status');
  if (pres < 0.5)      setChange(presEl, 'down', 'Pressão baixa');
  else if (pres > 4.5) setChange(presEl, 'down', 'Pressão alta');
  else                 setChange(presEl, 'up',   'Normal');

  // Estado da válvula
  const valveEl = document.getElementById('valve-status');
  setChange(valveEl, data.valve_open ? 'up' : 'down', 'Válvula ' + (data.valve_open ? 'aberta' : 'fechada'));

  // Meta %
  setText('volume-change', `Meta: ${((vol / GOAL_LIMIT) * 100).toFixed(0)}% utilizado`);

  // Stats do sparkline
  if (flowHistory.length > 0) {
    const peak = Math.max(...flowHistory);
    const avg  = flowHistory.reduce((a, b) => a + b, 0) / flowHistory.length;
    setText('peak-flow',      peak.toFixed(1) + ' L/min');
    setText('avg-flow',       avg.toFixed(1)  + ' L/min');
    setText('total-readings', String(flowHistory.length));
  }

  if (data.battery_pct != null) setText('battery-val', String(data.battery_pct));
  if (data.wifi_rssi   != null) setText('rssi-val',    String(data.wifi_rssi));
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}
function setChange(el, dir, txt) {
  el.className   = 'mc-change ' + dir;
  el.textContent = txt;
}

// ── META ──────────────────────────────────────────────────────────
function updateGoalBar(used, limit) {
  const pct       = Math.min((used / limit) * 100, 105);
  const remaining = Math.max(limit - used, 0);
  const bar       = document.getElementById('goal-bar');
  bar.style.width = pct + '%';
  bar.className   = 'goal-bar-fill' + (pct > 100 ? ' over' : '');
  setText('goal-used',      used.toFixed(0));
  setText('goal-limit',     String(limit));
  setText('goal-pct',       pct.toFixed(0) + '% utilizado');
  setText('goal-remaining', remaining.toFixed(0) + 'L restantes');
}

// ── ALERTAS ───────────────────────────────────────────────────────
const ALERT_LABELS = {
  LEAK_DETECTED:  'Vazamento',
  GOAL_EXCEEDED:  'Meta',
  ABNORMAL_FLOW:  'Fluxo anormal',
  LOW_PRESSURE:   'Pressão baixa',
  DEVICE_OFFLINE: 'Sensor offline',
};

function renderAlerts() {
  const list   = document.getElementById('alerts-list');
  const unread = alertsData.filter(a => !a.read).length;
  setText('unread-count', unread + ' não lido' + (unread !== 1 ? 's' : ''));

  if (!alertsData.length) {
    list.innerHTML = '<div class="empty-state">Sem alertas no momento</div>';
    return;
  }

  list.innerHTML = alertsData.map(a => {
    const ts   = a.created_at?.toDate ? a.created_at.toDate() : new Date();
    const time = ts.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    return `
      <div class="alert-item ${a.severity} ${a.read ? 'read' : ''}" onclick="markAlertRead('${a.id}')">
        <div class="alert-type-indicator ${a.severity}"></div>
        <div class="alert-body">
          <div class="alert-type-label">${ALERT_LABELS[a.type] || 'Alerta'}</div>
          <div class="alert-msg">${a.message}</div>
          <div class="alert-time">${time}</div>
        </div>
        ${!a.read ? '<div class="alert-unread-dot"></div>' : ''}
      </div>`;
  }).join('');
}

function markAlertRead(alertId) {
  db.collection('alerts').doc(alertId).update({ read: true }).catch(() => {});
}

// ── SPARKLINE ─────────────────────────────────────────────────────
function drawSparkline(data) {
  const svg = document.getElementById('sparkline-svg');
  if (!data.length) return;
  const W = 600, H = 100, PAD = 8;
  const min = Math.min(...data) * 0.85;
  const max = (Math.max(...data) * 1.1) || 1;
  const pts = data.map((v, i) => [
    PAD + (i / Math.max(data.length - 1, 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / (max - min)) * (H - PAD * 2)
  ]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = line + ` L${pts[pts.length - 1][0]},${H} L${pts[0][0]},${H} Z`;
  const last = pts[pts.length - 1];
  svg.innerHTML = `
    <defs>
      <linearGradient id="sg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#0AA1FF" stop-opacity="0.2"/>
        <stop offset="100%" stop-color="#0AA1FF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#sg)"/>
    <path d="${line}" fill="none" stroke="#0AA1FF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="#0AA1FF"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="8" fill="#0AA1FF" opacity="0.15"/>
  `;
}

// ── BARRAS HORÁRIAS ───────────────────────────────────────────────
function renderHourlyBars() {
  const container = document.getElementById('hourly-bars');
  const currentH  = new Date().getHours();
  const max       = Math.max(...hourlyData, 1);
  container.innerHTML = hourlyData.map((v, h) => `
    <div class="mini-bar-col">
      <div class="mini-bar ${h === currentH ? 'active' : ''}"
           style="height:${Math.max((v / max) * 72, 4)}px"
           title="${h}h: ${v.toFixed(1)}L"></div>
    </div>
  `).join('');
}

function updateDate() {
  const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  setText('today-date', today);
}
