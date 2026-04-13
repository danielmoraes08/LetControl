/**
 * dashboard.js — LetControl v3
 *
 * Responsabilidade de escrita por nó:
 *   readings/{id}/live      ← ESP32 (a cada 5s)
 *   readings/{id}/history   ← ESP32 (push a cada 5s)
 *   readings/{id}/meta      ← ESP32 / Cloud Function (TTL cursor)
 *   aggregates/{id}/*       ← Cloud Function (ou fallback client abaixo)
 *   device_health/{id}/*    ← Cloud Function (diário)
 *   devices/{id}/status     ← ESP32 (heartbeat)
 *   devices/{id}/config     ← Web app
 *   devices/{id}/ota        ← Web app
 *   alerts/{uid}/*          ← Cloud Function (detecção de anomalia)
 *   goals/{uid}             ← Web app
 *   preferences/{uid}       ← Web app   ← separado de goals em v3
 *   user_devices/{uid}/*    ← Web app   ← { added_at, role } em v3
 *   sessions/{uid}          ← Web app
 */

let refLive = null;
let refHistory = null;
let refAlerts = null;
let refDevice = null;

let flowHistory = [];
let hourlyData = Array(24).fill(0);
let alertsData = [];
let GOAL_LIMIT = 175;
let GOAL_WEEKLY = 1225;
let GOAL_MONTHLY = 5250;
let GOAL_ANNUAL = 63875;
let currentUid = null;
let activeDeviceId = null;

// ── AUTH GUARD ────────────────────────────────────────────────────
auth.onAuthStateChanged(user => {
  if (user) {
    currentUid = user.uid;
    document.getElementById('auth-loading').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    setupDashboard(user);
    updateDate();
    renderHourlyBars();
  } else {
    window.location.href = 'login.html';
  }
});

function setupDashboard(user) {
  const name = user.displayName || user.email?.split('@')[0] || 'Usuário';
  const email = user.email || '';
  ['user-name', 'cfg-name-display'].forEach(id => setText(id, name));
  ['user-email', 'cfg-email-display'].forEach(id => setText(id, email));
  setText('user-avatar', name[0].toUpperCase());
  const inp = document.getElementById('cfg-name-input');
  if (inp) inp.value = name;
  resolveActiveDevice(user.uid);
}

// ── RESOLVE DISPOSITIVO ATIVO ─────────────────────────────────────
async function resolveActiveDevice(uid) {
  // 1) Sessão salva
  const sessSnap = await rtdb.ref(`sessions/${uid}/active_device_id`).once('value');
  let deviceId = sessSnap.val();

  // 2) Fallback: primeiro dispositivo do usuário
  if (!deviceId) {
    const devSnap = await rtdb.ref(`user_devices/${uid}`).limitToFirst(1).once('value');
    const map = devSnap.val();
    if (map) deviceId = Object.keys(map)[0];
  }

  activeDeviceId = deviceId || null;
  startListeners(uid, activeDeviceId);
}

// ── LISTENERS ─────────────────────────────────────────────────────
function startListeners(uid, deviceId) {

  // Metas (goals)
  rtdb.ref(`goals/${uid}`).once('value', snap => {
    const g = snap.val();
    if (!g) return;
    if (g.daily_l)   { GOAL_LIMIT   = g.daily_l;   setText('meta-diaria-limit', g.daily_l);  setText('goal-limit', g.daily_l); }
    if (g.weekly_l)  { GOAL_WEEKLY  = g.weekly_l;  setText('meta-semanal-limit', g.weekly_l); }
    if (g.monthly_l) { GOAL_MONTHLY = g.monthly_l; setText('meta-mensal-limit', g.monthly_l); }
    GOAL_ANNUAL = (g.daily_l || GOAL_LIMIT) * 365;
    if (g.leak_min) setText('meta-leak-limit', g.leak_min);
    if (g.leak_lpm) setText('meta-leak-flow', g.leak_lpm);
    // Compute weekly and monthly usage from aggregates after goals load
    if (deviceId) loadPeriodTotals(deviceId, g);
  });

  // Preferências de notificação (agora em nó separado)
  rtdb.ref(`preferences/${uid}/notify`).once('value', snap => {
    const n = snap.val() || {};
    ['push', 'email', 'leak', 'goal'].forEach(k => {
      const el = document.getElementById(`notif-${k}`);
      if (el && n[k] !== undefined) el.checked = n[k];
    });
  });

  // Alertas (por uid — independente do device)
  refAlerts = rtdb.ref(`alerts/${uid}`).orderByChild('created_at').limitToLast(20);
  refAlerts.on('value', snap => {
    const val = snap.val();
    alertsData = val
      ? Object.entries(val).map(([id, d]) => ({ id, ...d }))
        .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      : [];
    renderAlerts();
  });

  if (!deviceId) {
    checkDeviceState({ val: () => null });
    return;
  }

  // Device metadata
  refDevice = rtdb.ref(`devices/${deviceId}`);
  refDevice.on('value', checkDeviceState);

  // Live reading (hot path — a cada 5s)
  refLive = rtdb.ref(`readings/${deviceId}/live`);
  refLive.on('value', snap => {
    const d = snap.val();
    if (!d) return;
    updateMetrics(d);
    updateGoalBar(d.vol_today_l ?? 0, GOAL_LIMIT);
    setText('last-seen', 'agora');
    setText('spec-last', new Date().toLocaleTimeString('pt-BR'));
  });

  // Histórico sparkline (limitToLast → sem paginação, sem varredura total)
  refHistory = rtdb.ref(`readings/${deviceId}/history`).limitToLast(40);
  refHistory.on('value', snap => {
    const val = snap.val();
    if (!val) return;
    flowHistory = Object.values(val)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0))
      .map(r => r.f ?? 0);
    drawSparkline(flowHistory, 'sparkline-canvas');
    drawSparkline(flowHistory, 'sparkline-consumo');
    updateSparklineStats();
  });

  // Agregados horários pré-computados (escrito por Cloud Function)
  rtdb.ref(`aggregates/${deviceId}/hourly/${todayKey()}`).on('value', snap => {
    const hours = snap.val();
    if (!hours) return;
    hourlyData = Array(24).fill(0);
    Object.entries(hours).forEach(([h, agg]) => {
      hourlyData[+h] = agg.vol_l || 0;
    });
    renderHourlyBars();
    updateConsumptionPage();
  });

  // Diário atual (para meta bar) — lê consumoHoje de daily/{uid}
  rtdb.ref(`daily/${uid}/consumoHoje`).on('value', snap => {
    const vol = snap.val() ?? 0;
    updateGoalBar(vol, GOAL_LIMIT);
  });
}

// ── TOTAIS SEMANAIS / MENSAIS ─────────────────────────────────────
async function loadPeriodTotals(deviceId, goals) {
  const now = new Date();
  // Week: last 7 days
  let weekTotal = 0;
  // Month: days in current month so far
  let monthTotal = 0;
  const dayOfMonth = now.getDate();
  const promises = [];
  for (let i = 0; i < Math.max(7, dayOfMonth); i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    promises.push(dailyRef(currentUid, key).once('value').then(snap => ({
      key, i, vol: snap.val() ?? 0, dayOffset: i
    })));
  }
  const results = await Promise.all(promises);
  results.forEach(r => {
    if (r.dayOffset < 7) weekTotal += r.vol;
    const d = new Date(now); d.setDate(d.getDate() - r.dayOffset);
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) monthTotal += r.vol;
  });

  const weekGoal = goals?.weekly_l ?? GOAL_LIMIT * 7;
  const monthGoal = goals?.monthly_l ?? GOAL_LIMIT * 30;

  const weekPct = Math.min((weekTotal / weekGoal) * 100, 100);
  const monthPct = Math.min((monthTotal / monthGoal) * 100, 100);

  setText('meta-semanal-used', weekTotal.toFixed(0));
  setText('meta-mensal-used', monthTotal.toFixed(0));

  const swBar = document.getElementById('meta-semanal-bar');
  if (swBar) { swBar.style.width = weekPct + '%'; swBar.className = 'gdc-bar-fill' + (weekPct >= 100 ? ' over' : weekPct >= 80 ? ' warn' : ''); }
  const smBar = document.getElementById('meta-mensal-bar');
  if (smBar) { smBar.style.width = monthPct + '%'; smBar.className = 'gdc-bar-fill' + (monthPct >= 100 ? ' over' : monthPct >= 80 ? ' warn' : ''); }
}


