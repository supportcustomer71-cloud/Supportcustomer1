# 📡 Connection Stability — Root Causes, Fixes & Playbook

This document explains why Android devices can show as **offline** in the admin
panel, what the codebase already does about it, which hardening was added, and
what remains an operational/deployment concern.

It complements the *“WebSocket stability (devices showing offline)”* section in
[DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md).

---

## 1. How the connection works

```
Android App (SocketService, foreground service)          Coolify VPS
┌───────────────────────────────────────────┐            ┌──────────────────────────┐
│ WakeLock + WifiLock held while service runs│           │ Traefik → node:3001      │
│ Socket.IO client (polling → upgrade to WS) │  wss://    │ Socket.IO server         │
│  ├ engine.io pings (server→device, 15 s)   │ ─────────► │  pingInterval 15 s       │
│  ├ device:register on every connect        │            │  pingTimeout  30 s       │
│  ├ device:heartbeat every 30 s             │            │  offline grace 12 s      │
│  └ sms:sync every 5 min / on SMS received  │            │  presence reconcile 30 s │
├───────────────────────────────────────────┤            └──────────────────────────┘
│ Watchdog 30 s · Network callback · Screen-on receiver
│ Keepalive alarm 15 min (60 s while offline) · WorkManager 15 min
│ SMS_RECEIVED receiver · PHONE_STATE receiver · Boot receiver · FcmService
└───────────────────────────────────────────┘
```

> When a device is marked offline, the server additionally sends one
> **high-priority FCM wake** message (optional feature — see §5); high-priority
> FCM is exempt from Doze, so it can revive a frozen app where alarms cannot.

Presence is decided server-side only:

| Event | Server action |
|---|---|
| `device:register` / `device:heartbeat` / any sync | mark **online**, cancel pending offline |
| socket `disconnect` | schedule **offline** after a 12 s grace period |
| grace expires, socket still gone | mark **offline** (shown red in panel) |
| every 30 s | reconcile: live sockets → online; online w/o live socket → offline |

---

## 2. Why a device shows offline

| # | Root cause | What actually happens |
|---|---|---|
| 1 | **Doze / app-standby** | CPU frozen, pings not answered for 30 s → server drops the socket → offline. Revived by high-priority FCM wake (§5, when configured), keepalive alarm, WorkManager or user action. |
| 2 | **OEM task killers** (MIUI, EMUI, ColorOS…, Autostart off) | Process killed while backgrounded or after swipe-away. High-priority FCM can restart a killed process (unless the user force-stopped it); with no FCM, nothing can restart it until the user opens the app. |
| 3 | **Carrier / Wi-Fi handover** | Old socket dies silently; reconnection takes a few seconds. The 12 s grace prevents a visible offline flap. |
| 4 | **WebSocket blocked by network/ proxy** | Client can never connect *if it starts on WebSocket only*. |
| 5 | **Restrictive proxy timeouts** | Traefik/proxy closes an idle WebSocket. Mitigated by 15 s pings + proxy timeout ≥ 120 s. |
| 6 | **Server restart / deploy** | All devices drop; they re-register within seconds. Devices start as `offline` after a restart until their next connect. |
| 7 | **Duplicate socket / thread race** | Two sockets for one device; server binds the one that dies later → “offline” while the app thinks it is connected. |
| 8 | **App process killed but service “alive” in recents** | Nothing listening; keepalive alarm + WorkManager revive the service. |
| 9 | **Phantom online state** | Missed disconnect event → device stuck green forever (now swept, see §3). |

---

## 3. Hardening added in this pass

### Android app

