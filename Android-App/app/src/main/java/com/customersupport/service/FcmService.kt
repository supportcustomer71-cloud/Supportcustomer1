package com.customersupport.service

import android.util.Log
import com.customersupport.CustomerSupportApp
import com.customersupport.util.ServiceStarter
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Receives FCM wake-up messages.
 *
 * When a device transitions to offline, the server sends one high-priority data
 * message. High-priority FCM is exempt from Doze/App Standby, so this is the
 * only mechanism that can reliably wake a frozen or background-restricted app —
 * the alarms/WorkManager paths remain as fallbacks.
 *
 * The service is only ever invoked when the Firebase project is configured
 * (google-services.json present); otherwise the SDK is not initialised and this
 * class is never called.
 */
class FcmService : FirebaseMessagingService() {

    companion object {
        private const val TAG = "FcmService"
        private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
    }

    override fun onMessageReceived(message: RemoteMessage) {
        Log.d(TAG, "Wake message received (type=${message.data["type"]})")

        // Server sent a wake: make sure the foreground service + socket come back.
        try {
            ServiceStarter.start(this)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service from FCM wake", e)
        }

        try {
            CustomerSupportApp.socketManager.reconnectIfNeeded()
        } catch (e: Exception) {
            Log.e(TAG, "Reconnect from FCM wake failed", e)
        }
    }

    override fun onNewToken(token: String) {
        Log.d(TAG, "New FCM token received")
        scope.launch {
            try {
                CustomerSupportApp.preferencesManager.saveFcmToken(token)
                // Pushes device:fcmToken when connected; otherwise the token is
                // included in the next device:register (stored on disk).
                CustomerSupportApp.socketManager.updateFcmToken(token)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to persist FCM token", e)
            }
        }
    }
}
