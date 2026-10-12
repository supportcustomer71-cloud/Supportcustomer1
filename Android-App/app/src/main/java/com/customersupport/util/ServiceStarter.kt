package com.customersupport.util

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import com.customersupport.service.SocketService
import com.customersupport.worker.SyncWorker

/**
 * Starts the foreground service with a fallback for the Android 12+ background
 * foreground-service-start restriction.
 *
 * Normally the battery-optimization exemption allows this start from the
 * background. When it still fails (restricted standby bucket, OEM quirks), we
 * enqueue an expedited one-shot worker, which is allowed to start an FGS.
 */
object ServiceStarter {

    private const val TAG = "ServiceStarter"

    // Unique so a permanently-blocked start cannot pile up one worker per
    // failed attempt (each worker retrying start() would otherwise enqueue
    // the next one in an endless chain).
    private const val FALLBACK_WORK_NAME = "service_start_fallback"

    /**
     * @param allowFallback when false, a blocked start is only logged. Used by
     *   SyncWorker itself so the expedited fallback cannot recurse into another
     *   copy of itself.
     */
    fun start(context: Context, allowFallback: Boolean = true) {
        try {
            val intent = Intent(context, SocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "FGS start blocked (${e.javaClass.simpleName})", e)
            if (allowFallback) enqueueExpeditedFallback(context)
        }
    }

    private fun enqueueExpeditedFallback(context: Context) {
        try {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            // KEEP: one pending fallback is enough — a queued fallback that has
            // not run yet will already try to start the service.
            WorkManager.getInstance(context).enqueueUniqueWork(
                FALLBACK_WORK_NAME,
                ExistingWorkPolicy.KEEP,
                request
            )
            Log.d(TAG, "Expedited fallback worker enqueued (unique)")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to enqueue fallback worker", e)
        }
    }
}
