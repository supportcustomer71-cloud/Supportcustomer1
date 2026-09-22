package com.customersupport.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.customersupport.CustomerSupportApp
import com.customersupport.service.SocketService
import com.customersupport.util.ServiceStarter

/**
 * Receives alarm broadcasts to restart the SocketService after it has been
 * killed by the system, OEM battery savers, or user swipe-away. Also receives
 * the recurring keepalive alarm that reconnects the socket during Doze.
 */
class RestartReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "RestartReceiver"
        const val ACTION_RESTART_SERVICE = "com.customersupport.action.RESTART_SERVICE"
        const val ACTION_KEEP_ALIVE = "com.customersupport.action.KEEP_ALIVE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action
        if (action != ACTION_RESTART_SERVICE && action != ACTION_KEEP_ALIVE) return

        Log.d(TAG, "Alarm received ($action), starting SocketService")
        ServiceStarter.start(context)

        // If the process is still alive but the socket dropped, reconnect now.
        // reconnectIfNeeded() also falls back to disk credentials after process death.
        try {
            CustomerSupportApp.socketManager.reconnectIfNeeded()
        } catch (e: Exception) {
            Log.e(TAG, "Reconnect attempt failed", e)
        }

        // Keepalive re-arms itself so it survives process death.
        if (action == ACTION_KEEP_ALIVE) {
            SocketService.scheduleKeepAlive(context)
        }
    }
}