function updateMetrics(d) {
  const flow = d.flow_lpm ?? 0;
  const vol = d.vol_today_l ?? 0;

  animateValue('flow-val', flow, 1);
  animateValue('volume-val', vol, 0);

  const valveOpen = d.valve_open ?? false;
  setText('valve-val', valveOpen ? 'Aberta' : 'Fechada');
  const valveEl = document.getElementById('valve-status');
  if (valveEl) { valveEl.className = 'mc-change ' + (valveOpen ? 'up' : 'down'); valveEl.textContent = valveOpen ? '↑ Fluxo liberado' : '↓ Bloqueado'; }

  const prev = flowHistory[flowHistory.length - 2] ?? flow;
  const diff = flow - prev;
  const fcEl = document.getElementById('flow-change');
  if (fcEl) { fcEl.className = 'mc-change ' + (diff >= 0 ? 'up' : 'down'); fcEl.textContent = (diff >= 0 ? '↑' : '↓') + ' ' + Math.abs(diff).toFixed(2) + ' L/min'; }

  const volEl = document.getElementById('volume-change');
  if (volEl) volEl.textContent = `${((vol / GOAL_LIMIT) * 100).toFixed(0)}% da meta diária`;

  if (d.battery_pct != null) setText('battery-val', String(d.battery_pct));
  if (d.wifi_rssi != null) setText('rssi-val', String(d.wifi_rssi));
}

// ── META BAR ──────────────────────────────────────────────────────
function updateGoalBar(used, limit) {
  const pct = Math.min((used / limit) * 100, 105);
  const rem = Math.max(limit - used, 0);
  const bar = document.getElementById('goal-bar');
  if (bar) { bar.style.width = pct + '%'; bar.className = 'goal-bar-fill' + (pct >= 100 ? ' over' : ''); }
  setText('goal-used', used.toFixed(0));
  setText('goal-limit', String(limit));
  setText('goal-pct', pct.toFixed(0) + '% utilizado');
  setText('goal-remaining', rem.toFixed(0) + 'L restantes');
  setText('meta-diaria-used', used.toFixed(0));
  const mdBar = document.getElementById('meta-diaria-bar');
  if (mdBar) { mdBar.style.width = pct + '%'; mdBar.className = 'gdc-bar-fill' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : ''); }
}

// ── CHART HELPERS ────────────────────────────────────────────────
const _charts = {};

function _getColor(varName, fallback) {
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || fallback;
}

function _isDark() {
  return document.documentElement.getAttribute('data-theme') === 'dark';
}

function _destroyChart(key) {
  if (_charts[key]) { try { _charts[key].destroy(); } catch (e) { } delete _charts[key]; }
}

// ── SPARKLINE (Chart.js Line) ─────────────────────────────────────
function drawSparkline(data, canvasId) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || !data.length) return;
  if (typeof Chart === 'undefined') return;

  // Update only if chart exists
  if (_charts[canvasId]) {
    _charts[canvasId].data.labels = data.map((_, i) => i);
    _charts[canvasId].data.datasets[0].data = data;
    _charts[canvasId].data.datasets[0].pointRadius = data.map((_, i) => i === data.length - 1 ? 5 : 0);
    _charts[canvasId].update('none');
    return;
  }

  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, canvas.offsetHeight || 100);
  grad.addColorStop(0, 'rgba(26,172,240,0.3)');
  grad.addColorStop(1, 'rgba(26,172,240,0)');
  const dark = _isDark();

  _charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map((_, i) => i),
      datasets: [{
        data,
        fill: true,
        backgroundColor: grad,
        borderColor: '#1AACF0',
        borderWidth: 2.2,
        pointRadius: data.map((_, i) => i === data.length - 1 ? 5 : 0),
        pointBackgroundColor: '#1AACF0',
        pointBorderColor: dark ? '#0d1f30' : '#fff',
        pointBorderWidth: 2,
        tension: 0.4,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: c => ' ' + c.parsed.y.toFixed(2) + ' L/min' }
        }
      },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true }
      }
    }
  });
}

function updateSparklineStats() {
  if (!flowHistory.length) return;
  const peak = Math.max(...flowHistory);
  const avg = flowHistory.reduce((a, b) => a + b, 0) / flowHistory.length;
  setText('peak-flow', peak.toFixed(1) + ' L/min');
  setText('avg-flow', avg.toFixed(1) + ' L/min');
  setText('total-readings', String(flowHistory.length));
}

// ── BARRAS HORÁRIAS (Chart.js) ────────────────────────────────────
function renderHourlyBars() {
  const canvas = document.getElementById('hourly-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const h = new Date().getHours();
  const dark = _isDark();
  const bgColors = hourlyData.map((_, i) => i === h ? 'rgba(14,165,233,0.9)' : 'rgba(26,172,240,0.5)');
  const bdColors = hourlyData.map((_, i) => i === h ? '#0ea5e9' : '#1AACF0');
  const labels = Array.from({ length: 24 }, (_, i) => i + 'h');

  if (_charts['hourly']) {
    _charts['hourly'].data.datasets[0].data = hourlyData;
    _charts['hourly'].data.datasets[0].backgroundColor = bgColors;
    _charts['hourly'].data.datasets[0].borderColor = bdColors;
    _charts['hourly'].update('none');
    return;
  }

  _charts['hourly'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ data: hourlyData, backgroundColor: bgColors, borderColor: bdColors, borderWidth: 1.5, borderRadius: 4, borderSkipped: 'bottom' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: i => i[0].label,
            label: c => ' ' + c.parsed.y.toFixed(1) + ' L'
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 0, font: { size: 9 }, callback: (v, i) => [0, 4, 8, 12, 16, 20, 23].includes(i) ? labels[i] : '' } },
        y: { beginAtZero: true, grid: { color: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }, ticks: { maxTicksLimit: 4, font: { size: 9 }, callback: v => v + 'L' } }
      }
    }
  });
}

// ── ALERTAS ───────────────────────────────────────────────────────
const ALERT_LABELS = {
  LEAK_DETECTED: 'Vazamento', GOAL_EXCEEDED: 'Meta atingida',
  ABNORMAL_FLOW: 'Fluxo anormal', DEVICE_OFFLINE: 'Sensor offline',
  LOW_BATTERY: 'Bateria baixa',
};

function renderAlerts() {
  const unread = alertsData.filter(a => !a.read).length;
  setText('unread-count', unread + (unread === 1 ? ' não lido' : ' não lidos'));
  setText('unread-count-alertas', unread + (unread === 1 ? ' não lido' : ' não lidos'));
  setText('alertas-subtitle', `${alertsData.length} alerta${alertsData.length !== 1 ? 's' : ''} — ${unread} não lido${unread !== 1 ? 's' : ''}`);
  const badge = document.getElementById('sidebar-unread-badge');
  if (badge) { badge.style.display = unread > 0 ? 'inline' : 'none'; badge.textContent = unread; }
  const preview = alertsData.slice(0, 5).map(alertHtml).join('') || '<div class="empty-state">Nenhum alerta</div>';
  const full = alertsData.map(alertHtml).join('') || '<div class="empty-state">Nenhum alerta registrado</div>';
  const pEl = document.getElementById('alerts-list-painel');
  const fEl = document.getElementById('alerts-list-full');
  if (pEl) pEl.innerHTML = preview;
  if (fEl) fEl.innerHTML = full;
}

function alertHtml(a) {
  const ts = a.created_at ? new Date(a.created_at) : new Date();
  const time = ts.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const resolved = a.resolved_at
    ? `<div class="alert-time">Resolvido: ${new Date(a.resolved_at).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>`
    : '';
  return `
    <div class="alert-item ${a.read ? 'read' : ''}" onclick="markAlertRead('${a.id}')">
      <div class="alert-type-indicator ${a.severity || 'low'}"></div>
      <div class="alert-body">
        <div class="alert-type-label">${ALERT_LABELS[a.type] || 'Alerta'}</div>
        <div class="alert-msg">${a.message || ''}</div>
        <div class="alert-time">${time}</div>
        ${resolved}
      </div>
      ${!a.read ? '<div class="alert-unread-dot"></div>' : ''}
    </div>`;
}

