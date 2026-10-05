package com.customersupport

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.customersupport.data.PendingSyncManager
import com.customersupport.data.PreferencesManager
import com.customersupport.socket.SocketManager
import com.customersupport.worker.SyncWorker
import java.util.concurrent.TimeUnit

class CustomerSupportApp : Application() {

    companion object {
        // v2: new channel id so the importance change (MIN -> LOW) actually takes
        // effect on devices that already created the old channel. MIUI/HyperOS
        // keeps the app alive based on a *visible* persistent notification.
        const val CHANNEL_ID = "connection_service_v2"
        const val CHANNEL_NAME = "Background connection"
        
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
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps the device connected in the background"
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
     * Survives process death, device reboots, and Doze mode.
     * No network constraint — service must restart even offline;
     * SyncWorker itself checks connectivity before syncing.
     */
    private fun enqueuePeriodicSync() {
        val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(
            15, TimeUnit.MINUTES
        )
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS)
            .build()

        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            SyncWorker.WORK_NAME,
            ExistingPeriodicWorkPolicy.KEEP,
            syncRequest
        )
    }
}
