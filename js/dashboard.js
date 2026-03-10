/**
 * js/dashboard.js — LetControl Dashboard
 * Realtime Database | Multi-page sidebar
 */

let refLast    = null;
let refHistory = null;
let refAlerts  = null;
let refDaily   = null;
let flowHistory = [];
let hourlyData  = Array(24).fill(0);
let dailyCache  = {};
let currentPeriod = 'hoje';
let alertsData  = [];
let GOAL_LIMIT  = 175;
let currentUid  = null;

// ── AUTH GUARD ────────────────────────────────────────────────────
auth.onAuthStateChanged((user) => {
  if (user) {
    currentUid = user.uid;
    showApp();
    setupDashboard(user);
  } else {
    window.location.href = 'login.html';
  }
});

function showApp() {
  document.getElementById('auth-loading').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  updateDate();
  renderHourlyBars();
}

// ── SETUP ─────────────────────────────────────────────────────────
function setupDashboard(user) {
  const name  = user.displayName || user.email?.split('@')[0] || 'Usuário';
  const email = user.email || '';
  setText('user-name',  name);
  setText('user-email', email);
  setText('user-avatar', name[0].toUpperCase());
  setText('cfg-name-display',  name);
  setText('cfg-email-display', email);
  document.getElementById('cfg-name-input').value = name;
  startListeners(user.uid);
}

// ── REALTIME LISTENERS ────────────────────────────────────────────
function startListeners(uid) {

  // 1. Última leitura — métricas em tempo real
  refLast = rtdb.ref(`readings/${uid}/last`);
  refLast.on('value', (snap) => {
    const data = snap.val();
    if (!data) return;
    flowHistory.push(data.flow_rate_lpm || 0);
    if (flowHistory.length > 40) flowHistory.shift();
    updateMetrics(data);
    updateGoalBar(data.volume_accumulated_l || 0, GOAL_LIMIT);
    drawSparkline(flowHistory, 'sparkline-svg');
    drawSparkline(flowHistory, 'sparkline-consumo');
    setText('last-seen', 'agora');
    setText('spec-last', new Date().toLocaleTimeString('pt-BR'));
  });

  // 2. Histórico (sparkline)
  refHistory = rtdb.ref(`readings/${uid}/history`).limitToLast(40);
  refHistory.on('value', (snap) => {
    const val = snap.val();
    if (!val) return;
    flowHistory = Object.values(val)
      .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
      .map(r => r.flow_rate_lpm || 0);
    drawSparkline(flowHistory, 'sparkline-svg');
    drawSparkline(flowHistory, 'sparkline-consumo');
  });

  // 3. Dispositivo — detecta se existe e popula todos os campos
  rtdb.ref(`devices/${uid}`).on('value', checkDeviceState);

  // 4. Alertas
  refAlerts = rtdb.ref(`alerts/${uid}`).orderByChild('created_at').limitToLast(20);
  refAlerts.on('value', (snap) => {
    const val = snap.val();
    alertsData = val
      ? Object.entries(val).map(([key, d]) => ({ id: key, ...d }))
          .sort((a, b) => (b.created_at || 0) - (a.created_at || 0))
      : [];
    renderAlerts();
  });

  // 5. Consumo diário + cache para semana/mês
  const today = new Date().toISOString().split('T')[0];
  refDaily = rtdb.ref(`daily/${uid}`);
  refDaily.on('value', (snap) => {
    const val = snap.val();
    dailyCache = val && typeof val === 'object' ? val : {};
    const todayData = dailyCache[today];
    if (todayData?.goal) GOAL_LIMIT = todayData.goal;
    if (todayData?.hours) {
      Object.entries(todayData.hours).forEach(([h, v]) => { hourlyData[parseInt(h)] = v || 0; });
    }
    applyPeriodData();
    renderHourlyBars();
    updateConsumptionPage();
    updateGoalsUsed();
  });

  // 6. Metas do banco (re-carrega para atualizar used)
  rtdb.ref(`goals/${uid}`).on('value', (snap) => {
    const g = snap.val();
    if (!g) return;
    if (g.daily)   { GOAL_LIMIT = g.daily; setText('meta-diaria-limit', g.daily); setText('goal-limit', g.daily); }
    if (g.weekly)  setText('meta-semanal-limit', g.weekly);
    if (g.monthly) setText('meta-mensal-limit', g.monthly);
    if (g.leak_minutes) setText('meta-leak-limit', g.leak_minutes);
    if (g.leak_flow_lpm) setText('meta-leak-flow', g.leak_flow_lpm);
    if (g.notif_push  !== undefined) document.getElementById('notif-push').checked  = g.notif_push;
    if (g.notif_email !== undefined) document.getElementById('notif-email').checked = g.notif_email;
    if (g.notif_leak  !== undefined) document.getElementById('notif-leak').checked  = g.notif_leak;
    if (g.notif_goal  !== undefined) document.getElementById('notif-goal').checked  = g.notif_goal;
  });
}