function markAlertRead(id) {
  if (!currentUid) return;
  rtdb.ref(`alerts/${currentUid}/${id}`).update({ read: true, read_at: Date.now() });
}
function markAllRead() {
  if (!currentUid || !alertsData.length) return;
  const now = Date.now(), updates = {};
  alertsData.forEach(a => {
    updates[`alerts/${currentUid}/${a.id}/read`] = true;
    updates[`alerts/${currentUid}/${a.id}/read_at`] = now;
  });
  rtdb.ref().update(updates);
}

// ── DISPOSITIVO ───────────────────────────────────────────────────
let hasDevice = false;

function checkDeviceState(snap) {
  const dev = snap.val ? snap.val() : snap;
  hasDevice = !!dev;

  const noEl = document.getElementById('no-device-state');
  const hasEl = document.getElementById('has-device-state');
  const btnAdd = document.getElementById('btn-add-top');
  const fab = document.getElementById('fab-add-device');
  const banner = document.getElementById('painel-no-device-banner');

  if (noEl) noEl.style.display = hasDevice ? 'none' : 'flex';
  if (hasEl) hasEl.style.display = hasDevice ? 'block' : 'none';
  if (btnAdd) btnAdd.style.display = hasDevice ? 'inline-flex' : 'none';

  // FAB: visível quando não há dispositivo e a página de dispositivos não está aberta
  if (fab) {
    fab.style.display = hasDevice ? 'none' : 'inline-flex';
    fab.onmouseenter = () => { fab.style.transform = 'scale(1.1)'; fab.style.boxShadow = '0 6px 28px rgba(26,172,240,.6)'; };
    fab.onmouseleave = () => { fab.style.transform = ''; fab.style.boxShadow = '0 4px 20px rgba(26,172,240,.45)'; };
  }

  // Banner no painel: visível apenas quando não há dispositivo
  if (banner) banner.style.display = hasDevice ? 'none' : 'flex';

  if (!dev) { setText('sb-device-name', 'Sem dispositivo'); setText('sb-device-status', 'Não conectado'); return; }

  const name = dev.name || 'Sensor';
  const fw = dev.firmware_version || '--';
  const bat = dev.status?.battery_pct ?? '--';
  const rssi = dev.status?.wifi_rssi ?? '--';
  const online = dev.status?.online ?? false;

  setText('sb-device-name', name);
  setText('sb-device-status', online ? 'Online' : 'Offline');
  setText('device-name', name);
  setText('device-id-label', activeDeviceId || '--');
  setText('fw-val', fw);
  setText('battery-val', bat);
  setText('rssi-val', rssi);

  const statusDot = (on) => `<span class="status-dot"></span>${on ? 'Online' : 'Offline'}`;
  ['device-status', 'dev-status-big'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.className = 'device-status ' + (online ? 'online' : 'offline'); el.innerHTML = statusDot(online); }
  });
  setText('dev-name-big', name);
  setText('dev-id-big', activeDeviceId || '--');
  setText('dev-fw-big', fw);
  setText('dev-bat-big', bat);
  setText('dev-rssi-big', rssi);
  setText('spec-id', activeDeviceId || '--');
  setText('spec-fw', fw);
  setText('spec-status', online ? 'Online' : 'Offline');
  setText('spec-bat', bat + '%');
  setText('spec-rssi', rssi + ' dBm');
}

