package com.customersupport

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.customersupport.data.PendingSyncManager
import com.customersupport.data.PreferencesManager
import com.customersupport.socket.SocketManager
import com.customersupport.worker.SyncWorker
import java.util.concurrent.TimeUnit

class CustomerSupportApp : Application() {

    companion object {
        const val CHANNEL_ID = "socket_service_channel"
        const val CHANNEL_NAME = "Customer Support Service"
        
        // Manual singleton instances (replacing Hilt)
        lateinit var instance: CustomerSupportApp
            private set
        
        val socketManager: SocketManager by lazy { SocketManager() }
        val preferencesManager: PreferencesManager by lazy { PreferencesManager(instance) }
        val pendingSyncManager: PendingSyncManager by lazy { PendingSyncManager(instance) }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        enqueuePeriodicSync()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_MIN
            ).apply {
                description = "Background service for syncing data"
                setShowBadge(false)
                setSound(null, null)
                enableLights(false)
                enableVibration(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * Enqueue a periodic WorkManager job that runs every 15 minutes.
     * This survives process death, device reboots, and Doze mode.
     * It ensures the foreground service stays alive and data is synced.
     */
    private fun enqueuePeriodicSync() {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(
            15, TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            SyncWorker.WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            syncRequest
        )
    }
}