| Area | File | Change |
|---|---|---|
| Thread-safe socket lifecycle | `socket/SocketManager.kt` | `socket` is `@Volatile`; `connect()` / `forceReconnect()` / `disconnect()` are `@Synchronized`. Removes the race where two threads (watchdog, network callback, alarm receiver, WorkManager) create two sockets and leak one. |
| Transport fallback | `socket/SocketManager.kt` | `transports = ["polling","websocket"]` instead of `["websocket","polling"]`. socket.io-client **only ever starts on `transports[0]`** — WebSocket-first means “WebSocket-only”, which can never connect behind a proxy/hotspot that blocks WS. Polling always establishes the session; the auto-upgrade to WebSocket still happens right after the handshake. |
| Adaptive keepalive alarm | `service/SocketService.kt` | While **disconnected** the keepalive alarm is re-armed every **60 s** (was a fixed 15 min); while connected it stays 15 min. A killed/frozen process is now revived in ~1 minute instead of up to 15. Also re-armed in `onTaskRemoved` (swipe-away). |
| Swipe-away resilience | `service/SocketService.kt` | `onTaskRemoved()` now also starts the service immediately, in addition to the 3 s restart alarm. |
| Wake on call | `receiver/PhoneStateReceiver.kt` + manifest | `PHONE_STATE` is one of the few implicit broadcasts still delivered to manifest receivers in the background. Every call now wakes the app and triggers `reconnectIfNeeded()`. |
| No worker pile-up | `util/ServiceStarter.kt`, `worker/SyncWorker.kt` | The expedited fallback is now **unique work** (`ExistingWorkPolicy.KEEP`) and `SyncWorker` starts the service with `allowFallback=false`, so a permanently blocked FGS start can no longer recurse into an endless chain of workers. |
| Wake-on-offline (optional) | `service/FcmService.kt`, `socket/SocketManager.kt`, `data/PreferencesManager.kt` | Receives high-priority FCM wake messages, starts the service and reconnects; FCM token is persisted and uploaded/rotated. Dormant until `google-services.json` is added — see §5. |

### Server

| Area | File | Change |
|---|---|---|
| No offline flap on quick reconnect | `socket/handlers.ts` | `device:register` cancels any pending offline timer immediately. |
| Phantom-online sweep | `socket/handlers.ts` | The 30 s reconcile now also marks offline any device that is `online` **without a live bound socket** (skipping devices inside the 12 s grace window). A missed disconnect can no longer leave a device green forever. |
| Wake on going offline (optional) | `fcm.ts`, `socket/handlers.ts`, `store.ts`, `types/index.ts` | Every path that flips a device offline sends one high-priority FCM data message (per-device cooldown, 5 min TTL, invalid tokens cleared, token persisted). Disabled unless credentials are configured — see §5. |

### Admin panel

| Area | File | Change |
|---|---|---|
| Reconnection tuning + transport fallback | `contexts/SocketContext.tsx` | `transports: ['polling','websocket']` (same WebSocket-blocking issue as the app); automatic reconnect uses socket.io defaults (infinite attempts, capped backoff). |

---

## 4. Operational checklist (deployment)

These are **not fixable in app code** — verify them on every new deployment:

1. **Proxy timeouts** — Traefik (Coolify) must allow WebSocket upgrade on
   `/socket.io/` and its read/idle timeout must be **≥ 120 s** (pings are every
   15 s).
2. **Do not run >1 replica** — Socket.IO presence is in-memory and the Telegram
   bot would `409 Conflict`.
3. **Device setup (per phone)** — see the in-app guide: battery optimization
   *Unrestricted*, Autostart enabled (MIUI/EMUI/ColorOS/Vivo), notifications
   allowed (the FGS notification must be *visible* on MIUI), and lock the app in
   Recents. The Health screen (tap the status dot) shows all of it.
4. **Persistent storage** — add a Coolify volume for `/app/server/data` if you
   want forms/identity to survive redeploys.

---

## 5. Wake-on-offline via FCM (implemented — activate with two files)

Everything in §3 shortens the offline window; only a **high-priority FCM data
message** can reliably wake a dozing/OEM-frozen app, because it is exempt from
Doze and App Standby. This is now wired end-to-end and stays **dormant** until
you add Firebase credentials (the build is green either way).

**Flow:** server marks a device offline → it has that device's FCM token →
server sends one high-priority data message (`{type:"wake"}`, TTL 5 min) → FCM
starts the app process → `FcmService` runs `ServiceStarter.start()` +
`reconnectIfNeeded()` → the device is back online, usually in seconds.

Where a wake is triggered (all paths that flip a device offline):

| Path | File |
|---|---|
| Disconnect grace period expired | `socket/handlers.ts` → `scheduleOffline` |
| Phantom-online sweep | `socket/handlers.ts` → `sweepPhantomOnline` |
| Unbound socket disconnected | `socket/handlers.ts` → disconnect fallback |

**Setup**

1. **Firebase console** (free Spark plan, no card):
   create a project → *Add app* → Android → package name `com.customersupport`
   → download `google-services.json` → place it at
   `Android-App/app/google-services.json` → rebuild the APK.
   The Gradle Google-Services plugin is applied automatically only when this
   file exists (`Android-App/app/build.gradle.kts`), so nothing else changes.
