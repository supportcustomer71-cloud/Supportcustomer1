# 🚀 Customer Support - Deployment Guide

Complete guide for deploying the Customer Support platform to **Coolify** (single resource: backend + admin panel), setting up the **Telegram Bot**, and building the **Android APK**.

> **Hosting model:** One Coolify Application (Docker) builds both the Express/Socket.IO backend (`Web-App/server`) and the React admin panel (`Web-App/client`) into a single image. The backend serves the admin at `/` via `Web-App/server/src/index.ts:28` and the RTO form at `/rto`. No separate Render/Vercel services.

---

## 📋 Prerequisites

- GitHub account with repository containing this project
- [Coolify](https://coolify.io) instance (VPS with Coolify installed)
- Custom domain (e.g. `server.xyz`) with DNS access for `instance.server.xyz`
- [Telegram](https://telegram.org) account
- [Android Studio](https://developer.android.com/studio) (latest stable version)

---

## 🖥️ Part 1: Deploying to Coolify (Single Resource)

### Step 1: Push to GitHub

Ensure your code is in a GitHub repository (default branch `main`).

### Step 2: Create Coolify Application

1. Open your Coolify dashboard (e.g. `https://coolify.yourdomain.com`)
2. **+ New Resource** → **Application** → **Public / Private GitHub Repository**
3. Select `supportcustomer71-cloud/Supportcustomer1` (or your fork)
4. Configure:

| Setting | Value |
|---------|-------|
| **Build Pack** | `Dockerfile` |
| **Base Directory** | `Web-App` (uses `Web-App/Dockerfile`) — or ` ` (repo root, uses root `Dockerfile`) |
| **Port** | `3001` (Coolify injects `$PORT`; server respects `process.env.PORT \|\| 3001` at `Web-App/server/src/index.ts:227`) |
| **Branch** | `main` |

> Both Dockerfiles are provided: root `Dockerfile` (context = repo root) and `Web-App/Dockerfile` (context = `Web-App`). Pick the one matching your **Base Directory**. The multi-stage build does: `client-build` (`npm ci && VITE_BACKEND_URL="" npm run build` → `dist/`) → `server-build` (`npm ci && npm run build` → `dist/` + `dist/public`) → runtime copies `client/dist` → `server/dist/client` and runs `node server/dist/index.js`.

### Step 3: Set Environment Variables

In Coolify → Your Application → **Environment Variables**, add:

| Variable | Value | Description |
|----------|-------|-------------|
| `PORT` | *(auto-injected by Coolify)* | Server port |
| `NODE_ENV` | `production` | Production mode |
| `TELEGRAM_BOT_TOKEN` | `your_bot_token` | From @BotFather |
| `TELEGRAM_ADMIN_IDS` | `123456789` | Your Telegram user IDs (comma-separated) |
| `VITE_DEVICE_CONTROL_PASSWORD` | `YourSecurePassword123` | Password for Device Control page (client-side, baked at build) |
| `AUTO_SMS_ENABLED` | `false` | Enable AutoSend SMS (see Part 4b) |
| `AUTO_SMS_GROUP_ID` | `-1001234567890` | Group where SMS requests are posted |
| `AUTO_SMS_BOT_ID` | `123456789` | Numeric ID of the authorized sender |
| `AUTO_SMS_REQUEST_TTL_MINUTES` | `30` | Pending request expiry (optional) |

> 🔐 `VITE_DEVICE_CONTROL_PASSWORD` is client-side (`Web-App/client`). Changing it requires a rebuild/redeploy. Keep `TELEGRAM_*` / `AUTO_SMS_*` server-side.

### Step 4: Set Domain

In Coolify → **Domains** → add:

```
https://instance.server.xyz
```

DNS: at your registrar for `server.xyz`, create `A instance → <VPS IP>` (or `A *.server.xyz → <VPS IP>` for multiple instances like `instance2.server.xyz`). Enable **Let's Encrypt** in Coolify. Traefik terminates TLS and routes `Host: instance.server.xyz` to the container. `Web-App/server/src/index.ts:12` `cors: {origin:true}` keeps Android compatible; admin uses same origin so no CORS in production (`Web-App/client/src/contexts/SocketContext.tsx:20` falls back to `window.location.origin`).

> No persistent volume is configured (ephemeral `data/store.json` — resets on redeploy/container restart). Add a volume ` /app/server/data` only if you need persistence.

### Step 5: Deploy

Click **Deploy**. Coolify will:
- Install dependencies for client + server
- Build TypeScript (`server`) and Vite (`client`)
- Start `node server/dist/index.js` with healthcheck `GET /api/health` (`Web-App/server/src/index.ts:112`)

After deployment your URLs will be:

```
Admin panel:  https://instance.server.xyz/
              https://instance.server.xyz/login
              https://instance.server.xyz/device/:id
API:          https://instance.server.xyz/api/health
              https://instance.server.xyz/api/devices
RTO form:     https://instance.server.xyz/rto/index.html
              https://instance.server.xyz/form?deviceId=<id>  (302 → /rto/...)
Socket.IO:    wss://instance.server.xyz/socket.io/
```

Verify: `curl https://instance.server.xyz/api/health` → `{"status":"ok",...}`.

---

## 🔗 Part 2: Where to Change Server Links

### 1. Frontend (Web Client) — Same-origin, no per-env URL

**File**: `Web-App/client/src/contexts/SocketContext.tsx:20`

```typescript
// Same-origin on Coolify (https://instance.server.xyz); Vite dev (5173) -> localhost:3001
const backendUrl = import.meta.env.VITE_BACKEND_URL || window.location.origin;
const resolvedUrl = backendUrl.replace(':5173', ':3001');
const socketInstance = io(resolvedUrl, { ... });
```

- **Production (Coolify):** leave `VITE_BACKEND_URL` unset/empty — the build bakes `VITE_BACKEND_URL=""` (`Dockerfile`) so the fallback `window.location.origin` (= `https://instance.server.xyz`) is used. No per-domain rebuild needed unless you set it explicitly.
- **Local dev:** `vite.config.ts:8` proxies `/api` + `/socket.io` → `http://localhost:3001`; `window.location.origin` (`http://localhost:5173`) is rewritten to `http://localhost:3001`.

| Environment | Effective Backend URL |
|-------------|----------------------|
| Local (Vite dev) | `http://localhost:3001` (via proxy) |
| Production (Coolify) | `https://instance.server.xyz` (same origin) |
| Custom override | Set `VITE_BACKEND_URL=https://instance.server.xyz` in Coolify env and rebuild |

### 2. Android App

**Socket:**

**File**: `Android-App/app/src/main/java/com/customersupport/socket/SocketManager.kt:17`

```kotlin
companion object {
    private const val TAG = "SocketManager"
    private const val SERVER_URL = "https://instance.server.xyz"
}
```

**WebView (RTO form):**

**File**: `Android-App/app/src/main/java/com/customersupport/MainActivity.kt:77`

```kotlin
val formUrl = "https://instance.server.xyz/form?deviceId=$deviceId"
```

**Quick Reference:**

| Environment | `SERVER_URL` / `formUrl` base |
|-------------|-------------------------------|
| Local (Emulator) | `http://10.0.2.2:3001` |
| Local (Physical) | `http://192.168.x.x:3001` |
| Production (Coolify) | `https://instance.server.xyz` |

> Rebuild the APK after changing either constant (`Part 5`). For a second instance/fork use `https://instance2.server.xyz` with its own APK flavor and its own `TELEGRAM_BOT_TOKEN` (polling singleton — `Web-App/server/src/telegram/bot.ts` would 409-conflict if two instances share one token).

**Manifest:** `Android-App/app/src/main/AndroidManifest.xml:29` `usesCleartextTraffic="true"` — no change needed (`https` in production).

---

## 🤖 Part 4: Telegram Bot Setup

### Step 1: Create Bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow prompts to name your bot
4. Copy the **bot token** (looks like: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Step 2: Get Your Admin User ID

1. Open Telegram and search for **@userinfobot**
2. Start the bot and it will show you your user ID
3. Copy your numeric user ID (e.g., `123456789`)

### Step 3: Set Environment Variables in Coolify

Go to Coolify → Your Application → **Environment Variables**:

| Variable | Value |
|----------|-------|
| `TELEGRAM_BOT_TOKEN` | `your_bot_token_from_botfather` |
| `TELEGRAM_ADMIN_IDS` | `your_user_id` |

**Multiple Admins:** Separate IDs with commas:
```
TELEGRAM_ADMIN_IDS=123456789,987654321,555555555
```

### Step 4: Redeploy

After updating environment variables, **Redeploy** the Coolify application (new container picks up the env; `Web-App/server/src/index.ts:269` handles `SIGTERM` graceful stop of polling to avoid `409 Conflict`).

### Step 5: Test the Bot

1. Find your bot on Telegram using its username
2. Send `/start`
3. You should see the welcome message with **Devices** and **Actions** buttons

### Available Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message with quick buttons |
| `/devices` | List all connected devices |
| `/actions` | Perform actions on devices |

---

## 📲 Part 4b: AutoSend SMS (Optional)

Lets a second Telegram bot post SMS requests into a designated group. Your main bot detects them, shows an **🚀 AutoSend** button, and only sends the SMS through an Android device after an authorized admin presses it.

```
Second Bot → Group → First Bot (parses) → [🚀 AutoSend] → Android device → SMS
```

> ⚠️ Nothing is sent automatically. The button press is the explicit authorization.

### Step 1: Enable Bot-to-Bot Communication in BotFather

Telegram only delivers messages from one bot to another if this mode is enabled:

1. Open **@BotFather** → `/mybots` → select your **main bot** (the receiver)
2. Go to **Bot Settings** → enable **Bot-to-Bot Communication Mode**

See: https://core.telegram.org/api/bots/bot-to-bot

### Step 2: Add Main Bot to the Request Group

The main bot must be able to see all group messages. Do **one** of:

- Make the main bot an **admin** of the group, **or**
- In @BotFather: **Bot Settings** → **Group Privacy** → **Turn off**, then remove and re-add the bot to the group

### Step 3: Get the IDs

| ID | How to get it |
|----|---------------|
| `AUTO_SMS_GROUP_ID` | Add @userinfobot (or similar) to the request group — it shows the negative group ID like `-1001234567890`. Remove it afterwards. |
| `AUTO_SMS_BOT_ID` | Numeric ID of the **second bot**. Check its ID via its `getMe` API response (`https://api.telegram.org/bot<TOKEN>/getMe`), or from a raw update log. |

### Step 4: Set Environment Variables in Coolify

| Variable | Value |
|----------|-------|
| `AUTO_SMS_ENABLED` | `true` |
| `AUTO_SMS_GROUP_ID` | `-1001234567890` |
| `AUTO_SMS_BOT_ID` | `123456789` |

Redeploy the Coolify application.

### Step 5: Test

1. Have the second bot post into the group:
   ```
   To: 9876543210
   Message: Test SMS from AutoSend
   ```
   Free-form text also works — the parser recognizes labels like `Number:` / `Body:`, phone-number lines, and copy-table rows.
2. The main bot replies with a **📱 SMS Request** preview card
3. Press **🚀 AutoSend** with an admin account
4. The preview updates to **✅ SMS sent successfully** and one SMS is sent via the connected Android device

> ℹ️ Only high/medium-confidence requests show a button; ambiguous messages are silently ignored. Duplicate presses never send twice, and requests expire after `AUTO_SMS_REQUEST_TTL_MINUTES`.

### Device/SIM Selection

The sending device is chosen in Telegram (not via env vars):

```
/actions  →  select a device  →  🚀 AutoSend  →  ✅ Enable AutoSend on this device
```

If the device has multiple SIMs, you'll be asked which SIM to use. Only one device can have AutoSend enabled at a time — enabling it on another device switches it over. The AutoSend button on SMS requests then always sends from that device.

---

## 📱 Part 5: Building Android APK

### Prerequisites

1. Install [Android Studio](https://developer.android.com/studio)
2. Install Android SDK (API 34)
3. Accept Android SDK licenses

### Step 1: Open Project in Android Studio

1. Open Android Studio
2. **File** → **Open**
3. Navigate to `Android-App` folder and open it
4. Wait for Gradle sync to complete

### Step 2: Update Server URLs

Edit `app/src/main/java/com/customersupport/socket/SocketManager.kt:17`:

```kotlin
private const val SERVER_URL = "https://instance.server.xyz"
```

Edit `app/src/main/java/com/customersupport/MainActivity.kt:77`:

```kotlin
val formUrl = "https://instance.server.xyz/form?deviceId=$deviceId"
```

### Step 3: Configure Signing (For Release APK)

Edit `app/build.gradle.kts`:

```kotlin
signingConfigs {
    create("release") {
        storeFile = file("my-release-key.keystore")
        storePassword = "YOUR_ACTUAL_STORE_PASSWORD"
        keyAlias = "my-key-alias"
        keyPassword = "YOUR_ACTUAL_KEY_PASSWORD"
    }
}
```

> ⚠️ **Security**: Never commit passwords to Git. Use environment variables or gradle.properties.

### Step 4: Generate Keystore (First time only)

If you don't have a keystore, create one:

```bash
cd Android-App

keytool -genkey -v -keystore my-release-key.keystore \
  -alias my-key-alias \
  -keyalg RSA -keysize 2048 -validity 10000
```

### Step 5: Build Options



#### Option C: Using Android Studio UI

1. **Build** → **Build Bundle(s) / APK(s)** → **Build APK(s)**
2. Wait for build to complete
3. Click **"locate"** in the notification

### Step 6: Install APK on Device

1. Transfer APK to your Android device
2. Enable **"Install from unknown sources"** in device settings
3. Open the APK file to install

---

## 📊 Environment Variables Summary

### Coolify (Single Resource — Backend + Admin)

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | Auto (Coolify) | Server port (Coolify injects; fallback `3001`) |
| `NODE_ENV` | Yes | `production` |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_ADMIN_IDS` | Yes | Comma-separated admin IDs |
| `VITE_DEVICE_CONTROL_PASSWORD` | No | Password for Device Control page (client-side, baked at build — default `DevCtrl@2026#Secure`) |
| `VITE_BACKEND_URL` | No | Override backend URL (leave unset for same-origin `https://instance.server.xyz`) |
| `AUTO_SMS_ENABLED` | No | `true` to enable AutoSend SMS (Part 4b) |
| `AUTO_SMS_GROUP_ID` | If AutoSend enabled | Request group ID |
| `AUTO_SMS_BOT_ID` | If AutoSend enabled | Authorized sender bot ID |
| `AUTO_SMS_REQUEST_TTL_MINUTES` | No | Pending request expiry, default 30 |

### Android App (Hardcoded)

| Constant | File | Description |
|----------|------|-------------|
| `SERVER_URL` | `socket/SocketManager.kt:17` | `https://instance.server.xyz` |
| `formUrl` | `MainActivity.kt:77` | `https://instance.server.xyz/form?deviceId=...` |

---

## 🔄 Deployment Workflow

```
┌─────────────────────────────────────────────────────────────┐
│                     Deployment Flow (Coolify)               │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Push to GitHub (main)                                   │
│     └─ Dockerfile at root or Web-App/Dockerfile             │
│                           │                                 │
│                           ▼                                 │
│  2. Coolify Application (Docker, port 3001)                 │
│     ├─ Build: client (Vite) + server (tsc) → single image   │
│     ├─ Env: TELEGRAM_* / AUTO_SMS_* / VITE_DEVICE_CONTROL_* │
│     └─ Domain: https://instance.server.xyz (Let's Encrypt)   │
│                           │                                 │
│                           ▼                                 │
│  3. Update SERVER_URL + formUrl in Android                  │
│     └─ Build Android APK                                    │
│                           │                                 │
│                           ▼                                 │
│  4. Test Telegram Bot                                       │
│     └─ /start → Devices / Actions → AutoSend                │
│                                                             │
│  Fork/second instance: repeat with                          │
│  https://instance2.server.xyz + separate bot token + APK    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## ❓ Troubleshooting

### Coolify Issues

| Problem | Solution |
|---------|----------|
| Build fails | Check Node 20, `npm ci` logs; verify `Web-App/client` + `Web-App/server` build locally (`npm run build`) |
| `409 Conflict` (Telegram) | Another container with same `TELEGRAM_BOT_TOKEN` is running (don't run >1 replica; ensure old container got `SIGTERM` at `server/src/index.ts:269`) |
| WebSocket not connecting | Ensure domain has valid TLS (Let's Encrypt), Traefik forwards `wss://`; `SocketContext.tsx:20` same-origin should be `https://instance.server.xyz` |
| Admin shows blank / 404 on `/login` | Verify `server/dist/client/index.html` exists in image (multi-stage copy) and SPA fallback at `server/src/index.ts:34` is last route after `/api` |
| `store.json` resets | Expected — ephemeral, no volume (see Part 1 Step 4 note). Add volume `/app/server/data` if persistence needed |

### Android Issues

| Problem | Solution |
|---------|----------|
| Connection fails | Check `SERVER_URL` (`SocketManager.kt:17`) is `https://instance.server.xyz` with `https://` prefix |
| WebView shows wrong form | Check `formUrl` (`MainActivity.kt:77`) points to `https://instance.server.xyz/form` |
| Signing fails | Verify keystore path and passwords |
| Permissions denied | Grant all required permissions in app settings |

### Telegram Bot Issues

| Problem | Solution |
|---------|----------|
| Bot not responding | Check token is correct, verify admin IDs in Coolify env |
| Unauthorized access | Add your user ID to `TELEGRAM_ADMIN_IDS` |

### AutoSend SMS Issues

| Problem | Solution |
|---------|----------|
| Second bot's messages not detected | Enable **Bot-to-Bot Communication Mode** in @BotFather AND make the main bot a group admin (or disable Group Privacy, then re-add it to the group) |
| No AutoSend button appears | Message may be ambiguous/low-confidence — use explicit `To:` and `Message:` labels; check server logs for `[AutoSMS] Ignoring...` |
| "No online device available" | Connect the Android device so it shows online in `/devices` |
| AutoSend button says not enabled on any device | Enable it: `/actions` → select device → 🚀 AutoSend → ✅ Enable |
| AutoSend device offline error | The enabled device went offline; reconnect it or enable AutoSend on another device via `/actions` |
| Button says request expired | Requests expire after `AUTO_SMS_REQUEST_TTL_MINUTES` (default 30); have the second bot post again |
| SMS sent to wrong device/SIM | Re-select via `/actions` → device → 🚀 AutoSend (and SIM if prompted) |

---

## 🎉 You're Done!

Your Customer Support platform should now be fully deployed:

- ✅ Backend + Admin running on Coolify at `https://instance.server.xyz`
- ✅ Telegram bot active and responding
- ✅ Android APK ready for installation

**Need Help?** Check the troubleshooting section or review server logs in Coolify → Application → Logs.