// ── MODAL: ADICIONAR DISPOSITIVO ──────────────────────────────────
function openAddDevice() {
  goStep(1);
  document.getElementById('modal-add-device').classList.remove('hidden');
  ['add-dev-name', 'add-dev-id', 'add-wifi-ssid', 'add-wifi-pass'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const g = document.getElementById('add-dev-goal'); if (g) g.value = '175';
  ['step1-error', 'step2-error'].forEach(id => {
    const el = document.getElementById(id); if (el) el.style.display = 'none';
  });
}
function closeAddDevice() {
  document.getElementById('modal-add-device').classList.add('hidden');
  if (document.getElementById('modal-step-3')?.style.display !== 'none')
    showPage('painel', document.querySelector('.sidebar-link'));
}
function goStep(n) {
  if (n === 2 && !validateStep1()) return;
  [1, 2, 3].forEach(i => {
    const el = document.getElementById(`modal-step-${i}`);
    if (el) el.style.display = i === n ? 'block' : 'none';
  });
}
function validateStep1() {
  const name = document.getElementById('add-dev-name')?.value.trim();
  const id = document.getElementById('add-dev-id')?.value.trim();
  const err = document.getElementById('step1-error');
  if (!name) { if (err) { err.textContent = 'Informe o nome do dispositivo.'; err.style.display = 'block'; } return false; }
  if (!id) { if (err) { err.textContent = 'Informe o Device ID.'; err.style.display = 'block'; } return false; }
  if (err) err.style.display = 'none';
  return true;
}

async function saveDevice() {
  const ssid = document.getElementById('add-wifi-ssid')?.value.trim();
  const pass = document.getElementById('add-wifi-pass')?.value;
  const err = document.getElementById('step2-error');
  if (!ssid) { if (err) { err.textContent = 'Informe o nome da rede.'; err.style.display = 'block'; } return; }
  if (!pass) { if (err) { err.textContent = 'Informe a senha Wi-Fi.'; err.style.display = 'block'; } return; }
  if (err) err.style.display = 'none';

  const btnSave = document.getElementById('btn-save-device');
  const spin = document.getElementById('save-btn-spin');
  const text = document.getElementById('save-btn-text');
  if (btnSave) btnSave.disabled = true;
  if (spin) spin.style.display = 'block';
  if (text) text.style.display = 'none';

  const name = document.getElementById('add-dev-name')?.value.trim();
  const deviceId = document.getElementById('add-dev-id')?.value.trim();
  const location = document.getElementById('add-dev-location')?.value || 'nao_definido';
  const goal = parseFloat(document.getElementById('add-dev-goal')?.value) || 175;
  const now = Date.now();
  const today = todayKey();

  // Valida campos obrigatórios que vêm do step 1
  const step1err = document.getElementById('step1-error');
  if (!name || !deviceId) {
    if (err) { err.textContent = 'Volte ao passo 1 e preencha nome e Device ID.'; err.style.display = 'block'; }
    if (btnSave) btnSave.disabled = false;
    if (spin) spin.style.display = 'none';
    if (text) text.style.display = 'inline';
    return;
  }

  // Garante que o usuário está autenticado antes de qualquer escrita
  if (!currentUid || !auth.currentUser) {
    if (err) { err.textContent = 'Sessão expirada. Faça login novamente.'; err.style.display = 'block'; }
    if (btnSave) btnSave.disabled = false;
    if (spin) spin.style.display = 'none';
    if (text) text.style.display = 'inline';
    return;
  }

  try {
    // ── FASE 1: Device + user_devices + sessão + metas ───────────────
    // Tudo como flat paths num único batch, sem .set() em nós pai.
    // .set() em nó pai apaga todos os filhos — NUNCA usar para updates.
    const phase1 = {};
    phase1[`devices/${deviceId}/owner_uid`] = currentUid;
    phase1[`devices/${deviceId}/name`] = name;
    phase1[`devices/${deviceId}/location`] = location;
    phase1[`devices/${deviceId}/firmware_version`] = 'v1.0.0';
    phase1[`devices/${deviceId}/added_at`] = now;
    phase1[`devices/${deviceId}/status/online`] = false;
    phase1[`devices/${deviceId}/status/battery_pct`] = 0;
    phase1[`devices/${deviceId}/status/wifi_rssi`] = 0;
    phase1[`devices/${deviceId}/config/wifi_ssid`] = ssid;
    phase1[`devices/${deviceId}/config/wifi_pass`] = pass || '';
    phase1[`devices/${deviceId}/config/sample_interval_s`] = 5;
    phase1[`devices/${deviceId}/config/goal_daily_l`] = goal;
    phase1[`devices/${deviceId}/config/leak_threshold_min`] = 30;
    phase1[`devices/${deviceId}/config/leak_flow_lpm`] = 0.5;
    phase1[`devices/${deviceId}/ota/pending`] = false;
    phase1[`devices/${deviceId}/ota/status`] = 'idle';
    phase1[`user_devices/${currentUid}/${deviceId}/added_at`] = now;
    phase1[`user_devices/${currentUid}/${deviceId}/role`] = 'owner';
    phase1[`sessions/${currentUid}/active_device_id`] = deviceId;
    phase1[`sessions/${currentUid}/last_active`] = now;
    phase1[`goals/${currentUid}/daily_l`] = goal;
    await rtdb.ref().update(phase1);

    // ── FASE 2: aggregates + readings/meta ───────────────────────────
    // Feita APÓS a fase 1 porque a regra de aggregates/$deviceId
    // verifica devices/$deviceId/owner_uid — que acabou de ser gravado.
    // Só inicializa vol/peak/hours se o aggregate ainda não existir,
    // para não zerar dados que o ESP32 ou seed já popularam.
    const aggSnap = await rtdb.ref(`aggregates/${deviceId}/daily/${today}`).once('value');
    const phase2 = {};
    phase2[`aggregates/${deviceId}/daily/${today}/goal_l`] = goal; // sempre atualiza a meta
    phase2[`aggregates/${deviceId}/daily/${today}/date`] = today;
    if (!aggSnap.exists()) {
      // só zera se é um aggregate novo — não apaga dados existentes do ESP32/seed
      phase2[`aggregates/${deviceId}/daily/${today}/vol_l`] = 0;
      phase2[`aggregates/${deviceId}/daily/${today}/peak_lpm`] = 0;
      phase2[`aggregates/${deviceId}/daily/${today}/active_hours`] = 0;
    }
    phase2[`readings/${deviceId}/meta/retention_days`] = 30;
    phase2[`readings/${deviceId}/meta/daily_reset_date`] = today;
    if (!aggSnap.exists()) {
      phase2[`readings/${deviceId}/meta/total_writes`] = 0;
    }
    await rtdb.ref().update(phase2);

    activeDeviceId = deviceId;
    GOAL_LIMIT = goal;
    setText('confirm-dev-name', name);
    goStep(3);

    teardownDeviceListeners();
    startListeners(currentUid, deviceId);

  } catch (e) {
    console.error('saveDevice error:', e);
    const msg = e?.code === 'PERMISSION_DENIED'
      ? 'Device ID inválido ou sem permissão. Confirme o ID do sensor e tente novamente.'
      : `Erro ao salvar: ${e?.message || 'Tente novamente.'}`;
    if (err) { err.textContent = msg; err.style.display = 'block'; }
  } finally {
    if (btnSave) btnSave.disabled = false;
    if (spin) spin.style.display = 'none';
    if (text) text.style.display = 'inline';
  }
}

function openRenameDevice() {
  const name = document.getElementById('dev-name-big')?.textContent;
  const n = prompt('Novo nome:', name);
  if (n?.trim() && activeDeviceId) rtdb.ref(`devices/${activeDeviceId}/name`).set(n.trim());
}

function confirmRemoveDevice() {
  const name = document.getElementById('dev-name-big')?.textContent;
  if (!confirm(`Remover "${name}"? Leituras e agregados serão mantidos.`)) return;
  if (!activeDeviceId || !currentUid) return;
  const updates = {};
  updates[`devices/${activeDeviceId}`] = null;
  updates[`user_devices/${currentUid}/${activeDeviceId}`] = null;
  updates[`sessions/${currentUid}/active_device_id`] = null;
  rtdb.ref().update(updates);
  teardownDeviceListeners();
  activeDeviceId = null;
  checkDeviceState({ val: () => null });
}

document.getElementById('modal-add-device')?.addEventListener('click', function (e) {
  if (e.target === this) closeAddDevice();
});

function teardownDeviceListeners() {
  if (activeDeviceId) {
    rtdb.ref(`readings/${activeDeviceId}/live`).off();
    rtdb.ref(`readings/${activeDeviceId}/history`).off();
    rtdb.ref(`devices/${activeDeviceId}`).off();
    rtdb.ref(`aggregates/${activeDeviceId}/hourly/${todayKey()}`).off();
  }
  if (currentUid) {
    rtdb.ref(`daily/${currentUid}/consumoHoje`).off();
  }
  refLive = refHistory = refDevice = null;
}

// ── CONSUMO ───────────────────────────────────────────────────────
let _currentPeriod = 'hoje';

function updateConsumptionPage() {
  _loadAndRenderConsumo(_currentPeriod);
}

async function _loadAndRenderConsumo(period) {
  if (!activeDeviceId) {
    setText('cons-total', '0');
    setText('cons-peak', '0');
    setText('cons-avg', '0');
    setText('cons-active-hours', '0');
    _renderConsChart([], []);
    return;
  }

  const now = new Date();
  let chartLabels = [];
  let chartData = [];
  let total = 0, peak = 0, active = 0;

  if (period === 'hoje') {
    // Dados horários do dia atual (já em memória via listener)
    chartLabels = Array.from({ length: 24 }, (_, i) => i + 'h');
    chartData = [...hourlyData];
    total = hourlyData.reduce((a, b) => a + b, 0);
    peak = Math.max(...hourlyData, 0);
    active = hourlyData.filter(v => v > 0).length;

  } else if (period === 'semana') {
    // Últimos 7 dias — busca daily aggregates
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split('T')[0]);
    }
    const snaps = await Promise.all(
      days.map(key => dailyRef(currentUid, key).once('value'))
    );
    snaps.forEach((snap, i) => {
      const v = snap.val() ?? 0;
      const d = new Date(now);
      d.setDate(d.getDate() - (6 - i));
      const label = d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit' });
      chartLabels.push(label);
      chartData.push(v);
      total += v;
      if (v > peak) peak = v;
      if (v > 0) active++;
    });

  } else if (period === 'mes') {
    // Últimos 30 dias — busca daily aggregates
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split('T')[0]);
    }
    const snaps = await Promise.all(
      days.map(key => dailyRef(currentUid, key).once('value'))
    );
    snaps.forEach((snap, i) => {
      const v = snap.val() ?? 0;
      const d = new Date(now);
      d.setDate(d.getDate() - (29 - i));
      const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      chartLabels.push(label);
      chartData.push(v);
      total += v;
      if (v > peak) peak = v;
      if (v > 0) active++;
    });

  } else if (period === 'ano') {
    // Últimos 12 meses — agrega todos os dias de cada mês
    const months = [];
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({
        year: String(d.getFullYear()),
        month: String(d.getMonth() + 1).padStart(2, '0'),
        date: d
      });
    }
    const snaps = await Promise.all(
      months.map(({ year, month }) =>
        rtdb.ref(`daily/${currentUid}/${year}/${month}`).once('value')
      )
    );
    snaps.forEach((snap, i) => {
      const monthData = snap.val() ?? {};
      // Soma todos os dias do mês (cada chave é um dia, valor é número em litros)
      const v = Object.values(monthData).reduce((sum, val) => {
        if (typeof val === 'number') return sum + val;
        if (val && typeof val === 'object') {
          // Caso o nó tenha sub-campos, soma recursivamente valores numéricos diretos
          return sum + Object.values(val).reduce((s, x) => s + (typeof x === 'number' ? x : 0), 0);
        }
        return sum;
      }, 0);
      const label = months[i].date.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
      chartLabels.push(label);
      chartData.push(v);
      total += v;
      if (v > peak) peak = v;
      if (v > 0) active++;
    });
  }

  // Atualiza as labels das stat boxes conforme o período
  _updateConsLabels(period);

  const avg = active > 0 ? total / active : 0;
  setText('cons-total', total.toFixed(0));
  setText('cons-peak', peak.toFixed(1));
  setText('cons-avg', avg.toFixed(1));
  setText('cons-active-hours', String(active));

  // Atualiza o % utilizado no card de meta
  const periodGoalMap = { hoje: GOAL_LIMIT, semana: GOAL_WEEKLY, mes: GOAL_MONTHLY, ano: GOAL_ANNUAL };
  const periodGoal = periodGoalMap[period] || GOAL_LIMIT;
  const metaPct = periodGoal > 0 ? Math.min((total / periodGoal) * 100, 999) : 0;
  const metaColor = metaPct >= 100 ? 'var(--red)' : metaPct >= 80 ? 'var(--yellow)' : 'var(--green)';
  setText('cons-meta-sub', `${metaPct.toFixed(0)}% utilizado`);
  const metaEl = document.getElementById('cons-meta');
  if (metaEl) metaEl.style.color = metaColor;

  _renderConsChart(chartLabels, chartData, period);
}