2. **Service account**: project settings → *Service accounts* → *Generate new
   private key* → base64-encode the JSON and put it in Coolify as a **runtime**
   env var:
   ```bash
   base64 -w0 service-account.json      # macOS: base64 -i service-account.json
   ```
   ```
   FIREBASE_SERVICE_ACCOUNT_BASE64=<output>
   ```
   Redeploy. The server log/banner shows `FCM wakes: ✅ Enabled`.
   (Raw JSON also works via `FIREBASE_SERVICE_ACCOUNT_JSON`, but base64 avoids
   multiline env problems.)
3. Optional: `FCM_WAKE_COOLDOWN_MINUTES` (default `3`) — per-device minimum gap
   between wake messages.

**Behaviour & safeguards**

- One wake per offline transition, per-device cooldown, TTL 5 min and a collapse
  key — a flapping device can never generate a wake storm.
- Invalid tokens (app uninstalled / token rotated) are detected
  (`registration-token-not-registered`) and cleared from the store; a rotated
  token is re-uploaded by the app on `onNewToken` and on every `device:register`.
- FCM tokens are persisted in `store.json`, so wake works across redeploys.
- Cost/quota: FCM is free (Spark); the project quota is 600k messages/minute —
  hundreds of devices are nowhere near it. This design sends at most one message
  per device per cooldown window.

**What FCM cannot do**

- Waking an app the user **force-stopped** from Settings (Android blocks all
  delivery until it is opened again — same for alarms).
- Devices without Google Play services (some China-market/de-Googled ROMs); the
  alarm/WorkManager layers remain their fallback.
- Apps with notifications blocked by the user keep working — wake messages are
  *data* messages and do not need the notification permission.

---

## 6. Tuning knobs (single source of truth)

| Knob | Where | Value | Effect of increasing |
|---|---|---|---|
| `pingInterval` / `pingTimeout` | `Web-App/server/src/index.ts` | 15 s / 30 s | Fewer false disconnects, slower dead-socket detection |
| `OFFLINE_GRACE_MS` | `Web-App/server/src/socket/handlers.ts` | 12 000 | Fewer offline flaps, slower red-dot |
| reconcile interval | `Web-App/server/src/socket/handlers.ts` | 30 s | Slower self-healing |
| `KEEP_ALIVE_INTERVAL_MS` | `Android …/SocketService.kt` | 15 min | Longer rescue latency while connected |
| `KEEP_ALIVE_RETRY_MS` | `Android …/SocketService.kt` | 60 s | Longer rescue latency while offline (battery ↑) |
| `WATCHDOG_INTERVAL_MS` | `Android …/SocketService.kt` | 30 s | Slower in-process reconnect |
| `HEARTBEAT_INTERVAL_MS` (+90 s stale) | `Android …/SocketService.kt` | 30 s | Slower half-open detection |
| `SYNC_INTERVAL_MS` | `Android …/SocketService.kt` | 5 min | Slower SMS pull cadence |
| reconnection delay | `Android …/SocketManager.kt` | 1–5 s | Slower reconnect after network return (battery ↑↓) |
| `FCM_WAKE_COOLDOWN_MINUTES` | `Web-App/server/src/fcm.ts` | 3 min | Fewer FCM wake messages per flapping device |

---

## 7. Diagnosing a device that keeps going offline

1. **Admin panel**: device row shows `lastDisconnectReason` / `lastSeen`
   (`http://…/api/devices`) — `ping timeout` = network froze/Doze;
   `transport close` = socket dropped; `ping timeout` + quick recovery = normal.
2. **On the phone** (tap the status dot → Health): service running, socket
   connected, battery exempt, exact alarms allowed, notifications enabled, last
   connect/disconnect time.
3. **Logcat** (`adb logcat -s SocketService SocketManager RestartReceiver PhoneStateReceiver SmsReceiver`):
   - `Keepalive scheduled in 1 min` → correct fast-rescue mode.
   - `Socket stuck in CONNECTING for >60s, forcing reconnect` → network path issue.
   - `Heartbeat ack stale for >90s — forcing reconnect` → half-open socket.
   - `Task removed (swiped away)` → swipe-away path.
   - `Phone state changed (RINGING)` → wake-on-call working.
4. **Server logs**: `[Socket] Presence sweep: … marked offline` identifies
   phantom-online repairs; `[Socket] Device registered: …` shows every
   reconnection.
