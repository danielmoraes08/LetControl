/**
 * LetControl — Firmware ESP32
 * Sensor: YF-S201 (Caudalímetro)
 * Protocolo: HTTPS POST → Cloud Function ingestReading
 * 
 * Dependências (Arduino Library Manager):
 *   - ArduinoJson (v7)
 *   - HTTPClient (built-in ESP32)
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

// ─── CONFIGURAÇÕES ────────────────────────────────────────────────────────────
const char* WIFI_SSID         = "SUA_REDE_WIFI";
const char* WIFI_PASSWORD     = "SUA_SENHA_WIFI";

const char* DEVICE_ID         = "ESP32-A4F3C1";      // ID único do dispositivo
const char* DEVICE_SECRET     = "sk_letcontrol_a4f3c1_DEMO"; // token cadastrado no Firebase
const char* FUNCTION_ENDPOINT = "https://southamerica-east1-letcontrol-app.cloudfunctions.net/ingestReading";

// ─── PINOS ────────────────────────────────────────────────────────────────────
const int FLOW_SENSOR_PIN = 34;    // GPIO34 — sinal do YF-S201
const int VALVE_RELAY_PIN = 26;    // GPIO26 — relé da válvula solenoide
const int PRESSURE_ADC_PIN = 35;   // GPIO35 — sensor de pressão analógico
const int TEMP_ADC_PIN = 32;       // GPIO32 — sensor de temperatura NTC

// ─── CONSTANTES DO SENSOR ─────────────────────────────────────────────────────
const float PULSES_PER_LITER = 450.0; // YF-S201: ~450 pulsos = 1 litro
const int   SEND_INTERVAL_MS = 5000;  // Enviar ao Firebase a cada 5 segundos
const float PRESSURE_MAX_BAR = 6.0;   // Pressão máxima do sensor (bar)
const float TEMP_MIN_C       = -10.0; // Temperatura mínima do NTC
const float TEMP_MAX_C       = 85.0;  // Temperatura máxima do NTC

// ─── VARIÁVEIS GLOBAIS ────────────────────────────────────────────────────────
volatile uint32_t pulseCount  = 0;   // Contador de pulsos (interrupção)
uint32_t lastSendMs           = 0;   // Última vez que enviou dados
uint32_t sessionPulses        = 0;   // Pulsos acumulados na sessão
bool     valveOpen            = true;

// ─── INTERRUPÇÃO DO CAUDALÍMETRO ──────────────────────────────────────────────
void IRAM_ATTR onFlowPulse() {
  pulseCount++;
}

// ─── SETUP ───────────────────────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);
  Serial.println("\n[LetControl] Inicializando...");

  // Pinos
  pinMode(FLOW_SENSOR_PIN, INPUT_PULLUP);
  pinMode(VALVE_RELAY_PIN, OUTPUT);
  digitalWrite(VALVE_RELAY_PIN, HIGH); // válvula aberta por padrão

  // Habilitar interrupção no caudalímetro
  attachInterrupt(digitalPinToInterrupt(FLOW_SENSOR_PIN), onFlowPulse, FALLING);

  // Conectar ao Wi-Fi
  connectWiFi();
}

// ─── LOOP PRINCIPAL ───────────────────────────────────────────────────────────
void loop() {
  // Reconectar Wi-Fi se necessário
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WiFi] Reconectando...");
    connectWiFi();
  }

  uint32_t now = millis();

  if (now - lastSendMs >= SEND_INTERVAL_MS) {
    lastSendMs = now;

    // Capturar pulsos com interrupção desabilitada
    noInterrupts();
    uint32_t currentPulses = pulseCount;
    interrupts();

    // Calcular métricas
    uint32_t deltaPulses = currentPulses - sessionPulses;
    sessionPulses = currentPulses;

    float flowLpm       = calcFlowRate(deltaPulses);
    float volumeToday   = currentPulses / PULSES_PER_LITER;
    float pressureBar   = readPressure();
    float tempC         = readTemperature();
    int   batteryPct    = readBattery();
    int   rssi          = WiFi.RSSI();

    // Log serial
    Serial.printf("[Sensor] Flow: %.2f L/min | Vol: %.1f L | Pres: %.2f bar | Temp: %.1f°C | RSSI: %d\n",
      flowLpm, volumeToday, pressureBar, tempC, rssi);

    // Enviar ao Firebase
    sendReading(flowLpm, currentPulses, volumeToday, pressureBar, tempC, batteryPct, rssi);
  }
}

// ─── FUNÇÕES ─────────────────────────────────────────────────────────────────

void connectWiFi() {
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[WiFi] Conectando");
  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 30) {
    delay(500);
    Serial.print(".");
    attempts++;
  }
  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\n[WiFi] Conectado! IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\n[WiFi] Falha na conexão. Tentando novamente em 30s...");
    delay(30000);
  }
}

float calcFlowRate(uint32_t deltaPulses) {
  // YF-S201: frequência de pulso em Hz / 7.5 = L/min
  // A cada 5s: (pulsos / 5s) → Hz → L/min
  float hz = deltaPulses / (SEND_INTERVAL_MS / 1000.0);
  return hz / 7.5;
}

float readPressure() {
  // Sensor de pressão 0–6 bar conectado ao ADC (0–3.3V)
  int raw = analogRead(PRESSURE_ADC_PIN);
  float voltage = (raw / 4095.0) * 3.3;
  return (voltage / 3.3) * PRESSURE_MAX_BAR;
}

float readTemperature() {
  // NTC 10kΩ em divisor de tensão — cálculo simplificado
  int raw = analogRead(TEMP_ADC_PIN);
  float voltage = (raw / 4095.0) * 3.3;
  float resistance = (3.3 - voltage) > 0 ? (voltage * 10000) / (3.3 - voltage) : 10000;
  // Equação de Steinhart-Hart simplificada
  float logR = log(resistance / 10000.0);
  float tempK = 1.0 / (0.001129 + 0.000234 * logR + 0.0000000877 * logR * logR * logR);
  return tempK - 273.15;
}

int readBattery() {
  // Leitura da tensão do LiPo (3.3V–4.2V) via divisor de tensão
  // Ajuste os valores conforme seu circuito
  int raw = analogRead(34);
  float voltage = (raw / 4095.0) * 3.3 * 2; // fator 2 do divisor de tensão
  int pct = constrain((int)((voltage - 3.3) / (4.2 - 3.3) * 100), 0, 100);
  return pct;
}

void sendReading(float flowLpm, uint32_t pulses, float volumeL,
                 float pressureBar, float tempC, int batteryPct, int rssi) {
  if (WiFi.status() != WL_CONNECTED) return;

  // Montar JSON
  JsonDocument doc;
  doc["device_id"]   = DEVICE_ID;
  doc["flow_rate"]   = serialized(String(flowLpm, 2));
  doc["pulse_count"] = pulses;
  doc["pressure"]    = serialized(String(pressureBar, 2));
  doc["temperature"] = serialized(String(tempC, 1));
  doc["valve_open"]  = valveOpen;
  doc["battery_pct"] = batteryPct;
  doc["wifi_rssi"]   = rssi;
  doc["uptime_s"]    = millis() / 1000;
  doc["ts"]          = millis(); // timestamp relativo (backend usa server time)

  String payload;
  serializeJson(doc, payload);

  // Fazer POST
  HTTPClient http;
  http.begin(FUNCTION_ENDPOINT);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-secret", DEVICE_SECRET);

  int httpCode = http.POST(payload);

  if (httpCode == 201) {
    Serial.println("[HTTP] ✅ Leitura enviada com sucesso");
  } else {
    Serial.printf("[HTTP] ❌ Erro %d: %s\n", httpCode, http.getString().c_str());
  }

  http.end();

  // Verificar comando de válvula pendente (polling simples)
  // Em produção: usar Firebase Realtime DB ou MQTT para push
  checkValveCommand();
}

void checkValveCommand() {
  // Polling simples: GET /valveCommand?device_id=...
  // Alternativa recomendada: MQTT subscribe ao tópico letcontrol/{device_id}/valve
  // Implementação via MQTT (PubSubClient) aumenta responsividade
  //
  // Exemplo de tópico: letcontrol/ESP32-A4F3C1/valve
  //   Payload: "OPEN" ou "CLOSE"
  //
  // if (command == "CLOSE") {
  //   valveOpen = false;
  //   digitalWrite(VALVE_RELAY_PIN, LOW);
  // } else if (command == "OPEN") {
  //   valveOpen = true;
  //   digitalWrite(VALVE_RELAY_PIN, HIGH);
  // }
}