// ── MÉTRICAS ──────────────────────────────────────────────────────
function updateMetrics(data) {
  const flow = data.flow_rate_lpm        ?? 0;
  const vol  = data.volume_accumulated_l ?? 0;

  setText('flow-val',   flow.toFixed(1));
  setText('volume-val', vol.toFixed(0));

  // Válvula
  const valveOpen = data.valve_open;
  setText('valve-val', valveOpen ? 'Aberta' : 'Fechada');
  const valveEl = document.getElementById('valve-status');
  setChange(valveEl, valveOpen ? 'up' : 'down', valveOpen ? '↑ Fluxo liberado' : '↓ Fluxo bloqueado');

  // Variação de vazão
  const prev = flowHistory[flowHistory.length - 2] ?? flow;
  const diff = flow - prev;
  const fcEl = document.getElementById('flow-change');
  fcEl.className = 'mc-change ' + (diff >= 0 ? 'up' : 'down');
  fcEl.textContent = (diff >= 0 ? '↑' : '↓') + ' ' + Math.abs(diff).toFixed(2) + ' L/min';

  setText('volume-change', `${((vol / GOAL_LIMIT) * 100).toFixed(0)}% da meta diária`);

  // Sparkline stats
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

// ── META / GOAL BAR ───────────────────────────────────────────────
function updateGoalBar(used, limit) {
  const pct = Math.min((used / limit) * 100, 105);
  const remaining = Math.max(limit - used, 0);
  const bar = document.getElementById('goal-bar');
  bar.style.width = pct + '%';
  bar.className   = 'goal-bar-fill' + (pct > 100 ? ' over' : '');
  setText('goal-used',       used.toFixed(0));
  setText('goal-limit',      String(limit));
  setText('goal-pct',        pct.toFixed(0) + '% utilizado');
  setText('goal-remaining',  remaining.toFixed(0) + 'L restantes');
  // Metas page
  setText('meta-diaria-used', used.toFixed(0));
  const mdBar = document.getElementById('meta-diaria-bar');
  mdBar.style.width = pct + '%';
  mdBar.className = 'gdc-bar-fill' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');
}

// ── ALERTAS ───────────────────────────────────────────────────────
const ALERT_LABELS = {
  LEAK_DETECTED:  'Vazamento', GOAL_EXCEEDED: 'Meta',
  ABNORMAL_FLOW:  'Fluxo anormal', LOW_PRESSURE: 'Pressão',
  DEVICE_OFFLINE: 'Sensor offline',
};

function renderAlerts() {
  const unread = alertsData.filter(a => !a.read).length;
  setText('unread-count', unread + ' não lido' + (unread !== 1 ? 's' : ''));
  setText('alertas-subtitle', `${alertsData.length} alertas — ${unread} não lidos`);

  // Badge no sidebar
  const badge = document.getElementById('sidebar-unread-badge');
  badge.style.display = unread > 0 ? 'inline' : 'none';
  badge.textContent = unread;

  const html = alertsData.length
    ? alertsData.map(a => alertHtml(a)).join('')
    : '<div class="empty-state">Nenhum alerta registrado</div>';

  const painel = document.getElementById('alerts-list-painel');
  const full   = document.getElementById('alerts-list-full');
  const previewHtml = alertsData.slice(0, 5).map(a => alertHtml(a)).join('') || '<div class="empty-state">Nenhum alerta</div>';
  if (painel) painel.innerHTML = previewHtml;
  if (full)   full.innerHTML = html;
}

function alertHtml(a) {
  const ts   = a.created_at ? new Date(a.created_at) : new Date();
  const time = ts.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
  const safeId = String(a.id || '').replace(/[^a-zA-Z0-9_.-]/g, '');
  const safeMsg = escapeHtml(String(a.message || ''));
  const safeSeverity = ['low','medium','high'].includes(a.severity) ? a.severity : 'low';
  return `
    <div class="alert-item ${safeSeverity} ${a.read ? 'read' : ''}" onclick="markAlertRead('${safeId}')">
      <div class="alert-type-indicator ${safeSeverity}"></div>
      <div class="alert-body">
        <div class="alert-type-label">${escapeHtml(ALERT_LABELS[a.type] || 'Alerta')}</div>
        <div class="alert-msg">${safeMsg}</div>
        <div class="alert-time">${escapeHtml(time)}</div>
      </div>
      ${!a.read ? '<div class="alert-unread-dot"></div>' : ''}
    </div>`;
}

function markAlertRead(alertId) {
  if (!currentUid) return;
  rtdb.ref(`alerts/${currentUid}/${alertId}/read`).set(true);
}

function markAllRead() {
  if (!currentUid || !alertsData.length) return;
  const updates = {};
  alertsData.forEach(a => { updates[`alerts/${currentUid}/${a.id}/read`] = true; });
  rtdb.ref().update(updates);
}

// ── SPARKLINE ─────────────────────────────────────────────────────
function drawSparkline(data, svgId) {
  const svg = document.getElementById(svgId);
  if (!svg || !data.length) return;
  const vb  = svg.getAttribute('viewBox');
  const parts = vb ? vb.split(/\s+/) : ['0','0','600','100'];
  const W   = parseInt(parts[2]) || 600;
  const H   = parseInt(parts[3]) || 100;
  const PAD = 8;
  const min = Math.min(...data) * 0.85;
  const max = Math.max(Math.max(...data) * 1.1, min + 0.01);
  const pts = data.map((v, i) => [
    PAD + (i / Math.max(data.length - 1, 1)) * (W - PAD * 2),
    H - PAD - ((v - min) / (max - min)) * (H - PAD * 2)
  ]);
  const line = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = line + ` L${pts[pts.length-1][0]},${H} L${pts[0][0]},${H} Z`;
  const last = pts[pts.length - 1];
  svg.innerHTML = `
    <defs>
      <linearGradient id="sg_${svgId}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#0AA1FF" stop-opacity="0.3"/>
        <stop offset="100%" stop-color="#0AA1FF" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#sg_${svgId})"/>
    <path d="${line}" fill="none" stroke="#0AA1FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="3.5" fill="#0AA1FF"/>
    <circle cx="${last[0]}" cy="${last[1]}" r="7" fill="#0AA1FF" opacity="0.18"/>
  `;
}

// ── BARRAS HORÁRIAS ───────────────────────────────────────────────
function renderHourlyBars() {
  const container = document.getElementById('hourly-bars');
  if (!container) return;
  const currentH = new Date().getHours();
  const max = Math.max(...hourlyData, 1);
  container.innerHTML = hourlyData.map((v, h) => `
    <div class="mini-bar-col">
      <div class="mini-bar ${h === currentH ? 'active' : ''}"
           style="height:${Math.max((v / max) * 76, 4)}px"
           title="${h}h: ${v.toFixed(1)}L"></div>
    </div>`).join('');
}

// ── PÁGINA CONSUMO ────────────────────────────────────────────────
function updateConsumptionPage() {
  const total = hourlyData.reduce((a, b) => a + b, 0);
  const peak  = Math.max(...hourlyData);
  const active = hourlyData.filter(v => v > 0).length;
  const avg   = active > 0 ? total / active : 0;
  setText('cons-total',        total.toFixed(0));
  setText('cons-peak',         peak.toFixed(1));
  setText('cons-avg',          avg.toFixed(1));
  setText('cons-active-hours', String(active));
  renderBarChart();
}

function renderBarChart() {
  const container = document.getElementById('cons-bar-chart');
  if (!container) return;
  const currentH = new Date().getHours();
  const max = Math.max(...hourlyData, 1);
  container.innerHTML = hourlyData.map((v, h) => `
    <div class="bar-item" style="position:relative">
      <div class="bar-fill ${h === currentH ? 'today' : ''}"
           style="height:${Math.max((v / max) * 130, 3)}px;width:100%"
           data-val="${v.toFixed(1)}L"></div>
      <span class="bar-label">${h}h</span>
    </div>`).join('');
}

function setPeriod(period, btn) {
  currentPeriod = period;
  document.querySelectorAll('.period-tab').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  const labels = { hoje: 'Hoje', semana: 'Esta semana', mes: 'Este mês' };
  setText('cons-period-label', labels[period]);
  applyPeriodData();
  renderHourlyBars();
  updateConsumptionPage();
}

function applyPeriodData() {
  const today = new Date().toISOString().split('T')[0];
  if (currentPeriod === 'hoje') {
    const d = dailyCache[today];
    if (d?.hours) {
      for (let h = 0; h < 24; h++) hourlyData[h] = d.hours[String(h)] || 0;
    }
    return;
  }
  const aggregated = Array(24).fill(0);
  const dates = Object.keys(dailyCache).sort();
  let toSum = [];
  if (currentPeriod === 'semana') {
    const end = new Date();
    for (let i = 0; i < 7; i++) {
      const d = new Date(end); d.setDate(d.getDate() - i);
      toSum.push(d.toISOString().split('T')[0]);
    }
  } else {
    const now = new Date();
    const y = now.getFullYear(), m = String(now.getMonth() + 1).padStart(2, '0');
    toSum = dates.filter(d => d.startsWith(y + '-' + m));
  }
  toSum.forEach(date => {
    const d = dailyCache[date];
    if (!d?.hours) return;
    for (let h = 0; h < 24; h++) aggregated[h] += d.hours[String(h)] || 0;
  });
  for (let h = 0; h < 24; h++) hourlyData[h] = aggregated[h];
}

function updateGoalsUsed() {
  const today = new Date().toISOString().split('T')[0];
  const now = new Date();
  let weeklyUsed = 0, monthlyUsed = 0;
  Object.entries(dailyCache).forEach(([date, d]) => {
    const total = d?.total ?? (d?.hours ? Object.values(d.hours).reduce((a, v) => a + (v || 0), 0) : 0);
    const dt = new Date(date);
    if (dt >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)) weeklyUsed += total;
    if (date.startsWith(now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0'))) monthlyUsed += total;
  });
  setText('meta-semanal-used', weeklyUsed.toFixed(0));
  setText('meta-mensal-used', monthlyUsed.toFixed(0));
  const weeklyLimit = Math.max(parseInt(document.getElementById('meta-semanal-limit')?.textContent) || 1225, 1);
  const monthlyLimit = Math.max(parseInt(document.getElementById('meta-mensal-limit')?.textContent) || 5250, 1);
  const mdBarS = document.getElementById('meta-semanal-bar');
  const mdBarM = document.getElementById('meta-mensal-bar');
  if (mdBarS) { mdBarS.style.width = Math.min((weeklyUsed / weeklyLimit) * 100, 105) + '%'; mdBarS.className = 'gdc-bar-fill' + (weeklyUsed >= weeklyLimit ? ' over' : weeklyUsed >= weeklyLimit * 0.8 ? ' warn' : ''); }
  if (mdBarM) { mdBarM.style.width = Math.min((monthlyUsed / monthlyLimit) * 100, 105) + '%'; mdBarM.className = 'gdc-bar-fill' + (monthlyUsed >= monthlyLimit ? ' over' : monthlyUsed >= monthlyLimit * 0.8 ? ' warn' : ''); }
}

// ── METAS ─────────────────────────────────────────────────────────
function editMeta(type) {
  const labels = { diaria: 'diária (L)', semanal: 'semanal (L)', mensal: 'mensal (L)', vazamento: 'vazamento (min)', vazamento_fluxo: 'vazão mínima (L/min)' };
  const currentId = { diaria: 'meta-diaria-limit', semanal: 'meta-semanal-limit', mensal: 'meta-mensal-limit', vazamento: 'meta-leak-limit', vazamento_fluxo: 'meta-leak-flow' };
  const current = document.getElementById(currentId[type])?.textContent || '';
  const val = prompt(`Nova meta ${labels[type]}:`, current);
  if (!val || isNaN(val) || !currentUid) return;
  const num = parseFloat(val);
  const paths = { diaria: 'daily', semanal: 'weekly', mensal: 'monthly', vazamento: 'leak_minutes', vazamento_fluxo: 'leak_flow_lpm' };
  rtdb.ref(`goals/${currentUid}/${paths[type]}`).set(num);
  setText(currentId[type], String(num));
  if (type === 'diaria') { GOAL_LIMIT = num; setText('goal-limit', num); }
  showToast('Meta atualizada!');
}

// ── CONFIGURAÇÕES ─────────────────────────────────────────────────
function saveProfile() {
  const newName = document.getElementById('cfg-name-input').value.trim();
  if (!newName || !currentUid) return;
  auth.currentUser?.updateProfile({ displayName: newName });
  rtdb.ref(`users/${currentUid}/name`).set(newName);
  setText('user-name', newName);
  setText('cfg-name-display', newName);
  showToast('Nome atualizado!');
}

async function savePassword() {
  const np = document.getElementById('cfg-new-pass')?.value || '';
  const cp = document.getElementById('cfg-confirm-pass')?.value || '';
  const currPass = document.getElementById('cfg-curr-pass')?.value || '';
  if (!np || np !== cp) { showToast('As senhas não coincidem.', 'error'); return; }
  if (np.length < 6)    { showToast('Mínimo 6 caracteres.', 'error'); return; }
  try {
    const user = auth.currentUser;
    if (!user) { showToast('Faça login novamente.', 'error'); return; }
    if (currPass) {
      const cred = firebase.auth.EmailAuthProvider.credential(user.email, currPass);
      await user.reauthenticateWithCredential(cred);
    }
    await user.updatePassword(np);
    document.getElementById('cfg-new-pass').value = '';
    document.getElementById('cfg-confirm-pass').value = '';
    const currEl = document.getElementById('cfg-curr-pass');
    if (currEl) currEl.value = '';
    showToast('Senha alterada!');
  } catch (err) {
    const msg = err.code === 'auth/requires-recent-login' ? 'Por segurança, informe sua senha atual.' :
      err.code === 'auth/wrong-password' ? 'Senha atual incorreta.' :
      err.code === 'auth/weak-password' ? 'Nova senha muito fraca.' : 'Erro. Faça login novamente.';
    showToast(msg, 'error');
  }
}

function saveNotifications() {
  if (!currentUid) return;
  rtdb.ref(`goals/${currentUid}`).update({
    notif_push:  document.getElementById('notif-push').checked,
    notif_email: document.getElementById('notif-email').checked,
    notif_leak:  document.getElementById('notif-leak').checked,
    notif_goal:  document.getElementById('notif-goal').checked,
  });
  showToast('Notificações salvas!');
}

// ── NAVEGAÇÃO ENTRE PÁGINAS ───────────────────────────────────────
function showPage(pageId, btn) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.sidebar-link').forEach(b => b.classList.remove('active'));
  document.getElementById('page-' + pageId)?.classList.add('active');
  btn?.classList.add('active');
  if (pageId === 'consumo') updateConsumptionPage();
}

// ── LOGOUT ────────────────────────────────────────────────────────
function handleLogout() {
  if (refLast)    refLast.off();
  if (refHistory) refHistory.off();
  if (refAlerts)  refAlerts.off();
  if (refDaily)   refDaily.off();
  if (currentUid) rtdb.ref(`devices/${currentUid}`).off();
  auth.signOut().then(() => { window.location.href = '../index.html'; });
}

// ── TOAST (substitui alert) ───────────────────────────────────────
function showToast(msg, type = 'success') {
  const existing = document.getElementById('toast-root');
  if (existing) existing.remove();
  const root = document.createElement('div');
  root.id = 'toast-root';
  root.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:.75rem 1.2rem;border-radius:12px;font-size:.9rem;font-weight:500;box-shadow:0 4px 20px rgba(0,0,0,.15);animation:toastIn .3s ease;background:' + (type === 'error' ? '#ef4444' : '#10b981') + ';color:#fff;max-width:320px;';
  root.textContent = msg;
  document.body.appendChild(root);
  setTimeout(() => { root.style.opacity = '0'; root.style.transition = 'opacity .2s'; setTimeout(() => root.remove(), 200); }, 3000);
}
const styleToast = document.createElement('style');
styleToast.textContent = '@keyframes toastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}';
document.head.appendChild(styleToast);

// ── UTILS ─────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (!str || typeof str !== 'string') return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setChange(el, dir, txt) { if (el) { el.className = 'mc-change ' + dir; el.textContent = txt; } }

function updateDate() {
  const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
  setText('today-date', today);
}

// ── DETECÇÃO DE DISPOSITIVO ───────────────────────────────────────
let hasDevice = false;

function checkDeviceState(snap) {
  const dev = snap.val();
  hasDevice = !!dev;

  document.getElementById('no-device-state').style.display  = hasDevice ? 'none'  : 'flex';
  document.getElementById('has-device-state').style.display = hasDevice ? 'block' : 'none';
  document.getElementById('btn-add-top').style.display      = hasDevice ? 'inline-flex' : 'none';

  // Painel principal — device bar e métricas só fazem sentido com dispositivo
  document.getElementById('device-bar') &&
    (document.getElementById('device-bar').style.opacity = hasDevice ? '1' : '.4');

  if (!dev) {
    // Sidebar card
    setText('sb-device-name',   'Sem dispositivo');
    setText('sb-device-status', 'Não conectado');
    return;
  }

  const name   = dev.name || 'Sensor';
  const id     = dev.device_id || currentUid?.slice(0, 12) || '--';
  const fw     = dev.firmware_version || '--';
  const bat    = dev.battery_pct ?? '--';
  const rssi   = dev.wifi_rssi ?? '--';
  const status = dev.status || 'offline';
  const online = status === 'online';

  // Sidebar
  setText('sb-device-name',   name);
  setText('sb-device-status', online ? 'Online' : 'Offline');

  // Painel — device bar
  setText('device-name',     name);
  setText('device-id-label', id);
  setText('fw-val',          fw);
  setText('battery-val',     bat);
  setText('rssi-val',        rssi);
  const statusEl = document.getElementById('device-status');
  if (statusEl) {
    statusEl.className = 'device-status ' + status;
    statusEl.innerHTML = `<span class="status-dot"></span>${online ? 'Online' : 'Offline'}`;
  }

  // Página dispositivos
  setText('dev-name-big', name);
  setText('dev-id-big',   id);
  setText('dev-fw-big',   fw);
  setText('dev-bat-big',  bat);
  setText('dev-rssi-big', rssi);
  const devStatusBig = document.getElementById('dev-status-big');
  if (devStatusBig) {
    devStatusBig.className = 'device-status ' + status;
    devStatusBig.innerHTML = `<span class="status-dot"></span>${online ? 'Online' : 'Offline'}`;
  }
  setText('spec-id',     id);
  setText('spec-fw',     fw);
  setText('spec-status', online ? 'Online' : 'Offline');
  setText('spec-bat',    bat + '%');
  setText('spec-rssi',   rssi + ' dBm');
}

// Substitui o antigo listener de dispositivo — agora usa checkDeviceState
function startDeviceListener(uid) {
  rtdb.ref(`devices/${uid}`).on('value', checkDeviceState);
}

// ── MODAL: ADICIONAR DISPOSITIVO ──────────────────────────────────
function openAddDevice() {
  goStep(1);
  document.getElementById('modal-add-device').classList.remove('hidden');
  document.getElementById('add-dev-name').value  = '';
  document.getElementById('add-dev-id').value    = '';
  document.getElementById('add-wifi-ssid').value = '';
  document.getElementById('add-wifi-pass').value = '';
  document.getElementById('add-dev-goal').value  = '175';
  document.getElementById('step1-error').style.display = 'none';
  document.getElementById('step2-error').style.display = 'none';
}

function closeAddDevice() {
  document.getElementById('modal-add-device').classList.add('hidden');
  // Se chegou ao passo 3 (sucesso), vai para o painel
  if (document.getElementById('modal-step-3').style.display !== 'none') {
    showPage('painel', document.querySelector('.sidebar-link'));
  }
}

function goStep(n) {
  [1, 2, 3].forEach(i => {
    document.getElementById(`modal-step-${i}`).style.display = i === n ? 'block' : 'none';
  });
}

function validateStep1() {
  const name = document.getElementById('add-dev-name').value.trim();
  const id   = document.getElementById('add-dev-id').value.trim();
  const err  = document.getElementById('step1-error');
  if (!name) { err.textContent = 'Informe o nome do dispositivo.'; err.style.display = 'block'; return false; }
  if (!id)   { err.textContent = 'Informe o Device ID do sensor.'; err.style.display = 'block'; return false; }
  err.style.display = 'none';
  return true;
}

// goStep com validação no passo 1 → 2
const _goStep = goStep;
window.goStep = function(n) {
  if (n === 2 && !validateStep1()) return;
  _goStep(n);
};

async function saveDevice() {
  const ssid = document.getElementById('add-wifi-ssid').value.trim();
  const pass = document.getElementById('add-wifi-pass').value;
  const err  = document.getElementById('step2-error');

  if (!ssid) { err.textContent = 'Informe o nome da rede Wi-Fi.'; err.style.display = 'block'; return; }
  if (!pass)  { err.textContent = 'Informe a senha do Wi-Fi.';    err.style.display = 'block'; return; }
  err.style.display = 'none';

  const btn  = document.getElementById('btn-save-device');
  const spin = document.getElementById('save-btn-spin');
  const text = document.getElementById('save-btn-text');
  btn.disabled = true; spin.style.display = 'block'; text.style.display = 'none';

  const name     = document.getElementById('add-dev-name').value.trim();
  const deviceId = document.getElementById('add-dev-id').value.trim();
  const location = document.getElementById('add-dev-location').value;
  const goal     = parseFloat(document.getElementById('add-dev-goal').value) || 175;

  try {
    // Salva dispositivo no RTDB
    await rtdb.ref(`devices/${currentUid}`).set({
      name,
      device_id: deviceId,
      location,
      status: 'offline',       // Ficará online quando o ESP32 conectar
      firmware_version: '--',
      battery_pct: null,
      wifi_rssi: null,
      wifi_ssid: ssid,         // O ESP32 lê isso para conectar
      wifi_pass: pass,         // ⚠️ Em produção use regras de segurança restritas
      added_at: Date.now(),
    });

    // Atualiza meta diária
    await rtdb.ref(`goals/${currentUid}/daily`).set(goal);

    // Atualiza daily de hoje com goal
    const today = new Date().toISOString().split('T')[0];
    await rtdb.ref(`daily/${currentUid}/${today}/goal`).set(goal);

    GOAL_LIMIT = goal;
    setText('confirm-dev-name', name);
    goStep(3);

  } catch (e) {
    err.textContent = 'Erro ao salvar. Tente novamente.';
    err.style.display = 'block';
  } finally {
    btn.disabled = false; spin.style.display = 'none'; text.style.display = 'inline';
  }
}

// ── RENOMEAR / REMOVER ────────────────────────────────────────────
function openRenameDevice() {
  const current = document.getElementById('dev-name-big').textContent;
  const newName = prompt('Novo nome para o dispositivo:', current);
  if (!newName?.trim() || !currentUid) return;
  rtdb.ref(`devices/${currentUid}/name`).set(newName.trim());
}

function confirmRemoveDevice() {
  const name = document.getElementById('dev-name-big').textContent;
  if (!confirm(`Remover "${name}"? Os dados de leitura serão mantidos.`)) return;
  if (!currentUid) return;
  rtdb.ref(`devices/${currentUid}`).remove();
}

// Fechar modal ao clicar fora
document.getElementById('modal-add-device')?.addEventListener('click', function(e) {
  if (e.target === this) closeAddDevice();
});