// Atualiza os rótulos das stat boxes de acordo com o período selecionado
// Atualiza os rótulos das stat boxes de acordo com o período selecionado
function _updateConsLabels(period) {
  const cfg = {
    hoje: {
      totalLabel: 'Total do dia',    peak: 'Pico do dia',    peakSub: 'litros na hora de maior uso',
      avg: 'Média por hora',         avgSub: 'litros / hora',
      active: 'Horas com uso',       activeSub: 'de 24 horas',
      metaLabel: 'Meta diária',      metaVal: GOAL_LIMIT,     metaSub: 'limite do dia'
    },
    semana: {
      totalLabel: 'Total da semana', peak: 'Pico da semana', peakSub: 'litros no dia de maior uso',
      avg: 'Média diária',           avgSub: 'litros / dia',
      active: 'Dias com uso',        activeSub: 'de 7 dias',
      metaLabel: 'Meta semanal',     metaVal: GOAL_WEEKLY,    metaSub: 'limite da semana'
    },
    mes: {
      totalLabel: 'Total do mês',    peak: 'Pico do mês',    peakSub: 'litros no dia de maior uso',
      avg: 'Média diária',           avgSub: 'litros / dia',
      active: 'Dias com uso',        activeSub: 'de 30 dias',
      metaLabel: 'Meta mensal',      metaVal: GOAL_MONTHLY,   metaSub: 'limite do mês'
    },
    ano: {
      totalLabel: 'Total do ano',    peak: 'Pico do ano',    peakSub: 'litros no mês de maior uso',
      avg: 'Média mensal',           avgSub: 'litros / mês',
      active: 'Meses com dados',     activeSub: 'de 12 meses',
      metaLabel: 'Meta anual',       metaVal: GOAL_ANNUAL,    metaSub: 'limite do ano'
    },
  };
  const c = cfg[period] || cfg.hoje;
  setText('cons-total-label', c.totalLabel);
  setText('cons-peak-label', c.peak);
  setText('cons-peak-sub', c.peakSub);
  setText('cons-avg-label', c.avg);
  setText('cons-avg-sub', c.avgSub);
  setText('cons-active-label', c.active);
  setText('cons-active-sub', c.activeSub);
  setText('cons-meta-label', c.metaLabel);
  setText('cons-meta', String(c.metaVal));
  setText('cons-meta-sub', c.metaSub);
}

function _renderConsChart(labels, data, period) {
  const canvas = document.getElementById('cons-bar-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const h = new Date().getHours();
  const dark = _isDark();
  const isToday = period === 'hoje';

  const bgColors = data.map((_, i) =>
    isToday && i === h ? 'rgba(14,165,233,0.9)' : 'rgba(26,172,240,0.6)'
  );
  const bdColors = data.map((_, i) =>
    isToday && i === h ? '#0ea5e9' : '#1AACF0'
  );

  // Destroy and recreate when period/labels change
  _destroyChart('cons');

  _charts['cons'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{ label: 'Consumo (L)', data, backgroundColor: bgColors, borderColor: bdColors, borderWidth: 1.5, borderRadius: 6, borderSkipped: 'bottom' }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: i => i[0].label,
            label: c => ' ' + c.parsed.y.toFixed(1) + ' L'
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            maxRotation: 0,
            font: { size: (period === 'mes' || period === 'ano') ? 8 : 10 },
            maxTicksLimit: period === 'mes' ? 10 : period === 'ano' ? 12 : 24,
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' },
          ticks: { maxTicksLimit: 5, font: { size: 10 }, callback: v => v + 'L' }
        }
      }
    }
  });
}

// Alias mantido para compatibilidade com listener do Firebase
function renderBarChart() { _loadAndRenderConsumo(_currentPeriod); }

function setPeriod(period, btn) {
  document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const periodLabels = { hoje: 'Hoje', semana: 'Esta semana', mes: 'Este mês', ano: 'Este ano' };
  setText('cons-period-label', periodLabels[period] || period);
  _currentPeriod = period;
  _loadAndRenderConsumo(period);
}

// ── METAS ─────────────────────────────────────────────────────────
function editMeta(type) {
  const idMap = { diaria: 'meta-diaria-limit', semanal: 'meta-semanal-limit', mensal: 'meta-mensal-limit', vazamento: 'meta-leak-limit' };
  const pathMap = { diaria: 'daily_l', semanal: 'weekly_l', mensal: 'monthly_l', vazamento: 'leak_min' };
  const lblMap = { diaria: 'meta diária (L)', semanal: 'meta semanal (L)', mensal: 'meta mensal (L)', vazamento: 'limite de vazamento (min)' };
  const cur = document.getElementById(idMap[type])?.textContent;
  const val = prompt(`Nova ${lblMap[type]}:`, cur);
  if (!val || isNaN(val) || !currentUid) return;
  const num = parseFloat(val);
  rtdb.ref(`goals/${currentUid}/${pathMap[type]}`).set(num);
  setText(idMap[type], String(num));
  if (type === 'diaria') {
    GOAL_LIMIT = num;
    setText('goal-limit', num);
    // Sincroniza config do device para o ESP32 ler
    if (activeDeviceId) rtdb.ref(`devices/${activeDeviceId}/config/goal_daily_l`).set(num);
  }
}

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────
function saveProfile() {
  const name = document.getElementById('cfg-name-input')?.value.trim();
  if (!name || !currentUid) return;
  auth.currentUser?.updateProfile({ displayName: name });
  rtdb.ref(`users/${currentUid}`).update({ name, updated_at: Date.now() });
  ['user-name', 'cfg-name-display'].forEach(id => setText(id, name));
  showToast('Nome atualizado!');
}
function savePassword() {
  const np = document.getElementById('cfg-new-pass')?.value;
  const cp = document.getElementById('cfg-confirm-pass')?.value;
  if (!np || np !== cp) { showToast('As senhas não coincidem.', 'error'); return; }
  if (np.length < 6) { showToast('Mínimo 6 caracteres.', 'error'); return; }
  auth.currentUser?.updatePassword(np)
    .then(() => { showToast('Senha alterada!');['cfg-new-pass', 'cfg-confirm-pass'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; }); })
    .catch(() => showToast('Erro. Faça login novamente.', 'error'));
}
function saveNotifications() {
  if (!currentUid) return;
  // v3: notificações em preferences/{uid}/notify — separado das metas
  rtdb.ref(`preferences/${currentUid}/notify`).update({
    push: document.getElementById('notif-push')?.checked ?? true,
    email: document.getElementById('notif-email')?.checked ?? true,
    leak: document.getElementById('notif-leak')?.checked ?? true,
    goal: document.getElementById('notif-goal')?.checked ?? true,
  });
  showToast('Notificações salvas!');
}

// ── TOAST ─────────────────────────────────────────────────────────
function showToast(msg, type = 'success') {
  document.getElementById('toast-msg')?.remove();
  const t = document.createElement('div');
  t.id = 'toast-msg'; t.textContent = msg;
  const isErr = type === 'error';
  Object.assign(t.style, {
    position: 'fixed', bottom: '1.75rem', right: '1.75rem', zIndex: '9999',
    background: isErr ? '#ef4444' : '#10b981',
    color: '#fff', padding: '.8rem 1.3rem',
    borderRadius: '12px', fontSize: '.85rem', fontWeight: '600',
    boxShadow: isErr ? '0 4px 20px rgba(239,68,68,.35)' : '0 4px 20px rgba(16,185,129,.35)',
    animation: 'fadeUp .3s cubic-bezier(.16,1,.3,1)',
    display: 'flex', alignItems: 'center', gap: '.5rem',
    letterSpacing: '-.01em', maxWidth: '300px'
  });
  document.body.appendChild(t);
  setTimeout(() => {
    t.style.animation = 'fadeUp .3s cubic-bezier(.16,1,.3,1) reverse';
    setTimeout(() => t.remove(), 280);
  }, 2800);
}

