/**
 * LetControl — Cloud Functions
 *
 * Responsabilidades:
 *  1. Detecção de vazamento 24/7  (onValueWritten readings/{deviceId}/live)
 *  2. Push FCM em todo alerta novo (onValueCreated alerts/{uid}/{aid})
 *  3. Atualização periódica de consumoHoje / consumoMes / consumoAnual
 *     (scheduled, a cada 10 min)
 *
 * Deploy:
 *   cd functions && npm install
 *   firebase deploy --only functions
 */

const { onValueCreated, onValueWritten } = require('firebase-functions/v2/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const Anthropic = require('@anthropic-ai/sdk');

admin.initializeApp();
const db = admin.database();
const messaging = admin.messaging();

// Configure com:  firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

// URL pública do site. O firebase.json usa "public": "letcontrol", então o
// conteúdo de letcontrol/ é servido na RAIZ do domínio — daí os caminhos
// abaixo não levarem prefixo /letcontrol.
// O push é montado no servidor, que não conhece a origem do cliente, então
// as URLs precisam ser absolutas (o Web Push exige HTTPS).
const SITE_URL = 'https://letcontrol-database.web.app';
const NOTIFICATION_ICON = `${SITE_URL}/images/icons/icon-192.png`;

// ─────────────────────────────────────────────────────────────────
// 1. DETECÇÃO DE VAZAMENTO 24/7
// ─────────────────────────────────────────────────────────────────
// Dispara em toda escrita do nó live do ESP32. Mantém estado em
// _leak_state/{deviceId} pra calcular duração contínua sem precisar
// varrer o histórico a cada execução.
exports.detectLeak = onValueWritten('/readings/{deviceId}/live', async (event) => {
  const deviceId = event.params.deviceId;
  const live = event.data.after.val();
  if (!live) return;

  // Resolve o dono do dispositivo e os limites
  const [ownerSnap, _stateSnap] = await Promise.all([
    db.ref(`devices/${deviceId}/owner_uid`).once('value'),
    db.ref(`_leak_state/${deviceId}`).once('value'),
  ]);
  const ownerUid = ownerSnap.val();
  if (!ownerUid) { logger.warn('detectLeak: sem owner', { deviceId }); return; }

  const goalsSnap = await db.ref(`goals/${ownerUid}`).once('value');
  const goals = goalsSnap.val() || {};
  const LEAK_MIN = Number(goals.leak_min) || 30;  // minutos
  const LEAK_LPM = Number(goals.leak_lpm) || 0.5; // L/min
  const COOLDOWN_MS = 60 * 60 * 1000;             // 1h entre alertas

  const ts = Number(live.ts) || Date.now();
  const flow = Number(live.flow_lpm) || 0;
  const valveOpen = live.valve_open !== false;

  const stateRef = db.ref(`_leak_state/${deviceId}`);
  const state = _stateSnap.val() || { startTs: null, alertId: null, lastAlertAt: 0 };

  // Sem fluxo ou válvula fechada → resolve alerta aberto (se houver) e reseta
  if (!valveOpen || flow < LEAK_LPM) {
    if (state.alertId) {
      await db.ref(`alerts/${ownerUid}/${state.alertId}`).update({ resolved_at: ts });
      logger.info('Vazamento resolvido', { deviceId, alertId: state.alertId });
    }
    await stateRef.update({ startTs: null, alertId: null });
    return;
  }

  // Fluxo acima do threshold — atualiza/inicia episódio
  if (state.startTs == null) {
    await stateRef.update({ startTs: ts });
    return;
  }

  const durMs = ts - state.startTs;
  if (durMs < LEAK_MIN * 60000) return;
  if (state.alertId) return;                         // já há alerta aberto
  if (ts - (state.lastAlertAt || 0) < COOLDOWN_MS) return; // cooldown

  // Cria alerta novo
  const durMin = Math.round(durMs / 60000);
  const alertRef = db.ref(`alerts/${ownerUid}`).push();
  const alert = {
    type: 'LEAK_DETECTED',
    severity: 'high',
    message: `Fluxo contínuo de ${flow.toFixed(2)} L/min detectado por ${durMin} min.`,
    created_at: state.startTs,
    detected_at: ts,
    device_id: deviceId,
    read: false,
  };
  await alertRef.set(alert);
  await stateRef.update({ alertId: alertRef.key, lastAlertAt: ts });
  logger.info('Vazamento detectado', { deviceId, durMin, flow });
});

// ─────────────────────────────────────────────────────────────────
// 2. PUSH FCM EM NOVO ALERTA
// ─────────────────────────────────────────────────────────────────
// Lê todos os tokens FCM do usuário e envia push. Tokens inválidos
// são removidos automaticamente.
exports.notifyOnAlert = onValueCreated('/alerts/{uid}/{aid}', async (event) => {
  const uid = event.params.uid;
  const aid = event.params.aid;
  const alert = event.data.val();
  if (!alert || !alert.type) return;

  // Respeita preferências do usuário
  const prefsSnap = await db.ref(`preferences/${uid}/notify`).once('value');
  const prefs = prefsSnap.val() || { push: true, leak: true, goal: true };
  if (prefs.push === false) return;
  if (alert.type === 'LEAK_DETECTED' && prefs.leak === false) return;
  if (alert.type === 'GOAL_EXCEEDED' && prefs.goal === false) return;

  // Recupera tokens FCM
  const tokensSnap = await db.ref(`fcm_tokens/${uid}`).once('value');
  const tokensMap = tokensSnap.val() || {};
  const entries = Object.entries(tokensMap)
    .map(([key, v]) => ({ key, token: typeof v === 'string' ? v : v?.token }))
    .filter(e => e.token);
  if (!entries.length) { logger.info('notifyOnAlert: sem tokens', { uid }); return; }

  const titleMap = {
    LEAK_DETECTED: 'Vazamento detectado',
    GOAL_EXCEEDED: 'Meta de consumo atingida',
    ABNORMAL_FLOW: 'Fluxo anormal',
    DEVICE_OFFLINE: 'Sensor offline',
    LOW_BATTERY: 'Bateria baixa',
  };
  const title = titleMap[alert.type] || 'LetControl';
  const body = alert.message || 'Você tem um novo alerta.';

  const message = {
    notification: { title, body },
    data: {
      type: String(alert.type || ''),
      severity: String(alert.severity || 'low'),
      alert_id: aid,
      url: 'pages/dashboard.html#alertas',
    },
    webpush: {
      // O FCM exige HTTPS aqui — caminho relativo é rejeitado. Já o data.url
      // acima continua relativo de propósito: quem o resolve é o
      // notificationclick do SW, usando o scope (funciona em qualquer base).
      fcmOptions: { link: `${SITE_URL}/pages/dashboard.html#alertas` },
      notification: {
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
        requireInteraction: alert.severity === 'high',
      },
    },
  };

  const sends = entries.map(({ key, token }) =>
    messaging.send({ ...message, token })
      .then(() => ({ key, ok: true }))
      .catch(err => ({ key, ok: false, code: err.code }))
  );
  const results = await Promise.all(sends);

  // Limpa tokens inválidos
  const removals = {};
  for (const r of results) {
    if (!r.ok && (
      r.code === 'messaging/registration-token-not-registered' ||
      r.code === 'messaging/invalid-registration-token'
    )) removals[`fcm_tokens/${uid}/${r.key}`] = null;
  }
  if (Object.keys(removals).length) await db.ref().update(removals);

  logger.info('Push enviado', { uid, sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length });
});

// ─────────────────────────────────────────────────────────────────
// 3. ATUALIZAÇÃO DE AGREGADOS (consumoHoje / Mes / Anual)
// ─────────────────────────────────────────────────────────────────
// Roda a cada 10 minutos. Pra cada UID com dados em /daily, soma
// as horas do dia atual, do mês atual e do ano atual.
exports.refreshDailyAggregates = onSchedule(
  { schedule: 'every 10 minutes', timeZone: 'America/Sao_Paulo' },
  async () => {
    const now = new Date();
    const yy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');

    const rootSnap = await db.ref('daily').once('value');
    const all = rootSnap.val() || {};
    const updates = {};

    for (const uid of Object.keys(all)) {
      const userNode = all[uid] || {};
      const year = userNode[yy] || {};
      const month = year[mm] || {};
      const day = month[dd] || {};

      const sumHours = (obj) => {
        if (!obj || typeof obj !== 'object') return 0;
        let s = 0;
        for (const k in obj) if (typeof obj[k] === 'number') s += obj[k];
        return s;
      };
      const sumMonth = (mObj) => {
        let s = 0;
        for (const dk in mObj) s += sumHours(mObj[dk]);
        return s;
      };
      const sumYear = (yObj) => {
        let s = 0;
        for (const mk in yObj) s += sumMonth(yObj[mk]);
        return s;
      };

      const consumoHoje = round2(sumHours(day));
      const consumoMes = round2(sumMonth(month));
      const consumoAnual = round2(sumYear(year));

      updates[`daily/${uid}/consumoHoje`] = consumoHoje;
      updates[`daily/${uid}/consumoMes`] = consumoMes;
      updates[`daily/${uid}/consumoAnual`] = consumoAnual;
    }

    if (Object.keys(updates).length) await db.ref().update(updates);
    logger.info('Agregados atualizados', { users: Object.keys(all).length });
  }
);

function round2(n) { return Math.round(n * 100) / 100; }

// ─────────────────────────────────────────────────────────────────
// 4. ANÁLISE PERSONALIZADA COM CLAUDE
// ─────────────────────────────────────────────────────────────────
// Recebe os dados de consumo do usuário e devolve dicas geradas
// pelo Claude — substitui as dicas hardcoded do client.
// Cache: resposta fica em ai_tips/{uid} por até 6h pra evitar custo.
exports.analyzeConsumption = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Faça login.');
    const uid = request.auth.uid;
    const { days, weekTotal, avgDaily, goalDaily, daysOk, score, force } = request.data || {};

    // Cache (6h)
    const CACHE_TTL = 6 * 60 * 60 * 1000;
    const cacheSnap = await db.ref(`ai_tips/${uid}`).once('value');
    const cached = cacheSnap.val();
    if (!force && cached && (Date.now() - (cached.generated_at || 0)) < CACHE_TTL) {
      logger.info('analyzeConsumption: cache hit', { uid });
      return { tips: cached.tips, cached: true, generated_at: cached.generated_at };
    }

    // Resumo compacto pra economizar tokens
    const summary = (Array.isArray(days) ? days : []).map(d => ({
      data: d.dateKey,
      dia: d.weekday || '',
      consumo_L: Math.round(d.vol || 0),
      meta_L: Math.round(d.goal || goalDaily || 0),
      acima_da_meta: (d.vol || 0) > (d.goal || goalDaily || 0),
      sem_dados: !d.fromDb,
    }));

    const systemPrompt = `Você é um especialista em economia de água residencial no Brasil. Analise os dados de consumo do usuário (últimos 7 dias) e gere recomendações personalizadas, concisas e acionáveis em português brasileiro.

REGRAS:
- Responda APENAS com JSON válido, sem texto fora do JSON.
- Gere de 3 a 5 dicas baseadas nos padrões REAIS dos dados.
- Cada dica deve ser específica ao padrão observado, não genérica.
- Use o tom: profissional mas amigável, direto.
- Volumes sempre em litros inteiros.

FORMATO:
{
  "tips": [
    { "severity": "save|info|warn|over", "title": "Título curto (até 50 chars)", "body": "Análise específica do padrão observado (até 180 chars)" }
  ]
}

Severidade:
- "save"  = elogio (consumo bom)
- "info"  = observação neutra
- "warn"  = alerta moderado (meta próxima)
- "over"  = problema claro (acima da meta, anomalia)`;

    const userPrompt = `Dados de consumo (últimos 7 dias):
${JSON.stringify(summary, null, 2)}

Resumo:
- Total da semana: ${Math.round(weekTotal || 0)}L
- Média diária: ${Math.round(avgDaily || 0)}L
- Meta diária: ${Math.round(goalDaily || 0)}L
- Dias dentro da meta: ${daysOk || 0}/${summary.filter(s => !s.sem_dados).length}
- Eco Score: ${score || 0}/100

Gere recomendações personalizadas em JSON.`;

    try {
      const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      });

      const raw = resp.content?.[0]?.text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new HttpsError('internal', 'Resposta do modelo sem JSON válido.');

      const parsed = JSON.parse(match[0]);
      const tips = (parsed.tips || []).slice(0, 5).map(t => ({
        severity: ['save', 'info', 'warn', 'over'].includes(t.severity) ? t.severity : 'info',
        title: String(t.title || '').slice(0, 100),
        body: String(t.body || '').slice(0, 300),
      })).filter(t => t.title && t.body);

      const result = { tips, generated_at: Date.now() };
      await db.ref(`ai_tips/${uid}`).set(result);
      logger.info('analyzeConsumption: gerou novas dicas', { uid, count: tips.length });
      return { ...result, cached: false };
    } catch (e) {
      logger.error('analyzeConsumption falhou:', e?.message || e);
      throw new HttpsError('internal', 'Falha ao gerar análise: ' + (e?.message || 'erro desconhecido'));
    }
  }
);
