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
    if (g.daily_l) { GOAL_LIMIT = g.daily_l; setText('meta-diaria-limit', g.daily_l); setText('goal-limit', g.daily_l); }
    if (g.weekly_l) setText('meta-semanal-limit', g.weekly_l);
    if (g.monthly_l) setText('meta-mensal-limit', g.monthly_l);
    if (g.leak_min) setText('meta-leak-limit', g.leak_min);
    if (g.leak_lpm) setText('meta-leak-flow', g.leak_lpm);
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
    drawSparkline(flowHistory, 'sparkline-svg');
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

  // Diário atual (para meta bar)
  rtdb.ref(`aggregates/${deviceId}/daily/${todayKey()}`).on('value', snap => {
    const d = snap.val();
    if (!d) return;
    if (d.goal_l) { GOAL_LIMIT = d.goal_l; setText('goal-limit', d.goal_l); }
    if (d.vol_l != null) updateGoalBar(d.vol_l, GOAL_LIMIT);
  });
}

// ── MÉTRICAS ──────────────────────────────────────────────────────
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

// ── SPARKLINE ─────────────────────────────────────────────────────
function drawSparkline(data, svgId) {
  const svg = document.getElementById(svgId);
  if (!svg || !data.length) return;
  const [, , W, H] = svg.getAttribute('viewBox').split(' ').map(Number);
  const PAD = 8;
  const min = Math.min(...data);
  const range = (Math.max(...data) - min) || 1;
  const pts = data.map((v, i) => [
    PAD + (i / Math.max(data.length - 1, 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / range) * (H - PAD * 2)
  ]);
  const pathD = pts.reduce((acc, p, i) => {
    if (i === 0) return `M${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    const prev = pts[i - 1];
    const cx = (prev[0] + p[0]) / 2;
    return acc + ` C${cx.toFixed(1)},${prev[1].toFixed(1)} ${cx.toFixed(1)},${p[1].toFixed(1)} ${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  }, '');
  const last = pts[pts.length - 1];
  const uid = svgId.replace(/-/g, '_');
  svg.innerHTML = `
    <defs>
      <linearGradient id="sg_${uid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#0AA1FF" stop-opacity="0.25"/>
        <stop offset="100%" stop-color="#0AA1FF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${pathD} L${last[0]},${H} L${pts[0][0]},${H} Z" fill="url(#sg_${uid})"/>
    <path d="${pathD}" fill="none" stroke="#0AA1FF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="4" fill="#0AA1FF"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="8" fill="#0AA1FF" opacity="0.15"/>`;
}

function updateSparklineStats() {
  if (!flowHistory.length) return;
  const peak = Math.max(...flowHistory);
  const avg = flowHistory.reduce((a, b) => a + b, 0) / flowHistory.length;
  setText('peak-flow', peak.toFixed(1) + ' L/min');
  setText('avg-flow', avg.toFixed(1) + ' L/min');
  setText('total-readings', String(flowHistory.length));
}

// ── BARRAS HORÁRIAS ───────────────────────────────────────────────
function renderHourlyBars() {
  const c = document.getElementById('hourly-bars');
  if (!c) return;
  const h = new Date().getHours();
  const max = Math.max(...hourlyData, 1);
  c.innerHTML = hourlyData.map((v, i) => `
    <div class="mini-bar-col">
      <div class="mini-bar ${i === h ? 'active' : ''}"
        style="height:${Math.max((v / max) * 76, 3)}px"
        title="${i}h: ${v.toFixed(1)}L"></div>
    </div>`).join('');
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
  if (noEl) noEl.style.display = hasDevice ? 'none' : 'flex';
  if (hasEl) hasEl.style.display = hasDevice ? 'block' : 'none';
  if (btnAdd) btnAdd.style.display = hasDevice ? 'inline-flex' : 'none';

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
  const location = document.getElementById('add-dev-location')?.value;
  const goal = parseFloat(document.getElementById('add-dev-goal')?.value) || 175;
  const now = Date.now();
  const today = todayKey();

  try {
    const updates = {};

    // Device node (keyed by deviceId — não por uid)
    updates[`devices/${deviceId}/owner_uid`] = currentUid;
    updates[`devices/${deviceId}/name`] = name;
    updates[`devices/${deviceId}/location`] = location || 'nao_definido';
    updates[`devices/${deviceId}/firmware_version`] = '--';
    updates[`devices/${deviceId}/added_at`] = now;
    updates[`devices/${deviceId}/status/online`] = false;
    updates[`devices/${deviceId}/status/last_seen`] = null;
    updates[`devices/${deviceId}/status/battery_pct`] = null;
    updates[`devices/${deviceId}/status/wifi_rssi`] = null;
    updates[`devices/${deviceId}/config/wifi_ssid`] = ssid;
    updates[`devices/${deviceId}/config/wifi_pass`] = pass;
    updates[`devices/${deviceId}/config/sample_interval_s`] = 5;
    updates[`devices/${deviceId}/config/goal_daily_l`] = goal;
    updates[`devices/${deviceId}/config/leak_threshold_min`] = 30;
    updates[`devices/${deviceId}/config/leak_flow_lpm`] = 0.5;
    updates[`devices/${deviceId}/ota/pending`] = false;
    updates[`devices/${deviceId}/ota/status`] = 'idle';

    // fan-out index com metadados de relacionamento (v3: não mais `true`)
    updates[`user_devices/${currentUid}/${deviceId}/added_at`] = now;
    updates[`user_devices/${currentUid}/${deviceId}/role`] = 'owner';

    // Sessão ativa
    updates[`sessions/${currentUid}/active_device_id`] = deviceId;
    updates[`sessions/${currentUid}/last_active`] = now;

    // Metas (goals separado de preferences)
    updates[`goals/${currentUid}/daily_l`] = goal;

    // Meta no aggregate do dia
    updates[`aggregates/${deviceId}/daily/${today}/goal_l`] = goal;

    // Meta do readings (retenção padrão)
    updates[`readings/${deviceId}/meta/retention_days`] = 30;
    updates[`readings/${deviceId}/meta/daily_reset_date`] = today;
    updates[`readings/${deviceId}/meta/total_writes`] = 0;

    await rtdb.ref().update(updates);

    activeDeviceId = deviceId;
    GOAL_LIMIT = goal;
    setText('confirm-dev-name', name);
    goStep(3);

    teardownDeviceListeners();
    startListeners(currentUid, deviceId);
  } catch (e) {
    console.error(e);
    if (err) { err.textContent = 'Erro ao salvar. Tente novamente.'; err.style.display = 'block'; }
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
    rtdb.ref(`aggregates/${activeDeviceId}/daily/${todayKey()}`).off();
  }
  refLive = refHistory = refDevice = null;
}

// ── CONSUMO ───────────────────────────────────────────────────────
function updateConsumptionPage() {
  const total = hourlyData.reduce((a, b) => a + b, 0);
  const peak = Math.max(...hourlyData);
  const active = hourlyData.filter(v => v > 0).length;
  const avg = active > 0 ? total / active : 0;
  setText('cons-total', total.toFixed(0));
  setText('cons-peak', peak.toFixed(1));
  setText('cons-avg', avg.toFixed(1));
  setText('cons-active-hours', String(active));
  renderBarChart();
}

function renderBarChart() {
  const c = document.getElementById('cons-bar-chart');
  if (!c) return;
  const h = new Date().getHours();
  const max = Math.max(...hourlyData, 1);
  c.innerHTML = hourlyData.map((v, i) => `
    <div class="bar-item">
      <div class="bar-fill ${i === h ? 'today' : ''}"
        style="height:${Math.max((v / max) * 130, 3)}px;width:100%"
        data-val="${v.toFixed(1)}L"></div>
      <span class="bar-label">${i}h</span>
    </div>`).join('');
}

function setPeriod(period, btn) {
  document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const labels = { hoje: 'Hoje', semana: 'Esta semana', mes: 'Este mês' };
  setText('cons-period-label', labels[period] || period);
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
  Object.assign(t.style, { position: 'fixed', bottom: '1.5rem', right: '1.5rem', zIndex: '9999', background: type === 'error' ? '#ef4444' : '#10b981', color: '#fff', padding: '.75rem 1.25rem', borderRadius: '10px', fontSize: '.85rem', fontWeight: '600', boxShadow: '0 4px 16px rgba(0,0,0,.15)', animation: 'fadeUp .3s cubic-bezier(.16,1,.3,1)' });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
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
function updateDate() {
  setText('today-date', new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' }));
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
  applyTheme(saved);
})();

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  const chk = document.getElementById('cfg-dark-mode');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  if (chk) chk.checked = theme === 'dark';
  localStorage.setItem('lc_theme', theme);
}

function applyThemeFromToggle(el) {
  applyTheme(el.checked ? 'dark' : 'light');
}

document.getElementById('theme-toggle-btn')?.addEventListener('click', function() {
  const current = document.documentElement.getAttribute('data-theme') || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

// ── HISTÓRICO (dados simulados se não houver Firebase) ─────────────
let historyDays = [];

function buildHistoryData() {
  const days = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const vol = Math.round(80 + Math.random() * 160);
    const peak = +(3 + Math.random() * 12).toFixed(1);
    const active = Math.floor(4 + Math.random() * 12);
    const goal = GOAL_LIMIT;
    days.push({
      date: d.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }),
      dateKey: d.toISOString().split('T')[0],
      vol, peak, active, goal,
      status: vol <= goal ? (vol <= goal * 0.8 ? 'ok' : 'ok') : 'over',
    });
  }
  return days;
}

function renderHistoryPage() {
  historyDays = buildHistoryData();
  // Bar chart
  const bc = document.getElementById('history-bar-chart');
  if (bc) {
    const max = Math.max(...historyDays.map(d => d.vol), 1);
    bc.innerHTML = historyDays.map((d, i) => `
      <div class="bar-item">
        <div class="bar-fill ${i === 6 ? 'today' : ''}"
          style="height:${Math.max((d.vol / max) * 110, 4)}px;width:100%"
          data-val="${d.vol}L"></div>
        <span class="bar-label">${d.date.split(',')[0]}</span>
      </div>`).join('');
  }
  // Table
  const tbody = document.getElementById('history-tbody');
  if (tbody) {
    tbody.innerHTML = historyDays.map(d => {
      const statusClass = d.vol > d.goal ? 'over' : d.vol > d.goal * 0.8 ? 'warn' : 'ok';
      const statusLabel = d.vol > d.goal ? 'Acima' : d.vol > d.goal * 0.8 ? 'Atenção' : 'OK';
      return `<tr>
        <td>${d.date}</td>
        <td class="td-num">${d.vol} L</td>
        <td class="td-num">${d.peak} L/h</td>
        <td class="td-num">${d.active}h</td>
        <td class="td-num">${d.goal} L</td>
        <td><span class="badge-s ${statusClass}">${statusLabel}</span></td>
      </tr>`;
    }).join('');
    setText('history-count', `${historyDays.length} registros`);
  }
}

function exportHistory() {
  const rows = [['Data','Total (L)','Pico (L/h)','Horas ativas','Meta (L)','Status']];
  historyDays.forEach(d => rows.push([d.dateKey, d.vol, d.peak, d.active, d.goal,
    d.vol > d.goal ? 'Acima' : d.vol > d.goal * 0.8 ? 'Atenção' : 'OK']));
  const csv = rows.map(r => r.join(',')).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = 'letcontrol-historico.csv';
  a.click();
}

// ── RELATÓRIO / ECO SCORE ─────────────────────────────────────────
function renderReportPage() {
  historyDays = buildHistoryData();
  const weekTotal = historyDays.reduce((s, d) => s + d.vol, 0);
  const avgDaily = weekTotal / historyDays.length;
  const daysOk = historyDays.filter(d => d.vol <= GOAL_LIMIT).length;
  const bestDay = historyDays.reduce((best, d) => d.vol < best.vol ? d : best, historyDays[0]);
  const saved = Math.max(0, GOAL_LIMIT * 7 - weekTotal);

  setText('report-week-total', weekTotal.toFixed(0));
  setText('report-week-save', saved.toFixed(0));
  setText('report-best-day', bestDay.date.split(',')[0]);
  setText('report-days-ok', daysOk + '/7');

  // Eco score: baseado em % de dias dentro da meta e consumo vs meta
  const compliance = daysOk / 7;
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
  if (score >= 85)      { grade = '🌿 Excelente'; desc = 'Consumo exemplar! Continue assim.'; badge = 'Ótimo'; }
  else if (score >= 70) { grade = '💧 Bom'; desc = 'Consumo dentro do esperado com pequenas melhorias possíveis.'; badge = 'Bom'; }
  else if (score >= 50) { grade = '⚠️ Regular'; desc = 'Há margem de melhoria no consumo diário.'; badge = 'Regular'; }
  else                  { grade = '🔴 Crítico'; desc = 'Consumo elevado. Revise seus hábitos e verifique vazamentos.'; badge = 'Crítico'; }

  const gradeEl = document.getElementById('eco-grade');
  if (gradeEl) { gradeEl.textContent = grade; gradeEl.className = 'eco-grade' + (score >= 70 ? '' : score >= 50 ? ' warn' : ' over'); }
  setText('eco-desc', desc);
  setText('eco-badge', badge);
}

// ── BUSCA RÁPIDA ──────────────────────────────────────────────────
document.getElementById('nav-search-input')?.addEventListener('keydown', function(e) {
  if (e.key !== 'Enter') return;
  const q = this.value.toLowerCase().trim();
  const map = {
    'painel': 0, 'consumo': 1, 'metas': 2, 'historico': 3, 'histórico': 3,
    'relatorio': 4, 'relatório': 4, 'alertas': 5, 'dispositivos': 6, 'configuracoes': 7, 'configurações': 7
  };
  const pages = ['painel','consumo','metas','historico','relatorio','alertas','dispositivos','configuracoes'];
  for (const [k, idx] of Object.entries(map)) {
    if (q.includes(k)) {
      const links = document.querySelectorAll('.sidebar-link');
      showPage(pages[idx], links[idx]);
      this.value = '';
      return;
    }
  }
});

// ── OVERRIDE showPage para novas páginas ──────────────────────────
const _origShowPage = showPage;
window.showPage = function(pageId, btn) {
  _origShowPage(pageId, btn);
  if (pageId === 'historico')  renderHistoryPage();
  if (pageId === 'relatorio')  renderReportPage();
};