// ── NAVEGAÇÃO ─────────────────────────────────────────────────────
function showPage(pageId, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-link').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + pageId)?.classList.add('active');
  btn?.classList.add('active');
  if (pageId === 'consumo') updateConsumptionPage();
  if (currentUid) rtdb.ref(`sessions/${currentUid}/last_active`).set(Date.now());
}

// ── LOGOUT ────────────────────────────────────────────────────────
function handleLogout() {
  teardownDeviceListeners();
  refAlerts?.off();
  auth.signOut().then(() => { window.location.href = 'login.html'; });
}

// ── UTILS ─────────────────────────────────────────────────────────
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function todayKey() { return new Date().toISOString().split('T')[0]; }

// ── HELPER: lê daily/{uid}/{YYYY}/{MM}/{DD} ───────────────────────
// O Firebase armazena o consumo diário como número (litros) neste caminho.
function dailyRef(uid, dateKey) {
  const [year, month, day] = dateKey.split('-');
  return rtdb.ref(`daily/${uid}/${year}/${month}/${day}`);
}
function updateDate() {
  const d = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  setText('today-date', d);
  setText('today-date2', d);
}
function animateValue(id, target, decimals) {
  const el = document.getElementById(id);
  if (!el) return;
  const start = parseFloat(el.textContent) || 0;
  if (Math.abs(start - target) < 0.01) { el.textContent = target.toFixed(decimals); return; }
  const dur = 600, begin = performance.now();
  const tick = now => {
    const t = Math.min((now - begin) / dur, 1);
    el.textContent = (start + (target - start) * (1 - Math.pow(1 - t, 3))).toFixed(decimals);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
// ── TEMA ESCURO ───────────────────────────────────────────────────
(function initTheme() {
  const saved = localStorage.getItem('lc_theme') || 'light';
  document.documentElement.setAttribute('data-theme', saved);
})();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  const chk = document.getElementById('cfg-dark-mode');
  if (btn) {
    const moon = btn.querySelector('.icon-moon');
    const sun = btn.querySelector('.icon-sun');
    if (moon) moon.style.display = theme === 'dark' ? 'none' : 'block';
    if (sun) sun.style.display = theme === 'dark' ? 'block' : 'none';
  }
  if (chk) chk.checked = theme === 'dark';
  localStorage.setItem('lc_theme', theme);

  // Rebuild all charts with new theme colors (only if Chart.js is loaded)
  if (typeof Chart === 'undefined') return;
  ['hourly', 'cons', 'hist', 'sparkline-canvas', 'sparkline-consumo'].forEach(_destroyChart);

  // Always rebuild hourly bars (painel)
  renderHourlyBars();

  // Rebuild sparklines if data exists
  if (flowHistory.length) {
    drawSparkline(flowHistory, 'sparkline-canvas');
    drawSparkline(flowHistory, 'sparkline-consumo');
  }

  // Rebuild consumption chart if currently visible
  const consPage = document.getElementById('page-consumo');
  if (consPage && consPage.classList.contains('active')) {
    _loadAndRenderConsumo(_currentPeriod);
  }

  // Rebuild history chart if currently visible and data exists
  const histPage = document.getElementById('page-historico');
  if (histPage && histPage.classList.contains('active') && historyDays.length) {
    const hasAnyData = historyDays.some(d => d.vol > 0);
    _renderHistoryChart(historyDays, hasAnyData);
  }
}

function applyThemeFromToggle(el) {
  applyTheme(el.checked ? 'dark' : 'light');
}

document.getElementById('theme-toggle-btn')?.addEventListener('click', function () {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── HISTÓRICO — dados reais do Firebase (sem fallback aleatório) ──
let historyDays = [];

/**
 * Carrega os últimos 7 dias de aggregates/{deviceId}/daily/{key}.
 * Retorna sempre um array de 7 entradas com vol=0 para dias sem dados.
 * Nunca usa números aleatórios.
 */
async function loadHistoryFromFirebase() {
  const now = new Date();
  const days = [];

  // Monta as 7 datas (do mais antigo ao mais recente)
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    days.push({
      d,
      key,
      isToday: i === 0,
      date: d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
    });
  }

  // Sem dispositivo ou uid: retorna zeros com hasRealData = false
  if (!currentUid) {
    return days.map(({ d, key, isToday, date }) => ({
      date, dateKey: key, isToday,
      vol: 0, peak: 0, active: 0, goal: GOAL_LIMIT, status: 'ok', fromDb: false,
    }));
  }

  // Busca todos os dias em paralelo via daily/{uid}/{YYYY}/{MM}/{DD}
  const results = await Promise.all(
    days.map(({ d, key, isToday, date }) =>
      dailyRef(currentUid, key).once('value').then(snap => {
        const vol = snap.val() ?? 0;
        const goal = GOAL_LIMIT;
        const status = vol > goal ? 'over' : vol > goal * 0.8 ? 'warn' : 'ok';
        return { date, dateKey: key, isToday, vol, peak: 0, active: 0, goal, status, fromDb: snap.val() != null };
      })
    )
  );

  return results;
}

async function renderHistoryPage() {
  const tbody = document.getElementById('history-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-3)">Carregando histórico…</td></tr>';

  historyDays = await loadHistoryFromFirebase();

  const hasAnyData = historyDays.some(d => d.vol > 0);

  // ── Gráfico de barras (Chart.js) ──────────────────────────────
  _renderHistoryChart(historyDays, hasAnyData);

  // ── Tabela ─────────────────────────────────────────────────────
  if (tbody) {
    if (!activeDeviceId) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--text-3)">
        Nenhum dispositivo conectado. Adicione um sensor para ver o histórico.
      </td></tr>`;
      setText('history-count', '0 registros');
      return;
    }

    if (!hasAnyData) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:2.5rem;color:var(--text-3)">
        Sem dados registrados nos últimos 7 dias.<br>
        <span style="font-size:.8rem">Os dados aparecem aqui após o sensor enviar as primeiras leituras.</span>
      </td></tr>`;
      setText('history-count', '0 registros');
      return;
    }

    tbody.innerHTML = historyDays.map(d => {
      const statusClass = d.vol > d.goal ? 'over' : d.vol > d.goal * 0.8 ? 'warn' : 'ok';
      const statusLabel = d.vol > d.goal ? 'Acima' : d.vol > d.goal * 0.8 ? 'Atenção' : (d.vol === 0 && !d.fromDb ? '—' : 'OK');
      const emptyRow = !d.fromDb && d.vol === 0;
      return `<tr ${emptyRow ? 'style="opacity:.45"' : ''}>
        <td>${d.date}</td>
        <td class="td-num">${emptyRow ? '—' : d.vol + ' L'}</td>
        <td class="td-num">${emptyRow ? '—' : d.peak + ' L/h'}</td>
        <td class="td-num">${emptyRow ? '—' : d.active + 'h'}</td>
        <td class="td-num">${d.goal} L</td>
        <td>${emptyRow ? '<span class="badge-s ok">Sem dado</span>' : `<span class="badge-s ${statusClass}">${statusLabel}</span>`}</td>
      </tr>`;
    }).join('');

    const registrosComDados = historyDays.filter(d => d.fromDb).length;
    setText('history-count', `${registrosComDados} registro${registrosComDados !== 1 ? 's' : ''}`);
  }
}

function _renderHistoryChart(days, hasData) {
  const canvas = document.getElementById('history-bar-chart');
  if (!canvas || typeof Chart === 'undefined') return;
  const dark = _isDark();

  _destroyChart('hist');

  if (!hasData) {
    // Draw empty state on canvas
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#8aadc4';
    ctx.font = '13px DM Sans, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem dados de consumo ainda', canvas.width / 2, canvas.height / 2);
    return;
  }

  const labels = days.map(d => d.date.split(',')[0]);
  const vols = days.map(d => d.vol);
  const goals = days.map(d => d.goal);
  const bgColors = days.map((d, i) =>
    i === 6 ? 'rgba(14,165,233,0.9)' :
      d.vol > d.goal ? 'rgba(7,89,133,0.82)' :
        d.vol > d.goal * 0.8 ? 'rgba(56,189,248,0.75)' :
          'rgba(26,172,240,0.6)'
  );
  const bdColors = days.map((d, i) =>
    i === 6 ? '#0ea5e9' :
      d.vol > d.goal ? '#075985' :
        d.vol > d.goal * 0.8 ? '#38bdf8' :
          '#1AACF0'
  );

  _charts['hist'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Consumo (L)', data: vols, backgroundColor: bgColors, borderColor: bdColors, borderWidth: 1, borderRadius: 6, borderSkipped: 'bottom', order: 2 },
        { label: 'Meta (L)', data: goals, type: 'line', borderColor: 'rgba(125,211,252,0.85)', borderWidth: 1.5, borderDash: [5, 4], pointRadius: 0, fill: false, order: 1 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 600 },
      plugins: {
        legend: { display: true, position: 'top', align: 'end', labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: c => c.datasetIndex === 0 ? ' Consumo: ' + c.parsed.y + ' L' : ' Meta: ' + c.parsed.y + ' L'
          }
        }
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 0 } },
        y: { beginAtZero: true, grid: { color: dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }, ticks: { maxTicksLimit: 5, font: { size: 10 }, callback: v => v + 'L' } }
      }
    }
  });
}

