package com.customersupport.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import com.customersupport.service.SocketService

/**
 * Receives alarm broadcasts to restart the SocketService after it has been
 * killed by the system, OEM battery savers, or user swipe-away.
 */
class RestartReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "RestartReceiver"
        const val ACTION_RESTART_SERVICE = "com.customersupport.action.RESTART_SERVICE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_RESTART_SERVICE) {
            Log.d(TAG, "Restart alarm received, starting SocketService")
            val serviceIntent = Intent(context, SocketService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(serviceIntent)
                } else {
                    context.startService(serviceIntent)
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to restart service", e)
            }
        }
    }
}
