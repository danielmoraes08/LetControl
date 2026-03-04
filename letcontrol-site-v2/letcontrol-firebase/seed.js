/**
 * seed.js — Popula o Firestore com dados iniciais de exemplo
 * 
 * Uso:
 *   node seed.js
 * 
 * Requer: GOOGLE_APPLICATION_CREDENTIALS apontando para serviceAccountKey.json
 * Ou: firebase emulators:start + FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
 */

const admin = require("firebase-admin");

// ── Para emulador local, descomente:
// process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";

admin.initializeApp({
  credential: admin.credential.cert(require("./serviceAccountKey.json")),
  projectId: "letcontrol-app",
});

const db = admin.firestore();

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const ts = (offsetMinutes = 0) => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - offsetMinutes);
  return admin.firestore.Timestamp.fromDate(d);
};

const randomFloat = (min, max, decimals = 2) =>
  parseFloat((Math.random() * (max - min) + min).toFixed(decimals));

const dateBucket = () => new Date().toISOString().split("T")[0];

// ─── DADOS INICIAIS ───────────────────────────────────────────────────────────
async function seed() {
  console.log("🌱 Iniciando seed do LetControl...\n");

  const userId = "usr_demo_joao";
  const deviceId = "ESP32-A4F3C1";

  // ── 1. USUÁRIO ──────────────────────────────────────────────────────────────
  await db.collection("users").doc(userId).set({
    name: "João Silva",
    email: "joao@letcontrol.com",
    phone: "+55 11 99999-0000",
    address: {
      street: "Rua das Flores, 123",
      city: "São Paulo",
      state: "SP",
      zip: "01310-100",
    },
    notification_prefs: {
      push: true,
      sms: false,
      email: true,
      quiet_hours: { start: "22:00", end: "07:00" },
    },
    plan: "pro",
    created_at: ts(43200), // 30 dias atrás
  });
  console.log("✅ Usuário criado:", userId);

  // ── 2. DEVICE (ESP32) ───────────────────────────────────────────────────────
  await db.collection("devices").doc(deviceId).set({
    user_id: userId,
    name: "Caixa d'água — Casa",
    firmware_version: "v2.3.1",
    hardware_version: "ESP32-WROOM-32",
    sensor_model: "YF-S201",
    installation_date: ts(43200),
    status: "online",
    last_seen: ts(1),
    battery_pct: 88,
    wifi_ssid: "Casa-WiFi-5G",
    wifi_rssi: -62,
    api_secret: "sk_letcontrol_a4f3c1_DEMO", // em produção: gerado aleatoriamente
    calibration: {
      pulses_per_liter: 450,
      offset_lpm: 0.05,
      last_calibrated: ts(43200),
    },
    location: {
      lat: -23.561,
      lng: -46.655,
    },
  });
  console.log("✅ Device criado:", deviceId);

  // ── 3. META DIÁRIA ──────────────────────────────────────────────────────────
  const goalRef = await db.collection("goals").add({
    user_id: userId,
    device_id: deviceId,
    period: "daily",
    limit_liters: 175,
    alert_at_pct: 80,
    active: true,
    created_at: ts(43200),
  });
  console.log("✅ Meta diária criada:", goalRef.id);

  // ── 4. LEITURAS (simulando as últimas 2 horas) ──────────────────────────────
  console.log("⏳ Criando leituras simuladas...");

  const batch = db.batch();
  let pulseCount = 0;
  const readingsCount = 72; // 72 leituras = 6 min (a cada 5s)

  for (let i = readingsCount; i >= 0; i--) {
    const flowRate = randomFloat(3, 12); // L/min
    const litersPerInterval = flowRate * (5 / 60); // litros em 5 segundos
    pulseCount += Math.round(litersPerInterval * 450); // 450 pulsos/litro
    const volumeToday = pulseCount / 450;

    const readingRef = db.collection("readings").doc();
    batch.set(readingRef, {
      device_id: deviceId,
      user_id: userId,
      flow_rate_lpm: flowRate,
      volume_accumulated_l: parseFloat(volumeToday.toFixed(2)),
      pulse_count: pulseCount,
      pressure_bar: randomFloat(1.8, 2.8),
      temperature_c: randomFloat(23, 26, 1),
      valve_open: true,
      anomaly_detected: false,
      wifi_rssi: randomFloat(-70, -55, 0),
      battery_pct: 88,
      timestamp: ts(i * 0.0833), // a cada 5 segundos
      date_bucket: dateBucket(),
    });
  }

  await batch.commit();
  console.log(`✅ ${readingsCount + 1} leituras criadas`);

  // ── 5. ALERTAS ──────────────────────────────────────────────────────────────
  const todayBucket = dateBucket();

  const alerts = [
    {
      type: "GOAL_EXCEEDED",
      severity: "medium",
      message: "80% da meta diária atingida (140L / 175L)",
      flow_at_alert: 7.2,
      extra: { used_liters: 140, limit_liters: 175, pct: 80 },
      read: true,
      resolved: true,
      resolved_at: ts(180),
      created_at: ts(240),
    },
    {
      type: "LEAK_DETECTED",
      severity: "high",
      message: "Possível vazamento: fluxo de 2.1 L/min por mais de 30 min na madrugada",
      flow_at_alert: 2.1,
      duration_minutes: 38,
      extra: {},
      read: false,
      resolved: false,
      created_at: ts(60),
    },
    {
      type: "ABNORMAL_FLOW",
      severity: "high",
      message: "Vazão anormal: 18.4 L/min (média: 5.1 L/min)",
      flow_at_alert: 18.4,
      extra: { avg_lpm: 5.1, multiplier: 3 },
      read: false,
      resolved: false,
      created_at: ts(30),
    },
  ];

  const alertBatch = db.batch();
  for (const alert of alerts) {
    const alertRef = db.collection("alerts").doc();
    alertBatch.set(alertRef, {
      ...alert,
      user_id: userId,
      device_id: deviceId,
      date_bucket: todayBucket,
      reading_id: null,
    });
  }
  await alertBatch.commit();
  console.log(`✅ ${alerts.length} alertas criados`);

  // ── 6. RELATÓRIO DIÁRIO (ontem) ─────────────────────────────────────────────
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayBucket = yesterday.toISOString().split("T")[0];

  await db
    .collection("daily_reports")
    .doc(`${userId}_${deviceId}_${yesterdayBucket}`)
    .set({
      user_id: userId,
      device_id: deviceId,
      date: yesterdayBucket,
      total_volume_l: 148.3,
      peak_flow_lpm: 14.2,
      avg_flow_lpm: 5.8,
      usage_periods: [
        { hour: 7, volume_l: 38.2 },
        { hour: 20, volume_l: 41.5 },
        { hour: 12, volume_l: 22.1 },
        { hour: 6, volume_l: 18.4 },
        { hour: 21, volume_l: 15.6 },
      ],
      goal_limit_l: 175,
      goal_pct_used: 84.7,
      goal_met: true,
      vs_prev_day_pct: -12.4,
      avg_wifi_rssi: -64,
      readings_count: 17104,
      uptime_pct: 99.1,
      alerts_count: 1,
      anomalies_detected: false,
      generated_at: ts(1440), // gerado ontem à meia-noite
    });

  console.log("✅ Relatório diário criado para:", yesterdayBucket);
  console.log("\n🎉 Seed concluído com sucesso!");
  console.log("\n📋 Resumo:");
  console.log(`   👤 User ID   : ${userId}`);
  console.log(`   🔩 Device ID : ${deviceId}`);
  console.log(`   🎯 Goal      : 175L/dia (alerta em 80%)`);
  console.log(`   📈 Readings  : ${readingsCount + 1} leituras`);
  console.log(`   🚨 Alerts   : ${alerts.length} alertas`);
  console.log(`   📊 Reports   : 1 relatório (${yesterdayBucket})`);

  process.exit(0);
}

seed().catch(err => {
  console.error("❌ Erro no seed:", err);
  process.exit(1);
});