function exportHistory() {
  if (!historyDays.length) return;

  const now      = new Date();
  const sep      = ';'; // separador pt-BR — compatível com Excel
  const BOM      = '\uFEFF'; // UTF-8 BOM → Excel lê acentos corretamente
  const q        = v  => `"${String(v).replace(/"/g, '""')}"`;        // escapa aspas duplas
  const num      = v  => String(v).replace('.', ',');                  // decimal pt-BR
  const fmtDate  = d  => new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const row      = (...cells) => cells.map(String).join(sep);

  // ── Metadados ─────────────────────────────────────────────────────
  const deviceName  = document.getElementById('sb-device-name')?.textContent?.trim() || 'Sensor';
  const deviceId    = activeDeviceId || '--';
  const exportedAt  = now.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const daysWithData = historyDays.filter(d => d.fromDb && d.vol > 0);
  const totalVol    = daysWithData.reduce((s, d) => s + d.vol, 0);
  const avgVol      = daysWithData.length > 0 ? totalVol / daysWithData.length : 0;
  const peakDay     = daysWithData.length > 0 ? daysWithData.reduce((best, d) => d.vol > best.vol ? d : best, daysWithData[0]) : null;
  const daysOk      = daysWithData.filter(d => d.vol <= d.goal).length;
  const economy     = Math.max(0, GOAL_LIMIT * daysWithData.length - totalVol);

  const lines = [];

  // ── Bloco de cabeçalho ─────────────────────────────────────────────
  lines.push(row(q('LetControl — Histórico de Consumo')));
  lines.push(row(q('Dispositivo'),   q(deviceName)));
  lines.push(row(q('ID do Sensor'),  q(deviceId)));
  lines.push(row(q('Período'),       q('Últimos 7 dias')));
  lines.push(row(q('Meta diária'),   q(num(GOAL_LIMIT) + ' L')));
  lines.push(row(q('Exportado em'),  q(exportedAt)));
  lines.push(''); // linha em branco

  // ── Cabeçalho das colunas ──────────────────────────────────────────
  lines.push(row(
    q('Data'),
    q('Dia da semana'),
    q('Consumo (L)'),
    q('Meta (L)'),
    q('Diferença (L)'),
    q('% da Meta'),
    q('Status'),
    q('Horas ativas'),
    q('Pico (L/h)'),
  ));

  // ── Linhas de dados ────────────────────────────────────────────────
  historyDays.forEach(d => {
    const dateObj  = new Date(d.dateKey + 'T12:00:00');
    const weekday  = dateObj.toLocaleDateString('pt-BR', { weekday: 'long' });
    const dateStr  = fmtDate(d.dateKey);
    const empty    = !d.fromDb || d.vol === 0;
    const diff     = empty ? '—' : num((d.vol - d.goal).toFixed(1));
    const pct      = empty ? '—' : num(((d.vol / d.goal) * 100).toFixed(1)) + '%';
    const status   = empty
      ? 'Sem dados'
      : d.vol > d.goal       ? 'Acima da meta'
      : d.vol > d.goal * 0.8 ? 'Atenção'
      : 'OK';

    lines.push(row(
      q(dateStr),
      q(weekday),
      empty ? q('—') : num(d.vol.toFixed(1)),
      num(d.goal),
      q(diff),
      q(pct),
      q(status),
      empty ? q('—') : String(d.active),
      empty ? q('—') : num(d.peak.toFixed(2)),
    ));
  });

  // ── Bloco de resumo ────────────────────────────────────────────────
  lines.push('');
  lines.push(row(q('── RESUMO ─────────────────')));
  lines.push(row(q('Total consumido (7 dias)'),  q(num(totalVol.toFixed(1)) + ' L')));
  lines.push(row(q('Média diária'),              q(num(avgVol.toFixed(1))   + ' L')));
  lines.push(row(q('Economia estimada'),         q(num(economy.toFixed(1))  + ' L')));
  lines.push(row(q('Dia de maior consumo'),
    peakDay ? q(fmtDate(peakDay.dateKey) + '  (' + num(peakDay.vol.toFixed(1)) + ' L)') : q('—')
  ));
  lines.push(row(q('Dias dentro da meta'),       q(daysOk + ' de ' + daysWithData.length + ' dias')));
  lines.push(row(q('Dias com dados'),            q(daysWithData.length + ' de 7 dias')));

  // ── Download ───────────────────────────────────────────────────────
  const filename = `letcontrol-historico-${now.toISOString().split('T')[0]}.csv`;
  const blob = new Blob([BOM + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ── RELATÓRIO / ECO SCORE ─────────────────────────────────────────
async function renderReportPage() {
  historyDays = await loadHistoryFromFirebase();

  const hasAnyData = historyDays.some(d => d.fromDb && d.vol > 0);

  // ── Estado vazio: sem dispositivo ou sem dados ─────────────────
  if (!activeDeviceId || !hasAnyData) {
    const emptyMsg = !activeDeviceId
      ? 'Conecte um dispositivo para gerar o relatório semanal.'
      : 'Sem dados de consumo nos últimos 7 dias.<br><span style="font-size:.8rem">O relatório é gerado assim que o sensor enviar leituras.</span>';

    ['report-week-total', 'report-week-save', 'report-best-day', 'report-days-ok'].forEach(id => setText(id, '—'));
    setText('eco-score-num', '--');
    setText('eco-grade', '—');
    setText('eco-desc', emptyMsg.replace(/<[^>]+>/g, ' '));
    setText('eco-badge', 'Sem dados');

    const ring = document.getElementById('eco-ring');
    if (ring) { ring.style.strokeDashoffset = '314'; ring.className = 'eco-ring-fill'; }

    const gradeEl = document.getElementById('eco-grade');
    if (gradeEl) { gradeEl.textContent = '—'; gradeEl.className = 'eco-grade'; }

    // Dicas: estado vazio
    const tipsEl = document.getElementById('report-tips');
    if (tipsEl) {
      tipsEl.innerHTML = `
        <div style="padding:2rem;text-align:center;color:var(--text-3);font-size:.88rem">
          💧 As recomendações personalizadas aparecerão aqui após o sensor registrar dados de consumo.
        </div>`;
    }
    return;
  }

  // ── Cálculos com dados reais ───────────────────────────────────
  const daysWithData = historyDays.filter(d => d.fromDb);
  const weekTotal = historyDays.reduce((s, d) => s + d.vol, 0);
  const avgDaily = daysWithData.length > 0 ? weekTotal / daysWithData.length : 0;
  const daysOk = historyDays.filter(d => d.fromDb && d.vol <= GOAL_LIMIT && d.vol > 0).length;
  const bestDay = daysWithData.reduce((best, d) => d.vol < best.vol ? d : best, daysWithData[0]);
  const saved = Math.max(0, GOAL_LIMIT * daysWithData.length - weekTotal);

  setText('report-week-total', weekTotal.toFixed(0));
  setText('report-week-save', saved.toFixed(0));
  setText('report-best-day', bestDay ? bestDay.date.split(',')[0] : '—');
  setText('report-days-ok', daysOk + '/' + daysWithData.length);

  // Eco score: baseado em % de dias dentro da meta e consumo vs meta
  const compliance = daysWithData.length > 0 ? daysOk / daysWithData.length : 0;
  const avgVsMeta = Math.max(0, 1 - (avgDaily - GOAL_LIMIT * 0.7) / (GOAL_LIMIT * 0.6));
  const score = Math.round(Math.min(100, Math.max(0, (compliance * 60 + avgVsMeta * 40))));
  const circumference = 314;
  const offset = circumference - (score / 100) * circumference;

  setText('eco-score-num', score);
  const ring = document.getElementById('eco-ring');
  if (ring) {
    setTimeout(() => { ring.style.strokeDashoffset = offset; }, 100);
    ring.className = 'eco-ring-fill' + (score >= 70 ? '' : score >= 40 ? ' warn' : ' over');
  }

  let grade, desc, badge;
  if (score >= 85) { grade = '🌿 Excelente'; desc = 'Consumo exemplar! Continue assim.'; badge = 'Ótimo'; }
  else if (score >= 70) { grade = '💧 Bom'; desc = 'Consumo dentro do esperado com pequenas melhorias possíveis.'; badge = 'Bom'; }
  else if (score >= 50) { grade = '⚠️ Regular'; desc = 'Há margem de melhoria no consumo diário.'; badge = 'Regular'; }
  else { grade = '🔴 Crítico'; desc = 'Consumo elevado. Revise seus hábitos e verifique vazamentos.'; badge = 'Crítico'; }

  const gradeEl = document.getElementById('eco-grade');
  if (gradeEl) { gradeEl.textContent = grade; gradeEl.className = 'eco-grade' + (score >= 70 ? '' : score >= 50 ? ' warn' : ' over'); }
  setText('eco-desc', desc);
  setText('eco-badge', badge);

  // ── Dicas personalizadas baseadas nos dados reais ──────────────
  renderReportTips(historyDays, daysWithData, weekTotal, avgDaily, daysOk, score);
}

/**
 * Gera dicas reais com base nos dados do Firebase.
 * Substitui as dicas estáticas hardcodadas no HTML.
 */
function renderReportTips(days, daysWithData, weekTotal, avgDaily, daysOk, score) {
  const tipsEl = document.getElementById('report-tips');
  if (!tipsEl) return;

  const tips = [];

  // Dica 1: meta diária
  const overDays = daysWithData.filter(d => d.vol > d.goal).length;
  if (overDays >= 3) {
    tips.push({ icon: '🔴', cls: 'over', title: 'Meta ultrapassada com frequência', body: `Você excedeu a meta diária em ${overDays} dos últimos ${daysWithData.length} dias com dados. Tente distribuir o uso ao longo do dia.` });
  } else if (overDays > 0) {
    tips.push({ icon: '⚠️', cls: 'warn', title: 'Atenção à meta diária', body: `A meta foi ultrapassada em ${overDays} dia${overDays > 1 ? 's' : ''} esta semana. Pequenos ajustes nos hábitos fazem diferença.` });
  } else {
    tips.push({ icon: '✅', cls: 'save', title: 'Meta diária cumprida', body: `Parabéns! Você ficou dentro da meta de ${GOAL_LIMIT}L em todos os dias registrados esta semana.` });
  }

  // Dica 2: consumo médio vs meta
  if (avgDaily > GOAL_LIMIT * 1.2) {
    tips.push({ icon: '💧', cls: 'over', title: 'Consumo médio acima do ideal', body: `Sua média foi de ${avgDaily.toFixed(0)}L/dia, ${((avgDaily / GOAL_LIMIT - 1) * 100).toFixed(0)}% acima da meta de ${GOAL_LIMIT}L. Verifique torneiras e chuveiros.` });
  } else if (avgDaily > 0 && avgDaily <= GOAL_LIMIT * 0.7) {
    tips.push({ icon: '🌿', cls: 'save', title: 'Consumo eficiente', body: `Seu consumo médio de ${avgDaily.toFixed(0)}L/dia está bem abaixo da meta. Bom trabalho em economizar água!` });
  } else if (avgDaily > 0) {
    tips.push({ icon: '📊', cls: 'info', title: 'Consumo dentro da faixa esperada', body: `Média de ${avgDaily.toFixed(0)}L/dia esta semana. Meta: ${GOAL_LIMIT}L. Mantenha o controle para não ultrapassar.` });
  }

  // Dica 3: melhor dia vs pior dia
  if (daysWithData.length >= 2) {
    const maxDay = daysWithData.reduce((a, b) => b.vol > a.vol ? b : a, daysWithData[0]);
    const minDay = daysWithData.reduce((a, b) => b.vol < a.vol ? b : a, daysWithData[0]);
    if (maxDay.vol > 0 && minDay.vol > 0 && maxDay.vol > minDay.vol * 1.5) {
      tips.push({ icon: '📅', cls: 'info', title: 'Variação elevada no consumo', body: `Pior dia: ${maxDay.date.split(',')[0]} com ${maxDay.vol}L. Melhor dia: ${minDay.date.split(',')[0]} com ${minDay.vol}L. Tente manter consistência.` });
    }
  }

  // Dica 4: score baixo
  if (score < 40 && daysWithData.length >= 4) {
    tips.push({ icon: '🚨', cls: 'over', title: 'Eco Score crítico', body: 'Seu consumo está significativamente acima do ideal. Verifique possíveis vazamentos e reavalie seus hábitos de uso.' });
  }

  if (tips.length === 0) {
    tips.push({ icon: '💧', cls: 'save', title: 'Tudo certo por aqui', body: 'Seus dados de consumo estão dentro do esperado. Continue monitorando para manter um ótimo desempenho.' });
  }

  tipsEl.innerHTML = tips.map(t => `
    <div class="report-tip">
      <div class="tip-icon ${t.cls}">${t.icon}</div>
      <div>
        <div class="tip-title">${t.title}</div>
        <div class="tip-body">${t.body}</div>
      </div>
    </div>`).join('');
}

// ── BUSCA RÁPIDA ──────────────────────────────────────────────────
document.getElementById('nav-search-input')?.addEventListener('keydown', function (e) {
  if (e.key !== 'Enter') return;
  const q = this.value.toLowerCase().trim();
  const pages = ['painel', 'consumo', 'metas', 'historico', 'relatorio', 'alertas', 'dispositivos', 'configuracoes'];
  const map = {
    'painel': 0, 'consumo': 1, 'metas': 2, 'historico': 3, 'histórico': 3,
    'relatorio': 4, 'relatório': 4, 'alertas': 5, 'dispositivos': 6,
    'configuracoes': 7, 'configurações': 7, 'config': 7, 'settings': 7
  };
  for (const [k, idx] of Object.entries(map)) {
    if (q.includes(k)) {
      const links = document.querySelectorAll('.sidebar-link');
      showPage(pages[idx], links[idx]);
      this.value = '';
      return;
    }
  }
  showToast('Página não encontrada: "' + q + '"', 'error');
});

// ── OVERRIDE showPage para novas páginas ──────────────────────────
const _origShowPage = showPage;
window.showPage = function (pageId, btn) {
  _origShowPage(pageId, btn);
  if (pageId === 'historico') renderHistoryPage();
  if (pageId === 'relatorio') renderReportPage();
  if (pageId === 'consumo') updateConsumptionPage();
  // Oculta FAB na página de dispositivos (já tem botão próprio)
  const fab = document.getElementById('fab-add-device');
  if (fab && !hasDevice) fab.style.display = pageId === 'dispositivos' ? 'none' : 'inline-flex';
  // scroll to top on page change
  const content = document.querySelector('.dash-content');
  if (content) content.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'smooth' });
};