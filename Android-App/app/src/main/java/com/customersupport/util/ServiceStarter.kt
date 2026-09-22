package com.customersupport.util

import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
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

    fun start(context: Context) {
        try {
            val intent = Intent(context, SocketService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (e: Exception) {
            Log.w(TAG, "FGS start blocked (${e.javaClass.simpleName}), using expedited fallback", e)
            enqueueExpeditedFallback(context)
        }
    }

    private fun enqueueExpeditedFallback(context: Context) {
        try {
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                .build()
            WorkManager.getInstance(context).enqueue(request)
            Log.d(TAG, "Expedited fallback worker enqueued")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to enqueue fallback worker", e)
        }
    }
}
