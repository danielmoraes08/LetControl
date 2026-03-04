/**
 * LetControl — Cloud Functions
 * Responsável por:
 *  1. Receber leituras do ESP32 via HTTP (ingestReading)
 *  2. Detectar anomalias e gerar alertas (analyzeReading)
 *  3. Gerar relatório diário consolidado (generateDailyReport)
 *  4. Checar dispositivos offline (checkOfflineDevices)
 */

const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ─── CONSTANTES ──────────────────────────────────────────────────────────────
const PULSES_PER_LITER = 450;         // YF-S201: 450 pulsos = 1 litro
const LEAK_DURATION_MIN = 30;         // Fluxo contínuo > 30 min = possível vazamento
const ANOMALY_MULTIPLIER = 3;         // Vazão 3x acima da média = anomalia
const OFFLINE_THRESHOLD_MIN = 10;     // Sem heartbeat por 10 min = offline
const LOW_PRESSURE_BAR = 0.5;        // Abaixo de 0.5 bar = alerta

// ─────────────────────────────────────────────────────────────────────────────
// 1. INGESTÃO DE LEITURA DO ESP32
//    POST https://<region>-<project>.cloudfunctions.net/ingestReading
//    Headers: x-device-secret: <token cadastrado no device>
// ─────────────────────────────────────────────────────────────────────────────
exports.ingestReading = onRequest(
  { region: "southamerica-east1", cors: false },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).send("Method Not Allowed");

    const secret = req.headers["x-device-secret"];
    const body = req.body;

    // Validação básica do payload
    if (!body.device_id || body.flow_rate == null) {
      return res.status(400).json({ error: "Payload inválido" });
    }

    // Buscar o device e validar o secret
    const deviceRef = db.collection("devices").doc(body.device_id);
    const deviceSnap = await deviceRef.get();

    if (!deviceSnap.exists) {
      return res.status(404).json({ error: "Dispositivo não encontrado" });
    }

    const device = deviceSnap.data();

    if (device.api_secret !== secret) {
      return res.status(401).json({ error: "Não autorizado" });
    }

    // Enriquecer o payload
    const now = admin.firestore.Timestamp.now();
    const dateObj = now.toDate();
    const dateBucket = dateObj.toISOString().split("T")[0]; // "YYYY-MM-DD"

    // Calcular volume acumulado do dia (pulsos → litros)
    const volumeToday = (body.pulse_count || 0) / PULSES_PER_LITER;

    const reading = {
      // Identificadores
      device_id: body.device_id,
      user_id: device.user_id,

      // Dados do sensor
      flow_rate_lpm: parseFloat((body.flow_rate || 0).toFixed(2)),
      volume_accumulated_l: parseFloat(volumeToday.toFixed(2)),
      pulse_count: body.pulse_count || 0,
      pressure_bar: parseFloat((body.pressure || 0).toFixed(2)),
      temperature_c: parseFloat((body.temperature || 0).toFixed(1)),

      // Estado
      valve_open: body.valve_open !== false, // default: aberta
      anomaly_detected: false, // será atualizado pela analyzeReading

      // Conectividade
      wifi_rssi: body.wifi_rssi || 0,
      battery_pct: body.battery_pct || 100,

      // Tempo
      timestamp: now,
      date_bucket: dateBucket,
    };

    // Salvar leitura
    await db.collection("readings").add(reading);

    // Atualizar last_seen e status do device
    await deviceRef.update({
      last_seen: now,
      status: "online",
      battery_pct: reading.battery_pct,
      wifi_rssi: reading.wifi_rssi,
    });

    return res.status(201).json({ ok: true, date_bucket: dateBucket });
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 2. ANÁLISE DE ANOMALIAS (trigger ao criar nova leitura)
// ─────────────────────────────────────────────────────────────────────────────
exports.analyzeReading = onDocumentCreated(
  { document: "readings/{readingId}", region: "southamerica-east1" },
  async (event) => {
    const reading = event.data.data();
    const readingRef = event.data.ref;

    const alerts = [];
    let anomaly = false;

    // ── 1. Verificar baixa pressão ──────────────────────────────
    if (reading.pressure_bar > 0 && reading.pressure_bar < LOW_PRESSURE_BAR) {
      alerts.push({
        type: "LOW_PRESSURE",
        severity: "medium",
        message: `Pressão baixa detectada: ${reading.pressure_bar} bar`,
        flow_at_alert: reading.flow_rate_lpm,
        extra: { pressure_bar: reading.pressure_bar },
      });
      anomaly = true;
    }

    // ── 2. Verificar fluxo anormal vs. média histórica ───────────
    if (reading.flow_rate_lpm > 0) {
      const hourAgo = new Date(reading.timestamp.toDate().getTime() - 60 * 60 * 1000);
      const recentSnap = await db.collection("readings")
        .where("device_id", "==", reading.device_id)
        .where("timestamp", ">=", admin.firestore.Timestamp.fromDate(hourAgo))
        .where("timestamp", "<", reading.timestamp)
        .orderBy("timestamp", "desc")
        .limit(60)
        .get();

      if (!recentSnap.empty) {
        const flows = recentSnap.docs.map(d => d.data().flow_rate_lpm);
        const avg = flows.reduce((a, b) => a + b, 0) / flows.length;

        if (avg > 0 && reading.flow_rate_lpm > avg * ANOMALY_MULTIPLIER) {
          alerts.push({
            type: "ABNORMAL_FLOW",
            severity: "high",
            message: `Vazão anormal: ${reading.flow_rate_lpm} L/min (média: ${avg.toFixed(1)} L/min)`,
            flow_at_alert: reading.flow_rate_lpm,
            extra: { avg_lpm: parseFloat(avg.toFixed(2)), multiplier: ANOMALY_MULTIPLIER },
          });
          anomaly = true;
        }
      }
    }

    // ── 3. Verificar vazamento (fluxo noturno contínuo) ─────────
    const hour = reading.timestamp.toDate().getHours();
    const isNight = hour >= 1 && hour <= 5; // madrugada = risco maior

    if (isNight && reading.flow_rate_lpm > 0.5) {
      const sinceTime = new Date(
        reading.timestamp.toDate().getTime() - LEAK_DURATION_MIN * 60 * 1000
      );

      const continuousSnap = await db.collection("readings")
        .where("device_id", "==", reading.device_id)
        .where("timestamp", ">=", admin.firestore.Timestamp.fromDate(sinceTime))
        .where("flow_rate_lpm", ">", 0.5)
        .orderBy("flow_rate_lpm")
        .orderBy("timestamp")
        .limit(1)
        .get();

      if (!continuousSnap.empty) {
        // Verificar se não existe alerta de vazamento ativo já
        const existingLeak = await db.collection("alerts")
          .where("device_id", "==", reading.device_id)
          .where("type", "==", "LEAK_DETECTED")
          .where("resolved", "==", false)
          .limit(1)
          .get();

        if (existingLeak.empty) {
          alerts.push({
            type: "LEAK_DETECTED",
            severity: "high",
            message: `Possível vazamento: fluxo de ${reading.flow_rate_lpm} L/min por mais de ${LEAK_DURATION_MIN} min`,
            flow_at_alert: reading.flow_rate_lpm,
            duration_minutes: LEAK_DURATION_MIN,
            extra: {},
          });
          anomaly = true;
        }
      }
    }

    // ── 4. Verificar meta diária ─────────────────────────────────
    const goalsSnap = await db.collection("goals")
      .where("user_id", "==", reading.user_id)
      .where("device_id", "==", reading.device_id)
      .where("active", "==", true)
      .where("period", "==", "daily")
      .limit(1)
      .get();

    if (!goalsSnap.empty) {
      const goal = goalsSnap.docs[0].data();
      const alertPct = goal.alert_at_pct || 80;
      const usedPct = (reading.volume_accumulated_l / goal.limit_liters) * 100;

      if (usedPct >= alertPct && usedPct < 105) {
        // Checar se já foi notificado hoje
        const today = reading.date_bucket;
        const existingGoalAlert = await db.collection("alerts")
          .where("device_id", "==", reading.device_id)
          .where("type", "==", "GOAL_EXCEEDED")
          .where("date_bucket", "==", today)
          .limit(1)
          .get();

        if (existingGoalAlert.empty) {
          alerts.push({
            type: "GOAL_EXCEEDED",
            severity: "medium",
            message: `${usedPct.toFixed(0)}% da meta diária atingida (${reading.volume_accumulated_l}L / ${goal.limit_liters}L)`,
            flow_at_alert: reading.flow_rate_lpm,
            extra: {
              used_liters: reading.volume_accumulated_l,
              limit_liters: goal.limit_liters,
              pct: parseFloat(usedPct.toFixed(1)),
            },
          });
        }
      }
    }

    // ── 5. Salvar alertas gerados ────────────────────────────────
    const batch = db.batch();

    for (const alert of alerts) {
      const alertRef = db.collection("alerts").doc();
      batch.set(alertRef, {
        ...alert,
        user_id: reading.user_id,
        device_id: reading.device_id,
        date_bucket: reading.date_bucket,
        reading_id: readingRef.id,
        read: false,
        resolved: false,
        created_at: admin.firestore.Timestamp.now(),
      });
    }

    if (anomaly) {
      batch.update(readingRef, { anomaly_detected: true });
    }

    await batch.commit();
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 3. RELATÓRIO DIÁRIO — roda todo dia às 00:05 (horário de Brasília)
// ─────────────────────────────────────────────────────────────────────────────
exports.generateDailyReport = onSchedule(
  {
    schedule: "5 3 * * *", // 00:05 BRT = 03:05 UTC
    timeZone: "America/Sao_Paulo",
    region: "southamerica-east1",
  },
  async () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateBucket = yesterday.toISOString().split("T")[0];

    // Buscar todos os devices ativos
    const devicesSnap = await db.collection("devices")
      .where("status", "in", ["online", "offline"])
      .get();

    const batch = db.batch();

    for (const deviceDoc of devicesSnap.docs) {
      const device = deviceDoc.data();

      // Buscar leituras do dia anterior
      const readingsSnap = await db.collection("readings")
        .where("device_id", "==", deviceDoc.id)
        .where("date_bucket", "==", dateBucket)
        .orderBy("timestamp")
        .get();

      if (readingsSnap.empty) continue;

      const readings = readingsSnap.docs.map(d => d.data());

      // Calcular métricas
      const flows = readings.map(r => r.flow_rate_lpm);
      const totalVolume = readings[readings.length - 1]?.volume_accumulated_l || 0;
      const peakFlow = Math.max(...flows);
      const avgFlow = flows.reduce((a, b) => a + b, 0) / flows.length;

      // Consumo por hora
      const hourlyMap = {};
      for (const r of readings) {
        const h = r.timestamp.toDate().getHours();
        if (!hourlyMap[h]) hourlyMap[h] = 0;
        hourlyMap[h] += (r.flow_rate_lpm * (5 / 60)); // L em 5 segundos
      }

      const usagePeriods = Object.entries(hourlyMap)
        .map(([hour, vol]) => ({ hour: parseInt(hour), volume_l: parseFloat(vol.toFixed(1)) }))
        .sort((a, b) => b.volume_l - a.volume_l)
        .slice(0, 5);

      // Meta do dia
      const goalSnap = await db.collection("goals")
        .where("user_id", "==", device.user_id)
        .where("device_id", "==", deviceDoc.id)
        .where("active", "==", true)
        .where("period", "==", "daily")
        .limit(1)
        .get();

      const goal = goalSnap.empty ? null : goalSnap.docs[0].data();
      const goalPct = goal ? (totalVolume / goal.limit_liters) * 100 : null;

      // Alertas do dia
      const alertsSnap = await db.collection("alerts")
        .where("device_id", "==", deviceDoc.id)
        .where("date_bucket", "==", dateBucket)
        .get();

      const anomalyCount = readings.filter(r => r.anomaly_detected).length;
      const avgRssi = readings.reduce((a, r) => a + (r.wifi_rssi || 0), 0) / readings.length;
      const uptimePct = (readings.length / 17280) * 100; // 17280 = leituras esperadas/dia

      // Buscar relatório do dia anterior para comparativo
      const prevDate = new Date(yesterday);
      prevDate.setDate(prevDate.getDate() - 1);
      const prevBucket = prevDate.toISOString().split("T")[0];

      const prevReportSnap = await db.collection("daily_reports")
        .doc(`${device.user_id}_${deviceDoc.id}_${prevBucket}`)
        .get();

      let vsPrevDayPct = null;
      if (prevReportSnap.exists) {
        const prevVol = prevReportSnap.data().total_volume_l;
        if (prevVol > 0) {
          vsPrevDayPct = parseFloat((((totalVolume - prevVol) / prevVol) * 100).toFixed(1));
        }
      }

      const reportId = `${device.user_id}_${deviceDoc.id}_${dateBucket}`;
      const reportRef = db.collection("daily_reports").doc(reportId);

      batch.set(reportRef, {
        user_id: device.user_id,
        device_id: deviceDoc.id,
        date: dateBucket,

        // Consumo
        total_volume_l: parseFloat(totalVolume.toFixed(1)),
        peak_flow_lpm: parseFloat(peakFlow.toFixed(2)),
        avg_flow_lpm: parseFloat(avgFlow.toFixed(2)),
        usage_periods: usagePeriods,

        // Meta
        goal_limit_l: goal?.limit_liters || null,
        goal_pct_used: goalPct ? parseFloat(goalPct.toFixed(1)) : null,
        goal_met: goalPct ? goalPct <= 100 : null,

        // Comparativo
        vs_prev_day_pct: vsPrevDayPct,

        // Qualidade
        avg_wifi_rssi: parseFloat(avgRssi.toFixed(0)),
        readings_count: readings.length,
        uptime_pct: parseFloat(uptimePct.toFixed(1)),
        alerts_count: alertsSnap.size,
        anomalies_detected: anomalyCount > 0,

        generated_at: admin.firestore.Timestamp.now(),
      });
    }

    await batch.commit();
    console.log(`[generateDailyReport] Relatórios gerados para ${dateBucket}`);
  }
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. CHECAR DISPOSITIVOS OFFLINE — roda a cada 15 minutos
// ─────────────────────────────────────────────────────────────────────────────
exports.checkOfflineDevices = onSchedule(
  {
    schedule: "*/15 * * * *",
    region: "southamerica-east1",
  },
  async () => {
    const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MIN * 60 * 1000);

    const devicesSnap = await db.collection("devices")
      .where("status", "==", "online")
      .where("last_seen", "<", admin.firestore.Timestamp.fromDate(threshold))
      .get();

    const batch = db.batch();

    for (const deviceDoc of devicesSnap.docs) {
      const device = deviceDoc.data();

      // Marcar como offline
      batch.update(deviceDoc.ref, { status: "offline" });

      // Verificar se já existe alerta de offline não resolvido
      const existingSnap = await db.collection("alerts")
        .where("device_id", "==", deviceDoc.id)
        .where("type", "==", "DEVICE_OFFLINE")
        .where("resolved", "==", false)
        .limit(1)
        .get();

      if (existingSnap.empty) {
        const alertRef = db.collection("alerts").doc();
        const now = admin.firestore.Timestamp.now();
        batch.set(alertRef, {
          type: "DEVICE_OFFLINE",
          severity: "low",
          message: `Sensor "${device.name}" está sem comunicação há mais de ${OFFLINE_THRESHOLD_MIN} minutos.`,
          user_id: device.user_id,
          device_id: deviceDoc.id,
          date_bucket: now.toDate().toISOString().split("T")[0],
          flow_at_alert: 0,
          read: false,
          resolved: false,
          created_at: now,
        });
      }
    }

    await batch.commit();
    console.log(`[checkOfflineDevices] ${devicesSnap.size} dispositivo(s) marcados offline.`);
  }
);
