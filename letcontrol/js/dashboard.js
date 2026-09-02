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

// ── METAS PERSONALIZADAS ────────────────────────────────────────────
let customGoals = {};       // { id: { name, target_l, period, date, created_at } }
let _editingGoalId = null;  // id sendo editado no modal, ou null se for meta nova
let _dayTotal = 0;
let _weekTotal = 0;
let _monthTotal = 0;

// ── DETECÇÃO DE VAZAMENTO ─────────────────────────────────────────
// Critério: fluxo contínuo >= LEAK_LPM por >= LEAK_MIN minutos.
let LEAK_MIN = 30;     // minutos mínimos de fluxo contínuo
let LEAK_LPM = 0.5;    // L/min mínimo para contar como "fluxo"
const LEAK_COOLDOWN_MS = 60 * 60 * 1000; // 1h entre alertas do mesmo episódio
const leakState = {
  startTs: null,      // ts da primeira leitura do episódio atual
  lastTs: null,       // ts da última leitura acima do threshold
  alertId: null,      // id do alerta aberto (para gravar resolved_at)
  lastAlertAt: 0,     // throttle global
};

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
  updateGreeting();
}

// ── DISPOSITIVOS DO USUÁRIO + MODO "CASA TODA" ───────────────────
let userDeviceIds = [];        // todos os IDs de dispositivos do usuário
let viewMode = 'single';       // 'single' ou 'house'
const houseLiveData = new Map(); // deviceId -> última leitura live
const houseLiveRefs = [];      // refs ativas no modo casa toda

async function resolveActiveDevice(uid) {
  // Carrega lista completa de dispositivos
  const devSnap = await rtdb.ref(`user_devices/${uid}`).once('value');
  const map = devSnap.val() || {};
  userDeviceIds = Object.keys(map);

  // 1) Sessão salva
  const sessSnap = await rtdb.ref(`sessions/${uid}/active_device_id`).once('value');
  let deviceId = sessSnap.val();

  // 2) Fallback: primeiro dispositivo do usuário
  if (!deviceId && userDeviceIds.length) deviceId = userDeviceIds[0];

  // Modo persistido
  try { viewMode = localStorage.getItem('lc_view_mode') || 'single'; } catch { }
  if (viewMode === 'house' && userDeviceIds.length < 2) viewMode = 'single';

  activeDeviceId = deviceId || null;
  renderHouseToggle();

  if (viewMode === 'house') {
    startHouseListeners(uid);
  } else {
    startListeners(uid, activeDeviceId);
  }
}

function renderHouseToggle() {
  const slot = document.getElementById('view-mode-toggle');
  if (!slot) return;
  if (userDeviceIds.length < 2) { slot.style.display = 'none'; return; }
  slot.style.display = 'inline-flex';
  slot.innerHTML = `
    <button class="vm-btn ${viewMode === 'single' ? 'active' : ''}" onclick="setViewMode('single')" title="Apenas o dispositivo ativo">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="9"/></svg>
      <span>Sensor</span>
    </button>
    <button class="vm-btn ${viewMode === 'house' ? 'active' : ''}" onclick="setViewMode('house')" title="Soma de todos os sensores">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12l9-9 9 9M5 10v10h14V10"/></svg>
      <span>Casa toda <em>(${userDeviceIds.length})</em></span>
    </button>`;
}

function setViewMode(mode) {
  if (mode === viewMode) return;
  if (mode === 'house' && userDeviceIds.length < 2) return;
  viewMode = mode;
  try { localStorage.setItem('lc_view_mode', mode); } catch { }

  // Limpa todos os listeners ativos antes de trocar
  teardownDeviceListeners();
  teardownHouseListeners();

  renderHouseToggle();
  if (mode === 'house') startHouseListeners(currentUid);
  else startListeners(currentUid, activeDeviceId);
}

// Listeners "casa toda": agregam live de todos os dispositivos.
function startHouseListeners(uid) {
  // Goals, alertas, daily (já por-uid) — reaproveita startListeners SEM
  // dispositivo, só pra montar metas/preferências/alertas/daily.
  startListeners(uid, null);

  if (!userDeviceIds.length) return;

  setText('sb-device-name', 'Modo casa toda');
  setText('sb-device-status', `${userDeviceIds.length} sensores ativos`);
  setText('device-name', `Casa toda (${userDeviceIds.length} sensores)`);
  // Mantém a aparência "online" no sidebar enquanto há sensores
  const status = document.getElementById('sb-device-status')?.parentElement;
  if (status) status.classList.remove('offline');

  houseLiveData.clear();
  for (const did of userDeviceIds) {
    const ref = rtdb.ref(`readings/${did}/live`);
    const handler = snap => {
      const d = snap.val();
      if (d) houseLiveData.set(did, d);
      else houseLiveData.delete(did);
      renderHouseAggregated();
    };
    ref.on('value', handler);
    houseLiveRefs.push({ ref, handler });
  }
}

function teardownHouseListeners() {
  for (const { ref, handler } of houseLiveRefs) ref.off('value', handler);
  houseLiveRefs.length = 0;
  houseLiveData.clear();
}

function renderHouseAggregated() {
  let totalFlow = 0, totalVol = 0, anyOpen = false, online = 0;
  for (const d of houseLiveData.values()) {
    totalFlow += Number(d.flow_lpm) || 0;
    totalVol += Number(d.vol_today_l) || 0;
    if (d.valve_open) anyOpen = true;
    online++;
  }
  updateMetrics({
    flow_lpm: totalFlow,
    vol_today_l: totalVol,
    valve_open: anyOpen,
  });
  updateGoalBar(totalVol, GOAL_LIMIT);
  setText('last-seen', online + ' sensor' + (online !== 1 ? 'es' : ''));
  setText('spec-last', new Date().toLocaleTimeString('pt-BR'));
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
    if (g.leak_min) { LEAK_MIN = g.leak_min; setText('meta-leak-limit', g.leak_min); }
    if (g.leak_lpm) { LEAK_LPM = g.leak_lpm; setText('meta-leak-flow', g.leak_lpm); }
    renderMonthlyGoalDate(g.monthly_date || '');
    // Compute weekly and monthly usage from aggregates after goals load
    if (deviceId) loadPeriodTotals(deviceId, g);
  });

  // Metas personalizadas (criadas pelo usuário, com data opcional em mensais)
  rtdb.ref(`goals/${uid}/custom`).on('value', snap => {
    customGoals = snap.val() || {};
    renderCustomGoals();
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
    evaluateLeak(d);
    renderLeakStatus(d);
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

  // Varredura retroativa: detecta vazamento que tenha ocorrido
  // enquanto o dashboard estava fechado. Roda uma vez por sessão de device.
  scanHistoryForLeak(deviceId);
  // Detecção de anomalias além de vazamento (pico off-hour, queda, dia incomum)
  detectAnomalies(deviceId);

  // Agregados horários — lidos direto de daily/{uid}/YYYY/MM/DD,
  // onde cada chave HH é o consumo em litros daquela hora.
  const today = todayKey();
  const [yy, mm, dd] = today.split('-');
  rtdb.ref(`daily/${uid}/${yy}/${mm}/${dd}`).on('value', snap => {
    const hours = snap.val() || {};
    hourlyData = Array(24).fill(0);
    Object.entries(hours).forEach(([h, val]) => {
      const idx = +h;
      if (Number.isInteger(idx) && idx >= 0 && idx < 24 && typeof val === 'number') {
        hourlyData[idx] = val;
      }
    });
    renderHourlyBars();
    updateConsumptionPage();
  });

  // Diário atual (para meta bar) — lê consumoHoje de daily/{uid}.
  // Fallback: se consumoHoje não existir, soma as horas do dia atual.
  rtdb.ref(`daily/${uid}/consumoHoje`).on('value', snap => {
    let vol = snap.val();
    if (vol == null) vol = hourlyData.reduce((a, b) => a + b, 0);
    updateGoalBar(vol || 0, GOAL_LIMIT);
  });
}

// ── TOTAIS SEMANAIS / MENSAIS ─────────────────────────────────────
async function loadPeriodTotals(deviceId, goals) {
  const now = new Date();
  // Week: last 7 days — somados a partir dos nós diários
  let weekTotal = 0;
  // Month: tenta usar daily/{uid}/consumoMes (agregado pré-computado);
  // se não existir, soma os dias do mês corrente.
  let monthTotal = 0;
  const dayOfMonth = now.getDate();
  const promises = [];
  for (let i = 0; i < Math.max(7, dayOfMonth); i++) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    promises.push(dailyRef(currentUid, key).once('value').then(snap => ({
      key, i, vol: dailyTotal(snap), dayOffset: i
    })));
  }
  const [results, monthAggSnap] = await Promise.all([
    Promise.all(promises),
    rtdb.ref(`daily/${currentUid}/consumoMes`).once('value'),
  ]);
  results.forEach(r => {
    if (r.dayOffset < 7) weekTotal += r.vol;
    const d = new Date(now); d.setDate(d.getDate() - r.dayOffset);
    if (d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear()) monthTotal += r.vol;
  });
  const monthAgg = monthAggSnap.val();
  if (typeof monthAgg === 'number') monthTotal = monthAgg;

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

  _weekTotal = weekTotal;
  _monthTotal = monthTotal;
  renderCustomGoals();
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
  updateReservoir(used, limit);
  _dayTotal = used;
  renderCustomGoals();
}

