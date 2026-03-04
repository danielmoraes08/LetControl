/**
 * letcontrol-sdk.js
 * Funções prontas para usar no app mobile (React Native / Web)
 * Importar: import * as LC from './letcontrol-sdk';
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  updateDoc,
  addDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "./firebase-config"; // sua instância do Firestore

// ─────────────────────────────────────────────────────────────────────────────
// DEVICES
// ─────────────────────────────────────────────────────────────────────────────

/** Busca todos os devices de um usuário */
export async function getUserDevices(userId) {
  const q = query(
    collection(db, "devices"),
    where("user_id", "==", userId)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Escuta o status em tempo real de um device */
export function watchDevice(deviceId, onChange) {
  return onSnapshot(doc(db, "devices", deviceId), snap => {
    if (snap.exists()) onChange({ id: snap.id, ...snap.data() });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// READINGS — Tempo Real
// ─────────────────────────────────────────────────────────────────────────────

/** Escuta a leitura mais recente do sensor em tempo real (dashboard) */
export function watchLatestReading(deviceId, onReading) {
  const q = query(
    collection(db, "readings"),
    where("device_id", "==", deviceId),
    orderBy("timestamp", "desc"),
    limit(1)
  );
  return onSnapshot(q, snap => {
    if (!snap.empty) {
      const d = snap.docs[0];
      onReading({ id: d.id, ...d.data() });
    }
  });
}

/** Busca leituras das últimas N horas para gráfico */
export async function getReadingsLastHours(deviceId, hours = 24) {
  const since = new Date();
  since.setHours(since.getHours() - hours);

  const q = query(
    collection(db, "readings"),
    where("device_id", "==", deviceId),
    where("timestamp", ">=", Timestamp.fromDate(since)),
    orderBy("timestamp", "asc")
  );

  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Busca leituras de um dia específico */
export async function getReadingsByDate(deviceId, dateBucket) {
  const q = query(
    collection(db, "readings"),
    where("device_id", "==", deviceId),
    where("date_bucket", "==", dateBucket),
    orderBy("timestamp", "asc")
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ─────────────────────────────────────────────────────────────────────────────
// ALERTS
// ─────────────────────────────────────────────────────────────────────────────

/** Escuta alertas não lidos em tempo real */
export function watchUnreadAlerts(userId, onAlerts) {
  const q = query(
    collection(db, "alerts"),
    where("user_id", "==", userId),
    where("read", "==", false),
    orderBy("created_at", "desc"),
    limit(20)
  );
  return onSnapshot(q, snap => {
    onAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
}

/** Busca todo o histórico de alertas */
export async function getAlertHistory(userId, limitCount = 50) {
  const q = query(
    collection(db, "alerts"),
    where("user_id", "==", userId),
    orderBy("created_at", "desc"),
    limit(limitCount)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Marca alerta como lido */
export async function markAlertRead(alertId) {
  await updateDoc(doc(db, "alerts", alertId), { read: true });
}

/** Marca alerta como resolvido */
export async function resolveAlert(alertId) {
  await updateDoc(doc(db, "alerts", alertId), {
    resolved: true,
    read: true,
    resolved_at: Timestamp.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// GOALS
// ─────────────────────────────────────────────────────────────────────────────

/** Busca a meta ativa do usuário */
export async function getActiveGoal(userId, deviceId, period = "daily") {
  const q = query(
    collection(db, "goals"),
    where("user_id", "==", userId),
    where("device_id", "==", deviceId),
    where("active", "==", true),
    where("period", "==", period),
    limit(1)
  );
  const snap = await getDocs(q);
  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

/** Cria ou atualiza a meta diária */
export async function setDailyGoal(userId, deviceId, limitLiters, alertAtPct = 80) {
  // Desativar meta anterior
  const existing = await getActiveGoal(userId, deviceId, "daily");
  if (existing) {
    await updateDoc(doc(db, "goals", existing.id), { active: false });
  }

  // Criar nova meta
  return addDoc(collection(db, "goals"), {
    user_id: userId,
    device_id: deviceId,
    period: "daily",
    limit_liters: limitLiters,
    alert_at_pct: alertAtPct,
    active: true,
    created_at: Timestamp.now(),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DAILY REPORTS
// ─────────────────────────────────────────────────────────────────────────────

/** Busca relatórios dos últimos N dias */
export async function getRecentReports(userId, deviceId, days = 30) {
  const q = query(
    collection(db, "daily_reports"),
    where("user_id", "==", userId),
    where("device_id", "==", deviceId),
    orderBy("date", "desc"),
    limit(days)
  );
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** Busca relatório de um dia específico */
export async function getReportByDate(userId, deviceId, dateBucket) {
  const reportId = `${userId}_${deviceId}_${dateBucket}`;
  const snap = await getDoc(doc(db, "daily_reports", reportId));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD — Agregado para a tela principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Retorna todos os dados necessários para o dashboard principal
 * de forma otimizada (1 listener + 1 query paralela)
 */
export function initDashboard(userId, deviceId, onUpdate) {
  let latestReading = null;
  let unreadAlerts = [];

  const unsubReading = watchLatestReading(deviceId, reading => {
    latestReading = reading;
    onUpdate({ reading: latestReading, alerts: unreadAlerts });
  });

  const unsubAlerts = watchUnreadAlerts(userId, alerts => {
    unreadAlerts = alerts;
    onUpdate({ reading: latestReading, alerts: unreadAlerts });
  });

  // Retorna função para parar os listeners
  return () => {
    unsubReading();
    unsubAlerts();
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTROLE DA VÁLVULA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Envia comando para abrir/fechar a válvula
 * O ESP32 monitora este campo via MQTT e executa o comando
 */
export async function setValve(deviceId, open) {
  await updateDoc(doc(db, "devices", deviceId), {
    valve_command: open ? "OPEN" : "CLOSE",
    valve_command_at: Timestamp.now(),
  });
}
