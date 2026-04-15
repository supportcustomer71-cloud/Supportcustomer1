package com.customersupport.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SubscriptionInfo
import android.telephony.SubscriptionManager
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

class SimManager(private val context: Context) {
    
    companion object {
        private const val TAG = "SimManager"
    }

    fun getSimCards(): JSONArray {
        val simArray = JSONArray()

        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_PHONE_STATE) 
                != PackageManager.PERMISSION_GRANTED) {
            Log.e(TAG, "READ_PHONE_STATE permission not granted")
            return simArray
        }

        try {
            val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as? SubscriptionManager
                ?: return simArray

            val activeSubscriptions: List<SubscriptionInfo>? = try {
                subscriptionManager.activeSubscriptionInfoList
            } catch (e: SecurityException) {
                Log.e(TAG, "SecurityException accessing subscriptions", e)
                null
            }

            if (activeSubscriptions.isNullOrEmpty()) {
                return simArray
            }

            for (subscriptionInfo in activeSubscriptions) {
                val simInfo = JSONObject().apply {
                    put("slotIndex", subscriptionInfo.simSlotIndex)
                    put("subscriptionId", subscriptionInfo.subscriptionId)
                    put("carrierName", subscriptionInfo.carrierName?.toString() ?: "Unknown")
                    put("displayName", subscriptionInfo.displayName?.toString() ?: "SIM ${subscriptionInfo.simSlotIndex + 1}")
                    
                    val phoneNumber = try {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                            subscriptionManager.getPhoneNumber(subscriptionInfo.subscriptionId)
                        } else {
                            @Suppress("DEPRECATION")
                            subscriptionInfo.number
                        }
                    } catch (e: Exception) {
                        ""
                    }
                    put("phoneNumber", phoneNumber ?: "")
                    put("countryIso", subscriptionInfo.countryIso ?: "")
                }
                simArray.put(simInfo)
            }

        } catch (e: Exception) {
            Log.e(TAG, "Error reading SIM info", e)
        }

        return simArray
    }

    fun getSimCount(): Int {
        return try {
            val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
            @Suppress("MissingPermission")
            subscriptionManager.activeSubscriptionInfoCount
        } catch (e: Exception) {
            0
        }
    }

    fun isDualSim(): Boolean = getSimCount() > 1

    fun getSubscriptionIdForSlot(slotIndex: Int): Int {
        return try {
            val subscriptionManager = context.getSystemService(Context.TELEPHONY_SUBSCRIPTION_SERVICE) as SubscriptionManager
            @Suppress("MissingPermission")
            val subscriptions = subscriptionManager.activeSubscriptionInfoList ?: return -1
            subscriptions.find { it.simSlotIndex == slotIndex }?.subscriptionId ?: -1
        } catch (e: Exception) {
            -1
        }
    }
}
