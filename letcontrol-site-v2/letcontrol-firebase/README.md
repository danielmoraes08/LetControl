# LetControl — Firebase Backend

Estrutura completa do backend Firebase para o sistema de monitoramento de água via ESP32.

---

## 📁 Estrutura de Arquivos

```
letcontrol-firebase/
│
├── firebase.json              # Configuração do projeto Firebase
├── firestore.rules            # Regras de segurança do Firestore
├── firestore.indexes.json     # Índices compostos (performance)
├── seed.js                    # Popula o banco com dados de exemplo
├── letcontrol-sdk.js          # SDK para o app mobile (React Native / Web)
├── esp32-firmware.ino         # Código do sensor ESP32 (Arduino)
│
└── functions/
    ├── package.json
    └── src/
        └── index.js           # Cloud Functions
```

---

## 🗂 Coleções Firestore

| Coleção         | Descrição                              | Frequência        |
|-----------------|----------------------------------------|-------------------|
| `users`         | Dados dos usuários                     | Raramente         |
| `devices`       | Cadastro e status dos ESP32            | A cada 30s        |
| `readings`      | Leituras do sensor (principal)         | A cada **5s**     |
| `alerts`        | Alertas gerados automaticamente        | Por evento        |
| `goals`         | Metas de consumo do usuário            | Manual            |
| `daily_reports` | Relatório consolidado diário           | 1x/dia (00:05)    |

---

## ⚡ Cloud Functions

| Função                 | Trigger          | Descrição                                  |
|------------------------|------------------|--------------------------------------------|
| `ingestReading`        | HTTP POST        | Recebe leitura do ESP32 e salva no banco   |
| `analyzeReading`       | Firestore trigger| Detecta anomalias e gera alertas           |
| `generateDailyReport`  | Cron 00:05 BRT   | Consolida o relatório diário               |
| `checkOfflineDevices`  | Cron a cada 15min| Detecta sensores sem comunicação           |

---

## 🚀 Como configurar

### 1. Criar projeto Firebase

```bash
# Instalar Firebase CLI
npm install -g firebase-tools

# Login
firebase login

# Criar projeto (ou usar existente)
firebase projects:create letcontrol-app

# Associar ao projeto
firebase use letcontrol-app
```

### 2. Habilitar serviços no Console Firebase

- **Firestore** → Criar banco em modo produção → Região: `southamerica-east1`
- **Authentication** → Habilitar Email/Password e Google
- **Functions** → Habilitar (requer plano Blaze)

### 3. Deploy das regras e índices

```bash
firebase deploy --only firestore:rules,firestore:indexes
```

### 4. Deploy das Cloud Functions

```bash
cd functions
npm install
cd ..
firebase deploy --only functions
```

### 5. Popular banco com dados de exemplo

```bash
# Gerar chave de serviço no Console Firebase
# IAM → Service Accounts → Generate new private key → salvar como serviceAccountKey.json

# Habilitar a linha no seed.js:
# credential: admin.credential.cert(require("./serviceAccountKey.json"))

node seed.js
```

### 6. Emulador local (desenvolvimento)

```bash
firebase emulators:start

# Interface em: http://localhost:4000
# Firestore em: http://localhost:8080
# Functions em: http://localhost:5001
```

---

## 📡 Integração ESP32

### Endpoint de ingestão

```
POST https://southamerica-east1-letcontrol-app.cloudfunctions.net/ingestReading

Headers:
  Content-Type: application/json
  x-device-secret: <token_do_device>

Body:
{
  "device_id":   "ESP32-A4F3C1",
  "flow_rate":   8.42,
  "pulse_count": 1263,
  "pressure":    2.31,
  "temperature": 24.7,
  "valve_open":  true,
  "battery_pct": 88,
  "wifi_rssi":   -62,
  "uptime_s":    86400
}
```

### Cadastrar novo dispositivo (via Admin SDK ou Console)

```js
// No Firestore Console ou via script:
db.collection("devices").doc("ESP32-XXXXXX").set({
  user_id: "uid_do_usuario",
  name: "Caixa d'água — Casa",
  firmware_version: "v2.3.1",
  sensor_model: "YF-S201",
  api_secret: "sk_letcontrol_XXXX_gerado_aleatoriamente",
  status: "offline",
  calibration: { pulses_per_liter: 450, offset_lpm: 0.05 }
});
```

---

## 📱 Uso do SDK no App

```js
import * as LC from './letcontrol-sdk';

// Dashboard em tempo real
const stopListening = LC.initDashboard(userId, deviceId, ({ reading, alerts }) => {
  console.log('Vazão atual:', reading.flow_rate_lpm, 'L/min');
  console.log('Alertas não lidos:', alerts.length);
});

// Parar ao desmontar o componente
onUnmount(() => stopListening());

// Definir meta diária
await LC.setDailyGoal(userId, deviceId, 175, 80); // 175L, alerta em 80%

// Controlar válvula
await LC.setValve(deviceId, false); // fechar válvula

// Relatório dos últimos 30 dias
const reports = await LC.getRecentReports(userId, deviceId, 30);
```

---

## 🔒 Segurança

- Leituras só podem ser escritas pelo **backend** (service account), nunca pelo app
- Cada usuário acessa **apenas seus próprios dados**
- O `api_secret` do ESP32 é validado na Cloud Function antes de qualquer gravação
- TTL de 90 dias nas `readings` para controlar custo de armazenamento

---

## 💾 Estimativa de dados

| Coleção       | Tamanho/doc | Docs/dia     | GB/mês        |
|---------------|-------------|--------------|---------------|
| `readings`    | ~350 bytes  | 17.280       | ~175 MB       |
| `daily_reports`| ~1 KB      | 1            | < 1 MB        |
| `alerts`      | ~500 bytes  | 0–5          | < 1 MB        |

> Com TTL de 90 dias nas `readings`, o banco fica estável em ~**15–16 GB** por device.
> No plano Blaze do Firebase, os primeiros 1 GB de storage são gratuitos.
