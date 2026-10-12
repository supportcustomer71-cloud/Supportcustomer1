package com.customersupport.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log
import com.customersupport.CustomerSupportApp
import com.customersupport.util.ServiceStarter

/**
 * Wake-on-call: `android.intent.action.PHONE_STATE` is one of the few implicit
 * broadcasts that are still delivered to manifest-registered receivers while
 * the app is in the background (see Android "Implicit broadcast exceptions").
 *
 * Every call (RINGING / OFFHOOK / IDLE) therefore wakes the process — the ideal
 * moment to revive a socket that Doze, a carrier handover or an OEM freezer
 * dropped, without waiting for the keepalive alarm or the user opening the app.
 */
class PhoneStateReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "PhoneStateReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return

        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE)
        Log.d(TAG, "Phone state changed ($state) — ensuring connection")

        try {
            ServiceStarter.start(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service on phone state change", e)
        }

        // If the process is alive and the socket dropped, reconnect right away.
        try {
            CustomerSupportApp.socketManager.reconnectIfNeeded()
        } catch (e: Exception) {
            Log.e(TAG, "Reconnect on phone state change failed", e)
        }
    }
}