// ── RESERVATÓRIO ANIMADO ─────────────────────────────────────────
// Mostra o quanto AINDA tem disponível da meta diária. Cheio = 100%
// da quota; esvazia conforme o consumo se aproxima do limite.
function updateReservoir(used, limit) {
  const water = document.getElementById('reservoir-water');
  if (!water) return;
  const remainPct = Math.max(0, Math.min(100, (1 - used / limit) * 100));
  // SVG tem 178px de altura interna (y=22 a y=200). Translada o grupo
  // verticalmente: 0px = cheio (água ocupa todo o tanque), 178px = vazio.
  const offset = (1 - remainPct / 100) * 178;
  water.style.transform = `translateY(${offset.toFixed(1)}px)`;

  setText('reservoir-pct', Math.round(remainPct));
  setText('reservoir-remaining', Math.round(Math.max(limit - used, 0)));
  setText('reservoir-badge', Math.round(remainPct) + '%');

  const card = document.querySelector('.reservoir-card');
  if (card) {
    card.classList.remove('warn', 'over');
    if (remainPct <= 0) card.classList.add('over');
    else if (remainPct <= 20) card.classList.add('warn');
  }
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
  // a.message é gravado via Cloud Function (Admin SDK, texto fixo com
  // números) ou por escritas do próprio client — nunca é HTML confiável.
  // a.id normalmente é uma push key do Firebase (charset seguro), mas
  // escapamos mesmo assim por segurança, já que vai dentro de um atributo.
  return `
    <div class="alert-item ${a.read ? 'read' : ''}" onclick="markAlertRead('${escapeHtml(a.id)}')">
      <div class="alert-type-indicator ${a.severity || 'low'}"></div>
      <div class="alert-body">
        <div class="alert-type-label">${ALERT_LABELS[a.type] || 'Alerta'}</div>
        <div class="alert-msg">${escapeHtml(a.message || '')}</div>
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

// ── DETECÇÃO DE VAZAMENTO ─────────────────────────────────────────
// Estratégia: a cada leitura live, mede o tempo de fluxo contínuo
// acima de LEAK_LPM. Se passar de LEAK_MIN minutos, dispara um alerta
// LEAK_DETECTED. Quando o fluxo cai, resolve o alerta automaticamente.
function evaluateLeak(d) {
  if (!currentUid || !d) return;
  const ts = d.ts || Date.now();
  const flow = d.flow_lpm ?? 0;
  const valveOpen = d.valve_open ?? true;

  // Válvula fechada → não pode haver vazamento; reseta sem alertar.
  if (!valveOpen) { resolveLeakAlert(ts); return; }

  if (flow >= LEAK_LPM) {
    if (leakState.startTs == null) leakState.startTs = ts;
    leakState.lastTs = ts;
    const durMs = ts - leakState.startTs;
    const cooldownOk = (ts - leakState.lastAlertAt) > LEAK_COOLDOWN_MS;
    if (durMs >= LEAK_MIN * 60000 && !leakState.alertId && cooldownOk) {
      pushLeakAlert(Math.round(durMs / 60000), flow, leakState.startTs);
    }
  } else {
    resolveLeakAlert(ts);
  }
}

function resolveLeakAlert(ts) {
  if (leakState.alertId && currentUid) {
    rtdb.ref(`alerts/${currentUid}/${leakState.alertId}`)
      .update({ resolved_at: ts || Date.now() })
      .catch(() => { });
  }
  leakState.startTs = null;
  leakState.lastTs = null;
  leakState.alertId = null;
}

function pushLeakAlert(durMin, flow, startTs) {
  const ref = rtdb.ref(`alerts/${currentUid}`).push();
  const a = {
    type: 'LEAK_DETECTED',
    severity: 'high',
    message: `Fluxo contínuo de ${flow.toFixed(2)} L/min detectado por ${durMin} min.`,
    created_at: startTs || Date.now(),
    read: false,
  };
  ref.set(a).then(() => {
    leakState.alertId = ref.key;
    leakState.lastAlertAt = Date.now();
    showToast(`Vazamento detectado: ${durMin} min de fluxo contínuo`, 'error');
  }).catch(e => console.error('LEAK alert falhou:', e));
}

// Atualiza indicador visual de status de vazamento na página de metas.
function renderLeakStatus(d) {
  const el = document.getElementById('meta-leak-status');
  if (!el) return;
  const flow = d.flow_lpm ?? 0;
  if (leakState.alertId) {
    el.textContent = 'Vazamento ativo';
    el.className = 'leak-status over';
  } else if (flow >= LEAK_LPM && leakState.startTs) {
    const mins = Math.floor((Date.now() - leakState.startTs) / 60000);
    el.textContent = `Fluxo contínuo há ${mins} min`;
    el.className = 'leak-status warn';
  } else {
    el.textContent = 'OK';
    el.className = 'leak-status ok';
  }
}

// Varre a janela recente de readings/history para detectar episódios
// de vazamento que tenham ocorrido com o dashboard fechado.
// Cria UM alerta retroativo por episódio detectado (deduplicado por janela).
async function scanHistoryForLeak(deviceId) {
  if (!currentUid || !deviceId) return;
  try {
    // Pega até 2h de leituras (~1440 amostras a 5s) — limite seguro.
    const snap = await rtdb.ref(`readings/${deviceId}/history`)
      .limitToLast(1500).once('value');
    const val = snap.val();
    if (!val) return;
    const readings = Object.values(val)
      .filter(r => r && r.ts != null)
      .sort((a, b) => a.ts - b.ts);
    if (readings.length < 2) return;

    let runStart = null, runEnd = null;
    const episodes = [];
    for (const r of readings) {
      if ((r.f ?? 0) >= LEAK_LPM) {
        if (runStart == null) runStart = r.ts;
        runEnd = r.ts;
      } else {
        if (runStart != null && runEnd - runStart >= LEAK_MIN * 60000) {
          episodes.push({ start: runStart, end: runEnd });
        }
        runStart = null; runEnd = null;
      }
    }
    if (runStart != null && runEnd - runStart >= LEAK_MIN * 60000) {
      episodes.push({ start: runStart, end: runEnd });
    }
    for (const ep of episodes) await maybePushHistoricalLeak(ep.start, ep.end);
  } catch (e) {
    console.warn('scanHistoryForLeak falhou:', e?.message || e);
  }
}

// ── DETECÇÃO DE ANOMALIAS DE CONSUMO ──────────────────────────────
// Roda 1x por sessão (após carregar histórico) e detecta:
//   - Pico off-hour:   consumo em hora que normalmente é seca (3h, 4h...)
//   - Queda súbita:    sensor parou de marcar — possível entupimento
//   - Dia incomum:     uso em dia da semana que historicamente é zero
//
// Estratégia: constrói baseline por hora-do-dia a partir dos últimos
// ~14 dias (medianas) e compara com hoje. Cria alertas em alerts/{uid}.
// Dedup: ignora se já houver alerta do mesmo tipo nas últimas 12h.
async function detectAnomalies(deviceId) {
  if (!currentUid) return;
  try {
    // Coleta últimos 14 dias de mapas horários (daily/{uid}/YYYY/MM/DD)
    const now = new Date();
    const days = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setDate(d.getDate() - i);
      const key = d.toISOString().split('T')[0];
      days.push({ d, key, ago: i });
    }
    const snaps = await Promise.all(
      days.map(({ key }) => dailyRef(currentUid, key).once('value'))
    );

    // Monta matriz [day][hour] = litros
    const matrix = snaps.map(s => {
      const v = s.val();
      const row = Array(24).fill(0);
      if (v && typeof v === 'object') {
        for (const k in v) {
          const idx = +k;
          if (Number.isInteger(idx) && idx >= 0 && idx < 24 && typeof v[k] === 'number') row[idx] = v[k];
        }
      }
      return row;
    });

    // Baseline = mediana por hora dos últimos 13 dias (exclui hoje)
    const past = matrix.slice(1);
    const baselineMedian = Array(24).fill(0);
    const baselineMax = Array(24).fill(0);
    for (let h = 0; h < 24; h++) {
      const vals = past.map(r => r[h]).sort((a, b) => a - b);
      baselineMedian[h] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
      baselineMax[h] = vals.length ? vals[vals.length - 1] : 0;
    }

    const today = matrix[0];
    const todayTotal = today.reduce((a, b) => a + b, 0);

    // Recupera alertas das últimas 12h pra deduplicação
    const recentSnap = await rtdb.ref(`alerts/${currentUid}`)
      .orderByChild('created_at')
      .startAt(Date.now() - 12 * 60 * 60 * 1000)
      .once('value');
    const recent = recentSnap.val() || {};
    const hasRecent = type => Object.values(recent).some(a => a?.type === type);

    const anomalies = [];

    // (1) PICO OFF-HOUR: hora atual > 2L mas baseline mediano dessa hora < 0.5L
    const curHour = now.getHours();
    const curHourVal = today[curHour] || 0;
    if (curHourVal >= 2 && baselineMedian[curHour] < 0.5 && baselineMax[curHour] < 1.5) {
      anomalies.push({
        type: 'ABNORMAL_FLOW',
        severity: 'medium',
        message: `Consumo de ${Math.round(curHourVal)}L às ${curHour}h — incomum nesse horário.`,
      });
    }

    // (2) QUEDA SÚBITA: histórico ativo (>=5L) mas hoje quase nada após
    //     uma hora em que normalmente já houve uso significativo
    const baselineUntilNow = baselineMedian.slice(0, curHour + 1).reduce((a, b) => a + b, 0);
    const todayUntilNow = today.slice(0, curHour + 1).reduce((a, b) => a + b, 0);
    if (curHour >= 10 && baselineUntilNow >= 15 && todayUntilNow < baselineUntilNow * 0.15) {
      anomalies.push({
        type: 'ABNORMAL_FLOW',
        severity: 'medium',
        message: `Consumo muito abaixo do normal hoje (${Math.round(todayUntilNow)}L até ${curHour}h vs ~${Math.round(baselineUntilNow)}L esperados). Verifique o sensor.`,
      });
    }

    // (3) DIA INCOMUM: dia-da-semana historicamente sem uso, mas hoje > 5L
    const dow = now.getDay();
    const sameDow = past
      .map((row, i) => ({ vol: row.reduce((a, b) => a + b, 0), ago: i + 1 }))
      .filter((_, i) => {
        const d = new Date(now); d.setDate(d.getDate() - (i + 1));
        return d.getDay() === dow;
      });
    if (sameDow.length >= 2 && sameDow.every(s => s.vol < 1) && todayTotal >= 5) {
      const dayName = now.toLocaleDateString('pt-BR', { weekday: 'long' });
      anomalies.push({
        type: 'ABNORMAL_FLOW',
        severity: 'low',
        message: `Uso de ${Math.round(todayTotal)}L em ${dayName} — esse dia normalmente fica zerado.`,
      });
    }

    // Cria alertas (deduplica por tipo+mensagem)
    for (const a of anomalies) {
      const dupKey = (a.type + '|' + a.message).slice(0, 80);
      if (Object.values(recent).some(r => r && (r.message || '').slice(0, 80) === a.message.slice(0, 80))) continue;
      if (hasRecent(a.type) && a.severity === 'low') continue;
      const ref = rtdb.ref(`alerts/${currentUid}`).push();
      await ref.set({ ...a, created_at: Date.now(), device_id: deviceId, read: false });
    }
  } catch (e) {
    console.warn('detectAnomalies falhou:', e?.message || e);
  }
}

async function maybePushHistoricalLeak(startTs, endTs) {
  // Evita duplicar: se já existe um LEAK_DETECTED com created_at perto
  // do startTs (± 10 min), ignora.
  const window = 10 * 60000;
  const snap = await rtdb.ref(`alerts/${currentUid}`)
    .orderByChild('created_at')
    .startAt(startTs - window)
    .endAt(startTs + window)
    .once('value');
  const existing = snap.val() || {};
  for (const k in existing) {
    if (existing[k]?.type === 'LEAK_DETECTED') return;
  }
  const durMin = Math.round((endTs - startTs) / 60000);
  const ref = rtdb.ref(`alerts/${currentUid}`).push();
  await ref.set({
    type: 'LEAK_DETECTED',
    severity: 'high',
    message: `Vazamento retroativo: fluxo contínuo por ${durMin} min.`,
    created_at: startTs,
    read: false,
  });
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
  ['add-dev-name', 'add-dev-id', 'add-dev-location-other'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const g = document.getElementById('add-dev-goal'); if (g) g.value = '175';
  const loc = document.getElementById('add-dev-location'); if (loc) loc.value = 'caixa_dagua';
  onDeviceLocationChange();
  const err = document.getElementById('step1-error');
  if (err) err.style.display = 'none';
}
// Mostra o campo "Qual local?" quando o usuário escolhe "Outro" no select.
function onDeviceLocationChange() {
  const isOther = document.getElementById('add-dev-location')?.value === 'outro';
  const field = document.getElementById('add-dev-location-other-field');
  if (field) field.style.display = isOther ? 'flex' : 'none';
  if (isOther) document.getElementById('add-dev-location-other')?.focus();
}
function closeAddDevice() {
  document.getElementById('modal-add-device').classList.add('hidden');
  if (document.getElementById('modal-step-2')?.style.display !== 'none')
    showPage('painel', document.querySelector('.sidebar-link'));
}
// Passo 2 é só a confirmação (a etapa de Wi-Fi foi removida por enquanto —
// o pareamento da rede volta a ser feito depois, quando essa parte voltar).
function goStep(n) {
  [1, 2].forEach(i => {
    const el = document.getElementById(`modal-step-${i}`);
    if (el) el.style.display = i === n ? 'block' : 'none';
  });
}
function validateStep1() {
  const name = document.getElementById('add-dev-name')?.value.trim();
  const id = document.getElementById('add-dev-id')?.value.trim();
  const location = document.getElementById('add-dev-location')?.value;
  const locationOther = document.getElementById('add-dev-location-other')?.value.trim();
  const err = document.getElementById('step1-error');
  if (!name) { if (err) { err.textContent = 'Informe o nome do dispositivo.'; err.style.display = 'block'; } return false; }
  if (!id) { if (err) { err.textContent = 'Informe o Device ID.'; err.style.display = 'block'; } return false; }
  if (location === 'outro' && !locationOther) { if (err) { err.textContent = 'Informe qual é o local de instalação.'; err.style.display = 'block'; } return false; }
  if (err) err.style.display = 'none';
  return true;
}
// Resolve o valor final do local de instalação: usa o texto digitado
// quando "Outro" for escolhido no select.
function resolveDeviceLocation() {
  const select = document.getElementById('add-dev-location')?.value || 'nao_definido';
  if (select === 'outro') {
    const custom = document.getElementById('add-dev-location-other')?.value.trim();
    return custom || 'outro';
  }
  return select;
}

async function saveDevice() {
  const err = document.getElementById('step1-error');
  if (!validateStep1()) return;

  const btnSave = document.getElementById('btn-save-device');
  const spin = document.getElementById('save-btn-spin');
  const text = document.getElementById('save-btn-text');
  if (btnSave) btnSave.disabled = true;
  if (spin) spin.style.display = 'block';
  if (text) text.style.display = 'none';

  const name = document.getElementById('add-dev-name')?.value.trim();
  const deviceId = document.getElementById('add-dev-id')?.value.trim();
  const location = resolveDeviceLocation();
  const goal = parseFloat(document.getElementById('add-dev-goal')?.value) || 175;
  const now = Date.now();
  const today = todayKey();

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
    // Pareamento de Wi-Fi removido por enquanto — volta quando essa etapa
    // for reintroduzida no assistente de cadastro.
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
    goStep(2);

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

// ── MODAL: RENOMEAR DISPOSITIVO ─────────────────────────────────────
function openRenameDevice() {
  const name = document.getElementById('dev-name-big')?.textContent;
  const input = document.getElementById('rename-device-input');
  if (input) input.value = (name && name !== '--') ? name : '';
  const err = document.getElementById('rename-device-error');
  if (err) err.style.display = 'none';
  document.getElementById('modal-rename-device')?.classList.remove('hidden');
  input?.focus();
}
function closeRenameDevice() {
  document.getElementById('modal-rename-device')?.classList.add('hidden');
}
function saveRenameDevice() {
  const input = document.getElementById('rename-device-input');
  const err = document.getElementById('rename-device-error');
  const showErr = msg => { if (err) { err.textContent = msg; err.style.display = 'block'; } };
  const n = input?.value.trim();
  if (!n) return showErr('Informe um nome.');
  if (!activeDeviceId) return showErr('Nenhum dispositivo selecionado.');
  if (err) err.style.display = 'none';

  rtdb.ref(`devices/${activeDeviceId}/name`).set(n)
    .then(() => {
      setText('dev-name-big', n);
      showToast('Nome atualizado!');
      closeRenameDevice();
    })
    .catch(e => {
      console.error('Erro ao renomear dispositivo:', e);
      showErr(e?.code === 'PERMISSION_DENIED'
        ? 'Sem permissão para renomear este dispositivo.'
        : 'Erro ao salvar. Tente novamente.');
    });
}

// ── MODAL DE CONFIRMAÇÃO GENÉRICA ───────────────────────────────────
// Reaproveitada por qualquer ação destrutiva do app — evita alert()/
// confirm() nativos do navegador.
let _confirmModalCallback = null;
function openConfirmModal(title, sub, onConfirm, confirmLabel) {
  setText('confirm-modal-title', title);
  setText('confirm-modal-sub', sub);
  const btn = document.getElementById('confirm-modal-btn');
  if (btn) btn.textContent = confirmLabel || 'Confirmar';
  _confirmModalCallback = onConfirm;
  document.getElementById('modal-confirm')?.classList.remove('hidden');
}
function closeConfirmModal() {
  document.getElementById('modal-confirm')?.classList.add('hidden');
  _confirmModalCallback = null;
}
function _confirmModalYes() {
  const cb = _confirmModalCallback;
  closeConfirmModal();
  if (cb) cb();
}

function confirmRemoveDevice() {
  const name = document.getElementById('dev-name-big')?.textContent;
  openConfirmModal(
    'Remover dispositivo',
    `Remover "${name}"? Leituras e agregados serão mantidos.`,
    () => {
      if (!activeDeviceId || !currentUid) return;
      const updates = {};
      updates[`devices/${activeDeviceId}`] = null;
      updates[`user_devices/${currentUid}/${activeDeviceId}`] = null;
      updates[`sessions/${currentUid}/active_device_id`] = null;
      rtdb.ref().update(updates)
        .then(() => {
          teardownDeviceListeners();
          activeDeviceId = null;
          checkDeviceState({ val: () => null });
          showToast('Dispositivo removido.');
        })
        .catch(e => {
          console.error('Erro ao remover dispositivo:', e);
          showToast('Erro ao remover dispositivo.', 'error');
        });
    },
    'Remover'
  );
}

document.getElementById('modal-add-device')?.addEventListener('click', function (e) {
  if (e.target === this) closeAddDevice();
});

function teardownDeviceListeners() {
  if (activeDeviceId) {
    rtdb.ref(`readings/${activeDeviceId}/live`).off();
    rtdb.ref(`readings/${activeDeviceId}/history`).off();
    rtdb.ref(`devices/${activeDeviceId}`).off();
  }
  if (currentUid) {
    const [yy, mm, dd] = todayKey().split('-');
    rtdb.ref(`daily/${currentUid}/${yy}/${mm}/${dd}`).off();
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
  let chartCompare = null; // overlay opcional (ex.: ano anterior)
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
      const v = dailyTotal(snap);
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
      days.push({ key: d.toISOString().split('T')[0], date: new Date(d) });
    }
    // Busca paralela: ano atual + mesmas datas do ano passado
    const [snaps, snapsPrev] = await Promise.all([
      Promise.all(days.map(({ key }) => dailyRef(currentUid, key).once('value'))),
      Promise.all(days.map(({ date }) => {
        const prev = new Date(date);
        prev.setFullYear(prev.getFullYear() - 1);
        return dailyRef(currentUid, prev.toISOString().split('T')[0]).once('value');
      })),
    ]);

    const prevData = [];
    let prevTotal = 0;
    snaps.forEach((snap, i) => {
      const v = dailyTotal(snap);
      const d = new Date(now);
      d.setDate(d.getDate() - (29 - i));
      const label = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
      chartLabels.push(label);
      chartData.push(v);
      total += v;
      if (v > peak) peak = v;
      if (v > 0) active++;
      const pv = dailyTotal(snapsPrev[i]);
      prevData.push(pv);
      prevTotal += pv;
    });
    // Expõe overlay do ano passado pro _renderConsChart
    chartCompare = { label: 'Ano anterior', data: prevData, total: prevTotal };

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
      // Cada chave é um dia (DD), cujo valor é um mapa { HH: litros }.
      // Soma todas as horas de todos os dias do mês.
      let v = 0;
      for (const dayKey in monthData) v += sumHourlyVal(monthData[dayKey]);
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

  // Card de comparação ano a ano (só no período 'mes')
  const cmpEl = document.getElementById('cons-yoy-card');
  if (cmpEl) {
    if (period === 'mes' && chartCompare && chartCompare.total > 0) {
      const diff = total - chartCompare.total;
      const pct = chartCompare.total > 0 ? Math.round((diff / chartCompare.total) * 100) : 0;
      const dir = diff < 0 ? '▼' : diff > 0 ? '▲' : '=';
      const color = diff < 0 ? 'var(--green)' : diff > 0 ? 'var(--red)' : 'var(--text-3)';
      cmpEl.style.display = 'flex';
      cmpEl.innerHTML = `
        <div class="yoy-col">
          <div class="yoy-label">Mês atual</div>
          <div class="yoy-value">${Math.round(total)}<span class="yoy-unit">L</span></div>
        </div>
        <div class="yoy-col">
          <div class="yoy-label">Mesmo período · ano anterior</div>
          <div class="yoy-value">${Math.round(chartCompare.total)}<span class="yoy-unit">L</span></div>
        </div>
        <div class="yoy-col delta">
          <div class="yoy-label">Variação</div>
          <div class="yoy-value" style="color:${color}">${dir} ${Math.abs(pct)}%</div>
        </div>`;
    } else {
      cmpEl.style.display = 'none';
    }
  }

  _renderConsChart(chartLabels, chartData, period, chartCompare);
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

function _renderConsChart(labels, data, period, compare) {
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

  const datasets = [
    {
      label: 'Consumo (L)', data, backgroundColor: bgColors, borderColor: bdColors,
      borderWidth: 1.5, borderRadius: 6, borderSkipped: 'bottom', order: 2,
    },
  ];
  // Overlay opcional do ano anterior (linha tracejada)
  if (compare && compare.data?.length) {
    datasets.push({
      label: compare.label || 'Ano anterior',
      data: compare.data,
      type: 'line',
      borderColor: dark ? 'rgba(148, 163, 184, 0.9)' : 'rgba(100, 116, 139, 0.85)',
      backgroundColor: 'transparent',
      borderWidth: 1.8,
      borderDash: [6, 4],
      pointRadius: 0,
      pointHoverRadius: 4,
      pointBackgroundColor: dark ? '#94a3b8' : '#475569',
      tension: 0.35,
      fill: false,
      order: 1,
    });
  }

  _charts['cons'] = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 500 },
      plugins: {
        legend: {
          display: !!compare,
          position: 'top', align: 'end',
          labels: { boxWidth: 12, boxHeight: 12, font: { size: 11 }, usePointStyle: true },
        },
        tooltip: {
          callbacks: {
            title: i => i[0].label,
            label: c => ' ' + (c.dataset.label || '') + ': ' + Math.round(c.parsed.y) + ' L'
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
// Modal na tela (sem prompt()/alert()) para editar as 4 metas fixas:
// diária, semanal, mensal e alerta de vazamento.
const EDIT_GOAL_META = {
  diaria:  { title: 'Editar meta diária',  label: 'Meta diária (L)',  elId: 'meta-diaria-limit',  path: 'daily_l' },
  semanal: { title: 'Editar meta semanal', label: 'Meta semanal (L)', elId: 'meta-semanal-limit', path: 'weekly_l' },
  mensal:  { title: 'Editar meta mensal',  label: 'Meta mensal (L)',  elId: 'meta-mensal-limit',  path: 'monthly_l' },
};
let _editGoalType = null;

function openEditGoal(type) {
  _editGoalType = type;
  const err = document.getElementById('eg-error');
  if (err) err.style.display = 'none';
  const valueField = document.getElementById('eg-value-field');
  const leakFields = document.getElementById('eg-leak-fields');

  if (type === 'vazamento') {
    setText('eg-modal-title', 'Editar alerta de vazamento');
    setText('eg-modal-sub', 'Defina o limite de tempo e a vazão mínima');
    if (valueField) valueField.style.display = 'none';
    if (leakFields) leakFields.style.display = 'grid';
    const min = document.getElementById('eg-leak-min');
    const lpm = document.getElementById('eg-leak-lpm');
    if (min) min.value = document.getElementById('meta-leak-limit')?.textContent || LEAK_MIN;
    if (lpm) lpm.value = document.getElementById('meta-leak-flow')?.textContent || LEAK_LPM;
  } else {
    const cfg = EDIT_GOAL_META[type];
    if (!cfg) return;
    setText('eg-modal-title', cfg.title);
    setText('eg-modal-sub', 'Defina o novo valor em litros');
    setText('eg-value-label', cfg.label);
    const input = document.getElementById('eg-value');
    if (input) input.value = document.getElementById(cfg.elId)?.textContent || '';
    if (valueField) valueField.style.display = 'flex';
    if (leakFields) leakFields.style.display = 'none';
  }
  document.getElementById('modal-edit-goal').classList.remove('hidden');
}
function closeEditGoal() {
  document.getElementById('modal-edit-goal').classList.add('hidden');
  _editGoalType = null;
}
function saveEditGoal() {
  const err = document.getElementById('eg-error');
  const showErr = msg => { if (err) { err.textContent = msg; err.style.display = 'block'; } };
  if (!currentUid) return showErr('Sessão expirada. Faça login novamente.');
  if (!_editGoalType) return;

  if (_editGoalType === 'vazamento') {
    const min = parseFloat(document.getElementById('eg-leak-min')?.value);
    const lpm = parseFloat(document.getElementById('eg-leak-lpm')?.value);
    if (!min || min <= 0) return showErr('Informe um limite de tempo válido.');
    if (!lpm || lpm <= 0) return showErr('Informe uma vazão mínima válida.');

    rtdb.ref(`goals/${currentUid}/leak_min`).set(min);
    rtdb.ref(`goals/${currentUid}/leak_lpm`).set(lpm);
    LEAK_MIN = min;
    LEAK_LPM = lpm;
    setText('meta-leak-limit', String(min));
    setText('meta-leak-flow', String(lpm));
    // Sincroniza config do device para o ESP32 usar o mesmo threshold
    if (activeDeviceId) {
      rtdb.ref(`devices/${activeDeviceId}/config/leak_flow_lpm`).set(lpm);
      rtdb.ref(`devices/${activeDeviceId}/config/leak_threshold_min`).set(min);
    }
  } else {
    const cfg = EDIT_GOAL_META[_editGoalType];
    if (!cfg) return;
    const val = parseFloat(document.getElementById('eg-value')?.value);
    if (!val || val <= 0) return showErr('Informe um valor válido.');

    rtdb.ref(`goals/${currentUid}/${cfg.path}`).set(val);
    setText(cfg.elId, String(val));
    if (_editGoalType === 'diaria') {
      GOAL_LIMIT = val;
      setText('goal-limit', val);
      // Sincroniza config do device para o ESP32 ler
      if (activeDeviceId) rtdb.ref(`devices/${activeDeviceId}/config/goal_daily_l`).set(val);
    }
  }
  showToast('Meta atualizada!');
  closeEditGoal();
}

// ── DATA ALVO DA META MENSAL ────────────────────────────────────────
function renderMonthlyGoalDate(dateStr) {
  const input = document.getElementById('meta-mensal-date');
  if (input) input.value = dateStr || '';
  setText('meta-mensal-date-info', dateStr ? daysUntilLabel(dateStr) : '');
}
function setMonthlyGoalDate(value) {
  if (!currentUid) return;
  rtdb.ref(`goals/${currentUid}/monthly_date`).set(value || null);
  setText('meta-mensal-date-info', value ? daysUntilLabel(value) : '');
  showToast(value ? 'Data alvo da meta mensal salva!' : 'Data alvo removida.');
}
function daysUntilLabel(dateStr) {
  const target = new Date(dateStr + 'T00:00:00');
  if (isNaN(target)) return '';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays > 1) return `${diffDays} dias restantes`;
  if (diffDays === 1) return 'Falta 1 dia';
  if (diffDays === 0) return 'É hoje!';
  return `Venceu há ${Math.abs(diffDays)} dia${Math.abs(diffDays) > 1 ? 's' : ''}`;
}

// ── METAS PERSONALIZADAS ─────────────────────────────────────────────
function openCustomGoal(id) {
  _editingGoalId = id || null;
  const g = id ? customGoals[id] : null;
  document.getElementById('cg-modal-title').textContent = g ? 'Editar meta personalizada' : 'Nova meta personalizada';
  document.getElementById('cg-name').value = g?.name || '';
  document.getElementById('cg-target').value = g?.target_l ?? '';
  document.getElementById('cg-period').value = g?.period || 'mensal';
  document.getElementById('cg-date').value = g?.date || '';
  const err = document.getElementById('cg-error');
  if (err) err.style.display = 'none';
  onCustomGoalPeriodChange();
  document.getElementById('modal-custom-goal').classList.remove('hidden');
}
function closeCustomGoal() {
  document.getElementById('modal-custom-goal').classList.add('hidden');
  _editingGoalId = null;
}
function onCustomGoalPeriodChange() {
  const period = document.getElementById('cg-period')?.value;
  const field = document.getElementById('cg-date-field');
  if (field) field.style.display = period === 'mensal' ? 'flex' : 'none';
}
function saveCustomGoal() {
  const err = document.getElementById('cg-error');
  const showErr = msg => { if (err) { err.textContent = msg; err.style.display = 'block'; } };

  const name = document.getElementById('cg-name')?.value.trim();
  const target = parseFloat(document.getElementById('cg-target')?.value);
  const period = document.getElementById('cg-period')?.value || 'mensal';
  const date = period === 'mensal' ? (document.getElementById('cg-date')?.value || null) : null;

  if (!name) return showErr('Informe um nome para a meta.');
  if (!target || target <= 0) return showErr('Informe um valor alvo válido (litros).');
  if (!currentUid) return showErr('Sessão expirada. Faça login novamente.');
  if (err) err.style.display = 'none';

  const data = { name, target_l: target, period, date, updated_at: Date.now() };
  if (_editingGoalId) {
    data.created_at = customGoals[_editingGoalId]?.created_at || Date.now();
    rtdb.ref(`goals/${currentUid}/custom/${_editingGoalId}`).set(data);
  } else {
    data.created_at = Date.now();
    rtdb.ref(`goals/${currentUid}/custom`).push(data);
  }

  showToast(_editingGoalId ? 'Meta personalizada atualizada!' : 'Meta personalizada criada!');
  closeCustomGoal();
}
function deleteCustomGoal(id) {
  if (!currentUid || !id) return;
  const g = customGoals[id];
  openConfirmModal(
    'Excluir meta personalizada',
    `Excluir a meta "${g?.name || ''}"?`,
    () => {
      rtdb.ref(`goals/${currentUid}/custom/${id}`).remove()
        .then(() => showToast('Meta personalizada excluída.'))
        .catch(e => {
          console.error('Erro ao excluir meta:', e);
          showToast('Erro ao excluir meta.', 'error');
        });
    },
    'Excluir'
  );
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function renderCustomGoals() {
  const grid = document.getElementById('custom-goals-grid');
  const empty = document.getElementById('custom-goals-empty');
  if (!grid) return;
  const entries = Object.entries(customGoals || {});
  if (empty) empty.classList.toggle('show', entries.length === 0);
  if (entries.length === 0) { grid.innerHTML = ''; return; }

  const periodLabel = { diaria: 'Diária', semanal: 'Semanal', mensal: 'Mensal' };
  const usedByPeriod = { diaria: _dayTotal, semanal: _weekTotal, mensal: _monthTotal };

  grid.innerHTML = entries.map(([id, g]) => {
    const used = usedByPeriod[g.period] ?? 0;
    const target = g.target_l || 1;
    const pct = Math.min((used / target) * 100, 100);
    const barCls = pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '';
    const dateInfo = g.period === 'mensal' && g.date
      ? `<span class="gdc-custom-badge">${new Date(g.date + 'T00:00:00').toLocaleDateString('pt-BR')} · ${escapeHtml(daysUntilLabel(g.date))}</span>`
      : '';
    return `
      <div class="goal-detail-card">
        <button class="gdc-delete-btn" onclick="deleteCustomGoal('${id}')" title="Excluir meta">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
          </svg>
        </button>
        <div class="gdc-header">
          <div class="gdc-icon blue">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 3" />
            </svg>
          </div>
          <div>
            <div class="gdc-name">${escapeHtml(g.name)}</div>
            <div class="gdc-period">${periodLabel[g.period] || g.period}</div>
            ${dateInfo}
          </div>
        </div>
        <div class="gdc-bar-wrap">
          <div class="gdc-bar-bg"><div class="gdc-bar-fill${barCls}" style="width:${pct}%"></div></div>
        </div>
        <div class="gdc-nums"><span><strong>${used.toFixed(0)}</strong>L usados</span><span>Meta: <strong>${target}</strong>L</span></div>
        <button class="edit-goal-btn" onclick="openCustomGoal('${id}')">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
          Editar meta
        </button>
      </div>`;
  }).join('');
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
  teardownHouseListeners();
  refAlerts?.off();
  auth.signOut().then(() => { window.location.href = 'login.html'; });
}

// ── UTILS ─────────────────────────────────────────────────────────
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function todayKey() { return new Date().toISOString().split('T')[0]; }

// ── HELPER: lê daily/{uid}/{YYYY}/{MM}/{DD} ───────────────────────
// O Firebase armazena o consumo por hora em daily/{uid}/{YYYY}/{MM}/{DD}/{HH}
// (cada chave HH é um número em litros). dailyRef retorna a Ref para o nó
// do dia; para obter o total do dia use dailyTotal(snap).
function dailyRef(uid, dateKey) {
  const [year, month, day] = dateKey.split('-');
  return rtdb.ref(`daily/${uid}/${year}/${month}/${day}`);
}

// Soma os valores horários armazenados em daily/{uid}/YYYY/MM/DD.
// Aceita snapshot ou valor cru. Retorna 0 se não houver dados.
function sumHourlyVal(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val; // compat. com formato antigo
  if (typeof val !== 'object') return 0;
  let sum = 0;
  for (const k in val) {
    const v = val[k];
    if (typeof v === 'number') sum += v;
  }
  return sum;
}
function dailyTotal(snap) { return sumHourlyVal(snap?.val ? snap.val() : snap); }
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

// ── RELATÓRIO / ECO SCORE — período selecionável ────────────────────
let _reportPeriod = 'semana'; // 'semana' | 'mes' | 'ano' | 'personalizado'
let _customStart = null; // YYYY-MM-DD (período personalizado)
let _customEnd = null;   // YYYY-MM-DD (período personalizado)
let reportDays = [];          // entradas do período atual do relatório (dia ou mês, conforme _reportPeriod)

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
        const raw = snap.val();
        const vol = sumHourlyVal(raw);
        const hoursObj = (raw && typeof raw === 'object') ? raw : {};
        const hourVals = Object.values(hoursObj).filter(v => typeof v === 'number');
        const peak = hourVals.length ? Math.max(...hourVals) : 0;
        const active = hourVals.filter(v => v > 0).length;
        const goal = GOAL_LIMIT;
        const status = vol > goal ? 'over' : vol > goal * 0.8 ? 'warn' : 'ok';
        return { date, dateKey: key, isToday, vol, peak, active, goal, status, fromDb: raw != null };
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
    // Draw empty state on canvas. O canvas nasce com o buffer padrão de
    // 300x150px e o CSS estica esse bitmap para preencher o card (width/
    // height:100%) — sem ajustar a resolução interna ao tamanho real
    // exibido, o texto desenhado sai esticado horizontalmente.
    const rect = canvas.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      const ctx = canvas.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, rect.width, rect.height);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--text-3').trim() || '#8aadc4';
      ctx.font = '13px DM Sans, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Sem dados de consumo ainda', rect.width / 2, rect.height / 2);
    }
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
// Metadados de texto por período — usados pra atualizar títulos,
// badges e o rótulo das metas sem duplicar lógica de renderização.
// Um único critério de cor pro Eco Score — usado pela roda, pelo texto
// do grau e pelo PDF, pra nunca mostrarem estados diferentes entre si.
// Bate com os limiares de renderReportPage(): Ótimo/Bom >=70, Regular
// >=50, Crítico abaixo disso.
function ecoScoreClass(score) {
  return score >= 70 ? '' : score >= 50 ? ' warn' : ' over';
}

const REPORT_PERIOD_META = {
  semana: {
    summaryTitle: 'Resumo desta semana', summaryBadge: 'Últimos 7 dias',
    totalSub: 'litros esta semana', bestLabel: 'Melhor dia', bestSub: 'menor consumo registrado',
    okLabel: 'Dias dentro da meta', okSub: n => `de ${n} dias verificados`,
    unit: 'dia', unitPlural: 'dias', periodPdf: 'Últimos 7 dias', goalPdfLabel: 'Meta diária',
    tableTitle: 'Detalhamento diário', dateColLabel: 'Data',
  },
  mes: {
    summaryTitle: 'Resumo deste mês', summaryBadge: 'Últimos 30 dias',
    totalSub: 'litros este mês', bestLabel: 'Melhor dia', bestSub: 'menor consumo registrado',
    okLabel: 'Dias dentro da meta', okSub: n => `de ${n} dias verificados`,
    unit: 'dia', unitPlural: 'dias', periodPdf: 'Últimos 30 dias', goalPdfLabel: 'Meta diária',
    tableTitle: 'Detalhamento diário', dateColLabel: 'Data',
  },
  ano: {
    summaryTitle: 'Resumo deste ano', summaryBadge: 'Últimos 12 meses',
    totalSub: 'litros este ano', bestLabel: 'Melhor mês', bestSub: 'menor consumo registrado',
    okLabel: 'Meses dentro da meta', okSub: n => `de ${n} meses verificados`,
    unit: 'mês', unitPlural: 'meses', periodPdf: 'Últimos 12 meses', goalPdfLabel: 'Meta mensal',
    tableTitle: 'Detalhamento mensal', dateColLabel: 'Mês',
  },
};

// Troca o período do relatório (semana/mês/ano/personalizado) a partir dos
// tabs da página. "Personalizado" abre o painel de datas em vez de renderizar
// na hora — o próprio painel chama applyCustomReportRange() ao mudar as datas.
function setReportPeriod(period, btn) {
  _reportPeriod = period;
  document.querySelectorAll('#report-period-tabs .period-tab').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');

  const rangePanel = document.getElementById('report-custom-range');
  if (period !== 'personalizado') {
    if (rangePanel) rangePanel.style.display = 'none';
    renderReportPage(period);
    return;
  }

  if (rangePanel) rangePanel.style.display = 'flex';
  const todayStr = todayKey();
  if (!_customStart || !_customEnd) {
    const start = new Date(); start.setDate(start.getDate() - 6);
    _customStart = start.toISOString().split('T')[0];
    _customEnd = todayStr;
  }
  const startEl = document.getElementById('report-custom-start');
  const endEl = document.getElementById('report-custom-end');
  if (startEl) { startEl.value = _customStart; startEl.max = todayStr; }
  if (endEl) { endEl.value = _customEnd; endEl.max = todayStr; }
  renderReportPage('personalizado');
}

// Lê as datas escolhidas no painel de período personalizado, valida e
// re-renderiza o relatório. Chamada pelo onchange dos dois campos de data.
function applyCustomReportRange() {
  const start = document.getElementById('report-custom-start')?.value;
  const end = document.getElementById('report-custom-end')?.value;
  const errEl = document.getElementById('report-custom-error');
  if (errEl) errEl.style.display = 'none';
  if (!start || !end) return;

  if (start > end) {
    if (errEl) { errEl.textContent = 'A data inicial deve ser antes (ou igual) à data final.'; errEl.style.display = 'block'; }
    return;
  }
  const dayCount = Math.round((new Date(end + 'T00:00:00') - new Date(start + 'T00:00:00')) / 86400000) + 1;
  if (dayCount > 92) {
    if (errEl) { errEl.textContent = 'Escolha um período de até 92 dias (cerca de 3 meses).'; errEl.style.display = 'block'; }
    return;
  }

  _customStart = start;
  _customEnd = end;
  renderReportPage('personalizado');
}

// Monta os textos do relatório pro período personalizado (dependem das
// datas escolhidas, por isso não entram na tabela estática de metadados).
function buildCustomReportMeta(startStr, endStr) {
  if (!startStr || !endStr) return REPORT_PERIOD_META.semana;
  const start = new Date(startStr + 'T12:00:00');
  const end = new Date(endStr + 'T12:00:00');
  const fmtFull = d => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const label = `${fmtFull(start)} a ${fmtFull(end)}`;

  // Formato compacto só pro cabeçalho do PDF — a coluna "Período" tem
  // largura fixa e "dd/mm/aaaa a dd/mm/aaaa" estoura pra fora dela.
  // Omite o ano do início quando os dois estão no mesmo ano.
  const sameYear = start.getFullYear() === end.getFullYear();
  const fmtShort = (d, withYear) => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: withYear ? '2-digit' : undefined });
  const labelPdf = sameYear
    ? `${fmtShort(start, false)} a ${fmtShort(end, true)}`
    : `${fmtShort(start, true)} a ${fmtShort(end, true)}`;

  return {
    summaryTitle: 'Resumo do período', summaryBadge: label,
    totalSub: 'litros no período', bestLabel: 'Melhor dia', bestSub: 'menor consumo registrado',
    okLabel: 'Dias dentro da meta', okSub: n => `de ${n} dias verificados`,
    unit: 'dia', unitPlural: 'dias', periodPdf: labelPdf, goalPdfLabel: 'Meta diária',
    tableTitle: 'Detalhamento diário', dateColLabel: 'Data',
  };
}

// Devolve os metadados de texto do período — estáticos pros 3 fixos,
// calculados na hora pro personalizado.
function getReportMeta(period) {
  if (period === 'personalizado') return buildCustomReportMeta(_customStart, _customEnd);
  return REPORT_PERIOD_META[period] || REPORT_PERIOD_META.semana;
}

// Carrega granularidade diária pra um intervalo arbitrário de datas
// (compartilhado entre o período "mês" e o "personalizado").
async function loadDailyRange(startDate, endDate) {
  const days = [];
  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    days.push({ d: new Date(d), key: d.toISOString().split('T')[0] });
  }
  if (!currentUid) {
    return days.map(({ d, key }) => ({
      date: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
      dateKey: key, vol: 0, peak: 0, active: 0, goal: GOAL_LIMIT, fromDb: false,
    }));
  }
  return Promise.all(days.map(({ d, key }) =>
    dailyRef(currentUid, key).once('value').then(snap => {
      const raw = snap.val();
      const vol = sumHourlyVal(raw);
      const hourVals = (raw && typeof raw === 'object') ? Object.values(raw).filter(v => typeof v === 'number') : [];
      const peak = hourVals.length ? Math.max(...hourVals) : 0;
      const active = hourVals.filter(v => v > 0).length;
      return {
        date: d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }),
        dateKey: key, vol, peak, active, goal: GOAL_LIMIT, fromDb: raw != null,
      };
    })
  ));
}

// Carrega as entradas do relatório conforme o período:
//  - semana/mês/personalizado → granularidade diária (daily/{uid}/YYYY/MM/DD)
//  - ano                      → granularidade mensal (agrega daily/{uid}/YYYY/MM inteiro)
async function loadReportEntries(period) {
  if (period === 'semana') return loadHistoryFromFirebase();

  const now = new Date();

  if (period === 'mes') {
    const start = new Date(now); start.setDate(start.getDate() - 29);
    return loadDailyRange(start, now);
  }

  if (period === 'personalizado') {
    if (!_customStart || !_customEnd) return [];
    return loadDailyRange(new Date(_customStart + 'T00:00:00'), new Date(_customEnd + 'T00:00:00'));
  }

  // 'ano' — últimos 12 meses, um read por mês (bem mais leve que 365 reads diários)
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ d, year: String(d.getFullYear()), month: String(d.getMonth() + 1).padStart(2, '0') });
  }
  if (!currentUid) {
    return months.map(({ d, year, month }) => ({
      date: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
      dateKey: `${year}-${month}`, vol: 0, peak: 0, active: 0, goal: GOAL_MONTHLY, fromDb: false,
    }));
  }
  const snaps = await Promise.all(months.map(({ year, month }) =>
    rtdb.ref(`daily/${currentUid}/${year}/${month}`).once('value')
  ));
  return snaps.map((snap, i) => {
    const monthData = snap.val();
    let vol = 0;
    if (monthData) for (const dayKey in monthData) vol += sumHourlyVal(monthData[dayKey]);
    const { d, year, month } = months[i];
    return {
      date: d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' }),
      dateKey: `${year}-${month}`, vol, peak: 0, active: 0, goal: GOAL_MONTHLY, fromDb: monthData != null,
    };
  });
}

async function renderReportPage(period) {
  period = period || _reportPeriod;
  _reportPeriod = period;
  const meta = getReportMeta(period);

  reportDays = await loadReportEntries(period);

  const hasAnyData = reportDays.some(d => d.fromDb && d.vol > 0);

  setText('report-summary-title', meta.summaryTitle);
  setText('report-summary-badge', meta.summaryBadge);
  setText('report-week-total-sub', meta.totalSub);
  setText('report-best-day-label', meta.bestLabel);
  setText('report-best-day-sub', meta.bestSub);
  setText('report-days-ok-label', meta.okLabel);

  // ── Estado vazio: sem dispositivo ou sem dados ─────────────────
  if (!activeDeviceId || !hasAnyData) {
    const emptyMsg = !activeDeviceId
      ? 'Conecte um dispositivo para gerar o relatório.'
      : `Sem dados de consumo em ${meta.summaryBadge.toLowerCase()}.<br><span style="font-size:.8rem">O relatório é gerado assim que o sensor enviar leituras.</span>`;

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
  const unitGoal = period === 'ano' ? GOAL_MONTHLY : GOAL_LIMIT;
  const entriesWithData = reportDays.filter(d => d.fromDb);
  const periodTotal = reportDays.reduce((s, d) => s + d.vol, 0);
  const avgPerUnit = entriesWithData.length > 0 ? periodTotal / entriesWithData.length : 0;
  const entriesOk = reportDays.filter(d => d.fromDb && d.vol <= d.goal && d.vol > 0).length;
  const bestEntry = entriesWithData.reduce((best, d) => d.vol < best.vol ? d : best, entriesWithData[0]);
  const saved = Math.max(0, unitGoal * entriesWithData.length - periodTotal);

  setText('report-week-total', periodTotal.toFixed(0));
  setText('report-week-save', saved.toFixed(0));
  setText('report-best-day', bestEntry ? bestEntry.date.split(',')[0] : '—');
  setText('report-days-ok', entriesOk + '/' + entriesWithData.length);
  setText('report-days-ok-sub', meta.okSub(entriesWithData.length));

  // Eco score: baseado em % de unidades (dias ou meses) dentro da meta e consumo vs meta
  const compliance = entriesWithData.length > 0 ? entriesOk / entriesWithData.length : 0;
  const avgVsMeta = Math.max(0, 1 - (avgPerUnit - unitGoal * 0.7) / (unitGoal * 0.6));
  const score = Math.round(Math.min(100, Math.max(0, (compliance * 60 + avgVsMeta * 40))));
  const circumference = 314;
  const offset = circumference - (score / 100) * circumference;

  setText('eco-score-num', score);
  const ring = document.getElementById('eco-ring');
  if (ring) {
    setTimeout(() => { ring.style.strokeDashoffset = offset; }, 100);
    ring.className = 'eco-ring-fill' + ecoScoreClass(score);
  }

  let grade, desc, badge;
  if (score >= 85) { grade = '🌿 Excelente'; desc = 'Consumo exemplar! Continue assim.'; badge = 'Ótimo'; }
  else if (score >= 70) { grade = '💧 Bom'; desc = 'Consumo dentro do esperado com pequenas melhorias possíveis.'; badge = 'Bom'; }
  else if (score >= 50) { grade = '⚠️ Regular'; desc = `Há margem de melhoria no consumo por ${meta.unit}.`; badge = 'Regular'; }
  else { grade = '🔴 Crítico'; desc = 'Consumo elevado. Revise seus hábitos e verifique vazamentos.'; badge = 'Crítico'; }

  const gradeEl = document.getElementById('eco-grade');
  if (gradeEl) { gradeEl.textContent = grade; gradeEl.className = 'eco-grade' + ecoScoreClass(score); }
  setText('eco-desc', desc);
  setText('eco-badge', badge);

  // ── Dicas personalizadas: tenta Claude API, cai pra heurística ──
  renderAITipsOrFallback(reportDays, entriesWithData, periodTotal, avgPerUnit, entriesOk, score, meta, unitGoal);
}

/**
 * Tenta gerar dicas via Cloud Function (Claude API). Se falhar
 * (function indisponível, sem créditos, sem rede), usa a heurística
 * local em renderReportTips. Mostra estado "Carregando" durante a chamada.
 */
async function renderAITipsOrFallback(days, daysWithData, weekTotal, avgDaily, daysOk, score, meta, unitGoal) {
  meta = meta || REPORT_PERIOD_META.semana;
  unitGoal = unitGoal ?? GOAL_LIMIT;
  const tipsEl = document.getElementById('report-tips');
  if (!tipsEl) return;

  // Sem suporte a functions → fallback direto
  if (!functions || typeof functions.httpsCallable !== 'function') {
    renderReportTips(days, daysWithData, weekTotal, avgDaily, daysOk, score, meta, unitGoal);
    return;
  }

  tipsEl.innerHTML = `
    <div style="padding:1.5rem;text-align:center;color:var(--text-3);font-size:.86rem;display:flex;align-items:center;justify-content:center;gap:.6rem">
      <div class="ai-spinner" style="width:14px;height:14px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:spin .8s linear infinite"></div>
      Analisando seu padrão de consumo com IA…
    </div>`;

  try {
    // A Cloud Function busca os dados de consumo direto do banco pelo uid
    // autenticado — não manda mais números calculados no client (evita que
    // um usuário forje valores pra manipular a análise gerada em seu nome).
    const call = functions.httpsCallable('analyzeConsumption');
    const { data } = await call({});
    const tips = data?.tips || [];
    if (!tips.length) throw new Error('Sem dicas retornadas');

    tipsEl.innerHTML = tips.map(t => `
      <div class="report-tip">
        <div class="tip-icon ${t.severity}">${_severityIcon(t.severity)}</div>
        <div>
          <div class="tip-title">${_escapeHtml(t.title)}</div>
          <div class="tip-body">${_escapeHtml(t.body)}</div>
        </div>
      </div>`).join('') + `
      <div style="text-align:right;margin-top:.5rem;font-size:.72rem;color:var(--text-3)">
        ✨ Análise gerada por IA${data.cached ? ' • em cache' : ''}
      </div>`;
  } catch (e) {
    console.warn('Claude tips falhou, usando heurística:', e?.message || e);
    renderReportTips(days, daysWithData, weekTotal, avgDaily, daysOk, score, meta, unitGoal);
  }
}

function _severityIcon(s) {
  return { save: '🌿', info: '💧', warn: '⚠️', over: '🔴' }[s] || '💡';
}
function _escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Gera dicas reais com base nos dados do Firebase.
 * Substitui as dicas estáticas hardcodadas no HTML.
 */
function renderReportTips(days, daysWithData, weekTotal, avgDaily, daysOk, score, meta, unitGoal) {
  const tipsEl = document.getElementById('report-tips');
  if (!tipsEl) return;
  meta = meta || REPORT_PERIOD_META.semana;
  unitGoal = unitGoal ?? GOAL_LIMIT;
  const u = meta.unit;             // 'dia' | 'mês'
  const uPlural = meta.unitPlural; // 'dias' | 'meses'
  const periodLower = meta.summaryBadge.toLowerCase(); // ex: "últimos 7 dias" / "últimos 12 meses"

  const tips = [];

  // Dica 1: meta do período (diária ou mensal, conforme a granularidade)
  const overDays = daysWithData.filter(d => d.vol > d.goal).length;
  if (overDays >= 3) {
    tips.push({ icon: '🔴', cls: 'over', title: 'Meta ultrapassada com frequência', body: `Você excedeu a meta em ${overDays} dos últimos ${daysWithData.length} ${uPlural} com dados. Tente distribuir o uso ao longo do tempo.` });
  } else if (overDays > 0) {
    tips.push({ icon: '⚠️', cls: 'warn', title: 'Atenção à meta', body: `A meta foi ultrapassada em ${overDays} ${overDays > 1 ? uPlural : u} em ${periodLower}. Pequenos ajustes nos hábitos fazem diferença.` });
  } else {
    tips.push({ icon: '✅', cls: 'save', title: 'Meta cumprida', body: `Parabéns! Você ficou dentro da meta de ${Math.round(unitGoal)}L em todos os ${uPlural} registrados em ${periodLower}.` });
  }

  // Dica 2: consumo médio vs meta
  if (avgDaily > unitGoal * 1.2) {
    tips.push({ icon: '💧', cls: 'over', title: 'Consumo médio acima do ideal', body: `Sua média foi de ${avgDaily.toFixed(0)}L/${u}, ${((avgDaily / unitGoal - 1) * 100).toFixed(0)}% acima da meta de ${Math.round(unitGoal)}L. Verifique torneiras e chuveiros.` });
  } else if (avgDaily > 0 && avgDaily <= unitGoal * 0.7) {
    tips.push({ icon: '🌿', cls: 'save', title: 'Consumo eficiente', body: `Seu consumo médio de ${avgDaily.toFixed(0)}L/${u} está bem abaixo da meta. Bom trabalho em economizar água!` });
  } else if (avgDaily > 0) {
    tips.push({ icon: '📊', cls: 'info', title: 'Consumo dentro da faixa esperada', body: `Média de ${avgDaily.toFixed(0)}L/${u} em ${periodLower}. Meta: ${Math.round(unitGoal)}L. Mantenha o controle para não ultrapassar.` });
  }

  // Dica 3: melhor vs pior unidade (dia ou mês)
  if (daysWithData.length >= 2) {
    const maxDay = daysWithData.reduce((a, b) => b.vol > a.vol ? b : a, daysWithData[0]);
    const minDay = daysWithData.reduce((a, b) => b.vol < a.vol ? b : a, daysWithData[0]);
    if (maxDay.vol > 0 && minDay.vol > 0 && maxDay.vol > minDay.vol * 1.5) {
      tips.push({ icon: '📅', cls: 'info', title: 'Variação elevada no consumo', body: `Pior ${u}: ${maxDay.date.split(',')[0]} com ${maxDay.vol.toFixed(0)}L. Melhor ${u}: ${minDay.date.split(',')[0]} com ${minDay.vol.toFixed(0)}L. Tente manter consistência.` });
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

// ── EXPORTAR RELATÓRIO EM PDF ─────────────────────────────────────
// Usa jsPDF + autoTable (carregados em dashboard.html via CDN).
// Layout: capa com logo, cards de KPI, tabela detalhada e dicas.
// Todos os números são inteiros — sem decimais que poluem a leitura.
async function exportReportPDF() {
  if (typeof window.jspdf === 'undefined') {
    showToast('Biblioteca PDF não carregou. Verifique sua conexão.', 'error');
    return;
  }
  if (!reportDays.length) reportDays = await loadReportEntries(_reportPeriod);
  const hasAny = reportDays.some(d => d.fromDb && d.vol > 0);
  if (!hasAny) { showToast('Sem dados suficientes para gerar o relatório.', 'error'); return; }
  const meta = getReportMeta(_reportPeriod);
  const unitGoal = _reportPeriod === 'ano' ? GOAL_MONTHLY : GOAL_LIMIT;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const PAGE_W = doc.internal.pageSize.getWidth();
  const PAGE_H = doc.internal.pageSize.getHeight();
  const M = 48;

  // Paleta
  const BLUE = [26, 172, 240];
  const BLUE_DARK = [12, 122, 175];
  const GREEN = [16, 185, 129];
  const RED = [239, 68, 68];
  const AMBER = [217, 119, 6];
  const GRAY = [100, 116, 139];
  const GRAY_LIGHT = [226, 232, 240];
  const BG_SOFT = [248, 250, 252];
  const DARK = [15, 23, 42];

  // ── Tenta carregar a logo (se falhar, segue sem) ─────────────
  const logo = await _loadLogoForPDF().catch(() => null);

  // ── Cabeçalho com faixa colorida + logo ──────────────────────
  doc.setFillColor(...BLUE);
  doc.rect(0, 0, PAGE_W, 92, 'F');
  doc.setFillColor(...BLUE_DARK);
  doc.rect(0, 88, PAGE_W, 4, 'F');

  if (logo) {
    // Logo branca em fundo translúcido pra contraste
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(M, 22, 52, 52, 10, 10, 'F');
    const pad = 6;
    doc.addImage(logo.dataUrl, 'PNG', M + pad, 22 + pad, 52 - pad * 2, 52 - pad * 2);
  }

  const headX = logo ? M + 68 : M;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold').setFontSize(24).text('LetControl', headX, 50);
  doc.setFont('helvetica', 'normal').setFontSize(11).text('Relatório de consumo de água', headX, 70);

  const now = new Date();
  const dateStr = now.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  doc.setFontSize(9).text(`${dateStr}  •  ${timeStr}`, PAGE_W - M, 50, { align: 'right' });
  doc.setFontSize(8).setTextColor(220, 240, 255).text('letcontrol.app', PAGE_W - M, 68, { align: 'right' });

  // ── Bloco de identificação ───────────────────────────────────
  const deviceName = document.getElementById('sb-device-name')?.textContent?.trim() || 'Sensor';
  const userName = document.getElementById('user-name')?.textContent?.trim() || '—';
  let y = 120;
  doc.setDrawColor(...GRAY_LIGHT).setFillColor(...BG_SOFT);
  doc.roundedRect(M, y, PAGE_W - M * 2, 56, 8, 8, 'FD');

  const idCol = (x, label, value) => {
    doc.setTextColor(...GRAY).setFont('helvetica', 'normal').setFontSize(8);
    doc.text(label.toUpperCase(), x, y + 20);
    doc.setTextColor(...DARK).setFont('helvetica', 'bold').setFontSize(11);
    doc.text(value, x, y + 38);
  };
  const colW = (PAGE_W - M * 2) / 4;
  idCol(M + 16, 'Usuário', _truncate(userName, 18));
  idCol(M + 16 + colW, 'Sensor', _truncate(deviceName, 18));
  idCol(M + 16 + colW * 2, 'Período', meta.periodPdf);
  idCol(M + 16 + colW * 3, meta.goalPdfLabel, `${Math.round(unitGoal)} L`);
  y += 76;

  // ── KPIs (4 cards) ────────────────────────────────────────────
  const daysWithData = reportDays.filter(d => d.fromDb);
  const weekTotal = reportDays.reduce((s, d) => s + d.vol, 0);
  const daysOk = reportDays.filter(d => d.fromDb && d.vol <= d.goal && d.vol > 0).length;
  const saved = Math.max(0, unitGoal * daysWithData.length - weekTotal);
  const score = parseInt(document.getElementById('eco-score-num')?.textContent) || 0;
  const grade = document.getElementById('eco-grade')?.textContent?.replace(/[^\w\sÀ-ÿ]/g, '').trim() || '—';
  // Mesmo limiar de ecoScoreClass() — o PDF precisa bater com a tela.
  const ecoColor = score >= 70 ? GREEN : score >= 50 ? AMBER : RED;

  // Card grande do eco score (à esquerda)
  const cardH = 96;
  const ecoW = 160;
  doc.setFillColor(...ecoColor);
  doc.roundedRect(M, y, ecoW, cardH, 10, 10, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'normal').setFontSize(9).text('ECO SCORE', M + 16, y + 22);

  // Desenha o número grande e MEDE A LARGURA enquanto a fonte ainda
  // está em bold 44pt — chamar getTextWidth depois de trocar a fonte
  // retorna a largura no tamanho ERRADO e o "/100" sobrepõe o número.
  const scoreStr = String(score);
  doc.setFont('helvetica', 'bold').setFontSize(44);
  doc.text(scoreStr, M + 16, y + 66);
  const scoreW = doc.getTextWidth(scoreStr);

  doc.setFont('helvetica', 'normal').setFontSize(13);
  doc.text('/100', M + 16 + scoreW + 4, y + 60);

  doc.setFont('helvetica', 'bold').setFontSize(10).text(grade, M + 16, y + 86);

  // 3 cards de KPI à direita
  const kpiX = M + ecoW + 12;
  const kpiW = (PAGE_W - M * 2 - ecoW - 12 - 24) / 3;
  const kpiCard = (idx, label, value, sub, accent) => {
    const x = kpiX + idx * (kpiW + 12);
    doc.setDrawColor(...GRAY_LIGHT).setFillColor(255, 255, 255);
    doc.roundedRect(x, y, kpiW, cardH, 8, 8, 'FD');
    // Barra lateral colorida
    doc.setFillColor(...accent);
    doc.roundedRect(x, y, 4, cardH, 2, 2, 'F');
    doc.setTextColor(...GRAY).setFont('helvetica', 'normal').setFontSize(8);
    doc.text(label.toUpperCase(), x + 14, y + 22);
    doc.setTextColor(...DARK).setFont('helvetica', 'bold').setFontSize(26);
    doc.text(value, x + 14, y + 60);
    doc.setTextColor(...GRAY).setFont('helvetica', 'normal').setFontSize(8);
    doc.text(sub, x + 14, y + 82);
  };
  kpiCard(0, 'Consumo total', String(Math.round(weekTotal)) + ' L', meta.periodPdf.toLowerCase(), BLUE);
  kpiCard(1, 'Economia', String(Math.round(saved)) + ' L', 'litros poupados', GREEN);
  kpiCard(2, 'Dentro da meta', `${daysOk}/${daysWithData.length}`, `${meta.unitPlural} verificados`, AMBER);
  y += cardH + 28;

  // ── Tabela detalhada (diária ou mensal, conforme o período) ───
  doc.setTextColor(...DARK).setFont('helvetica', 'bold').setFontSize(13).text(meta.tableTitle, M, y);
  doc.setDrawColor(...BLUE).setLineWidth(2).line(M, y + 5, M + 90, y + 5);
  y += 16;

  const isMonthly = _reportPeriod === 'ano';
  const fmtDate = k => {
    const d = new Date(k + 'T12:00:00');
    return d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };
  doc.autoTable({
    startY: y,
    head: [[meta.dateColLabel, 'Consumo', 'Meta', '% Meta', 'Pico', 'Status']],
    body: reportDays.map(d => {
      const empty = !d.fromDb || d.vol === 0;
      const pct = empty ? '—' : Math.round((d.vol / d.goal) * 100) + '%';
      const status = empty ? 'Sem dado'
        : d.vol > d.goal ? 'Acima'
          : d.vol > d.goal * 0.8 ? 'Atenção'
            : 'OK';
      return [
        isMonthly ? d.date : fmtDate(d.dateKey),
        empty ? '—' : Math.round(d.vol) + ' L',
        Math.round(d.goal) + ' L',
        pct,
        (empty || isMonthly) ? '—' : Math.round(d.peak) + ' L/h',
        status,
      ];
    }),
    theme: 'plain',
    headStyles: {
      fillColor: BLUE, textColor: [255, 255, 255], fontStyle: 'bold',
      fontSize: 9, cellPadding: { top: 8, right: 10, bottom: 8, left: 10 },
    },
    bodyStyles: {
      fontSize: 10, textColor: DARK, lineColor: GRAY_LIGHT, lineWidth: 0.5,
      cellPadding: { top: 8, right: 10, bottom: 8, left: 10 },
    },
    alternateRowStyles: { fillColor: BG_SOFT },
    columnStyles: {
      0: { cellWidth: 120, fontStyle: 'bold' },
      1: { halign: 'right', cellWidth: 80 },
      2: { halign: 'right', cellWidth: 60 },
      3: { halign: 'right', cellWidth: 70 },
      4: { halign: 'right', cellWidth: 70 },
      5: { halign: 'center', fontStyle: 'bold' },
    },
    margin: { left: M, right: M },
    didParseCell: (data) => {
      if (data.section !== 'body' || data.column.index !== 5) return;
      const v = data.cell.raw;
      if (v === 'Acima') data.cell.styles.textColor = RED;
      else if (v === 'Atenção') data.cell.styles.textColor = AMBER;
      else if (v === 'OK') data.cell.styles.textColor = GREEN;
      else data.cell.styles.textColor = GRAY;
    },
  });
  y = doc.lastAutoTable.finalY + 28;

  // ── Recomendações ────────────────────────────────────────────
  if (y > PAGE_H - 180) { doc.addPage(); y = M; }
  doc.setTextColor(...DARK).setFont('helvetica', 'bold').setFontSize(13).text('Recomendações personalizadas', M, y);
  doc.setDrawColor(...GREEN).setLineWidth(2).line(M, y + 5, M + 150, y + 5);
  y += 22;

  const tipsHtml = document.getElementById('report-tips');
  const tipNodes = tipsHtml ? tipsHtml.querySelectorAll('.report-tip') : [];
  const tips = [];
  tipNodes.forEach(node => {
    const title = node.querySelector('.tip-title')?.textContent?.trim() || '';
    const body = node.querySelector('.tip-body')?.textContent?.trim() || '';
    const cls = node.querySelector('.tip-icon')?.className || '';
    let color = BLUE;
    if (cls.includes('over')) color = RED;
    else if (cls.includes('warn')) color = AMBER;
    else if (cls.includes('save')) color = GREEN;
    if (title) tips.push({ title, body, color });
  });
  if (!tips.length) tips.push({ title: 'Sem recomendações específicas', body: 'Continue monitorando para receber dicas personalizadas.', color: BLUE });

  for (const t of tips) {
    // Pre-calcula altura pra evitar quebrar título separado do corpo
    doc.setFontSize(10);
    const bodyLines = doc.splitTextToSize(t.body, PAGE_W - M * 2 - 28);
    const blockH = 14 + bodyLines.length * 13 + 16;
    if (y + blockH > PAGE_H - 50) { doc.addPage(); y = M; }

    // Marcador colorido lateral
    doc.setFillColor(...t.color);
    doc.roundedRect(M, y - 4, 3, blockH - 4, 1.5, 1.5, 'F');

    doc.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...t.color);
    doc.text(t.title, M + 14, y + 8);
    doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(...DARK);
    doc.text(bodyLines, M + 14, y + 24);
    y += blockH;
  }

  // ── Rodapé em todas as páginas ───────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setDrawColor(...GRAY_LIGHT).setLineWidth(0.5);
    doc.line(M, PAGE_H - 32, PAGE_W - M, PAGE_H - 32);
    doc.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...GRAY);
    doc.text(`LetControl • Relatório gerado em ${dateStr}`, M, PAGE_H - 18);
    doc.text(`Página ${i} de ${pages}`, PAGE_W - M, PAGE_H - 18, { align: 'right' });
  }

  const fname = `letcontrol-relatorio-${now.toISOString().split('T')[0]}.pdf`;
  doc.save(fname);
  showToast('PDF gerado!');
}

// Carrega a logo do site e converte pra dataURL (formato aceito pelo jsPDF).
async function _loadLogoForPDF() {
  const url = '../images/mobile-mockups/letcontrol-logo-cyan.png';
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || 256;
        canvas.height = img.naturalHeight || 256;
        canvas.getContext('2d').drawImage(img, 0, 0);
        resolve({ dataUrl: canvas.toDataURL('image/png'), w: canvas.width, h: canvas.height });
      } catch (e) { reject(e); }
    };
    img.onerror = reject;
    img.src = url;
  });
}

function _truncate(s, n) {
  if (!s) return '—';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
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
  // Close sidebar on mobile after navigation
  if (window.innerWidth <= 900) closeSidebar();
};

// ── SIDEBAR TOGGLE (MOBILE) ─────────────────────────────────────
function toggleSidebar() {
  const sidebar = document.getElementById('dash-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.toggle('open');
  overlay.classList.toggle('active');
  document.body.style.overflow = sidebar.classList.contains('open') ? 'hidden' : '';
}

function closeSidebar() {
  const sidebar = document.getElementById('dash-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  sidebar.classList.remove('open');
  overlay.classList.remove('active');
  document.body.style.overflow = '';
}

// ── TIME-BASED GREETING ──────────────────────────────────────────
function updateGreeting() {
  const el = document.getElementById('page-greeting');
  if (!el) return;
  const h = new Date().getHours();
  const name = document.getElementById('user-name')?.textContent || '';
  let greeting;
  if (h >= 5 && h < 12) greeting = 'Bom dia';
  else if (h >= 12 && h < 18) greeting = 'Boa tarde';
  else greeting = 'Boa noite';
  el.textContent = name && name !== '--' ? greeting + ', ' + name.split(' ')[0] : greeting;
}

// ── KEYBOARD SHORTCUT: Ctrl+K for search ─────────────────────────
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const input = document.getElementById('nav-search-input');
    if (input) input.focus();
  }
  // Escape to close sidebar
  if (e.key === 'Escape') closeSidebar();
});

// ── SCROLL TO TOP BUTTON ─────────────────────────────────────────
(function initScrollTop() {
  const btn = document.createElement('button');
  btn.className = 'scroll-top-btn';
  btn.setAttribute('aria-label', 'Voltar ao topo');
  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="18 15 12 9 6 15"/></svg>';
  btn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
  document.body.appendChild(btn);

  window.addEventListener('scroll', () => {
    btn.classList.toggle('visible', window.scrollY > 300);
  }, { passive: true });
})();

// ── PWA: SERVICE WORKER ──────────────────────────────────────────
// Registra o SW principal (cache de shell + offline fallback) e o
// service worker do FCM (push em background). Paths relativos pra
// funcionar em qualquer base (raiz do domínio, GitHub Pages, etc).
(function registerServiceWorkers() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    // dashboard.html vive em /pages/, então "../sw.js" aponta pra raiz do site.
    navigator.serviceWorker.register('../sw.js', { scope: '../' })
      .catch(e => console.warn('SW principal falhou:', e?.message));
    navigator.serviceWorker.register('../firebase-messaging-sw.js', { scope: '../firebase-cloud-messaging-push-scope' })
      .catch(e => console.warn('SW FCM falhou:', e?.message));
  });
})();

// ── PWA: BOTÃO DE INSTALAÇÃO ─────────────────────────────────────
let _deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _deferredInstallPrompt = e;
  const btn = document.getElementById('btn-install-pwa');
  if (btn) btn.style.display = 'inline-flex';
});

window.addEventListener('appinstalled', () => {
  _deferredInstallPrompt = null;
  const btn = document.getElementById('btn-install-pwa');
  if (btn) btn.style.display = 'none';
  showToast('App instalado!');
});

function installPWA() {
  if (!_deferredInstallPrompt) {
    showToast('Use o menu do navegador → "Instalar app".', 'error');
    return;
  }
  _deferredInstallPrompt.prompt();
  _deferredInstallPrompt.userChoice.finally(() => { _deferredInstallPrompt = null; });
}

// ── FCM: PUSH REAL ───────────────────────────────────────────────
// Registra um token FCM por dispositivo do usuário e salva em
// fcm_tokens/{uid}/{tokenHash} para a Cloud Function disparar pushes.
// VAPID_KEY: configurar em Firebase Console > Project settings > Cloud Messaging
// > Web Push certificates. Sem essa chave, getToken() falha silenciosamente.
const FCM_VAPID_KEY = ''; // ← cole aqui a chave VAPID pública (BX...) gerada no Firebase Console

let _fcm = null;
function fcmInit() {
  if (!currentUid || _fcm || typeof firebase === 'undefined' || !firebase.messaging) return;
  try { _fcm = firebase.messaging(); } catch (e) { console.warn('FCM indisponível:', e?.message); return; }

  // Mensagens recebidas com a aba aberta — exibe como toast nativo
  _fcm.onMessage(payload => {
    const n = payload.notification || payload.data || {};
    showToast((n.title ? n.title + ': ' : '') + (n.body || 'Nova notificação'), n.severity === 'high' ? 'error' : 'success');
  });
}

async function requestPushPermission() {
  if (!('Notification' in window)) { showToast('Navegador não suporta notificações.', 'error'); return; }
  if (Notification.permission === 'denied') {
    showToast('Permissão bloqueada. Habilite nas configurações do navegador.', 'error');
    return;
  }

  fcmInit();
  if (!_fcm) { showToast('Push indisponível neste navegador.', 'error'); return; }

  try {
    const swReg = await navigator.serviceWorker.getRegistration('../firebase-cloud-messaging-push-scope')
      || await navigator.serviceWorker.register('../firebase-messaging-sw.js', { scope: '../firebase-cloud-messaging-push-scope' });

    const opts = { serviceWorkerRegistration: swReg };
    if (FCM_VAPID_KEY) opts.vapidKey = FCM_VAPID_KEY;

    const token = await _fcm.getToken(opts);
    if (!token) { showToast('Não foi possível obter token de push.', 'error'); return; }

    // Hash simples pra usar como chave do registro (evita "/" no path)
    const tokenKey = await _hashFcmToken(token);
    await rtdb.ref(`fcm_tokens/${currentUid}/${tokenKey}`).set({
      token,
      ua: navigator.userAgent.slice(0, 200),
      created_at: Date.now(),
    });
    showToast('Notificações ativadas!');
  } catch (e) {
    console.error('FCM getToken falhou:', e);
    showToast('Erro ao ativar push: ' + (e?.message || 'desconhecido'), 'error');
  }
}

async function _hashFcmToken(t) {
  if (window.crypto?.subtle) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  }
  // Fallback simples
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
  return ('fcm_' + Math.abs(h).toString(16)).slice(0, 24);
}

// Auto-inicializa FCM após login (sem pedir permissão automaticamente)
auth.onAuthStateChanged(u => { if (u) fcmInit(); });