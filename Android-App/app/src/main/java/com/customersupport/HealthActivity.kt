package com.customersupport

import android.annotation.SuppressLint
import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.customersupport.databinding.ActivityHealthBinding
import com.customersupport.service.SocketService
import com.customersupport.util.OemSettingsHelper
import com.customersupport.util.ServiceStarter
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Native, no-notification diagnostics screen. Shows why the app may be offline
 * (service, socket, battery exemption, exact alarms, last sync/connect/disconnect)
 * and offers one-tap recovery actions.
 */
class HealthActivity : AppCompatActivity() {

    private lateinit var binding: ActivityHealthBinding
    private val socketManager get() = CustomerSupportApp.socketManager

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityHealthBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.restartButton.setOnClickListener {
            ServiceStarter.start(this)
            socketManager.reconnectIfNeeded()
            binding.root.postDelayed({ refresh() }, 1500)
        }
        binding.batteryButton.setOnClickListener { openBatteryExemption() }
        binding.autostartButton.setOnClickListener { OemSettingsHelper.openAutoStartSettings(this) }
        binding.alarmButton.setOnClickListener { openExactAlarmSettings() }
        binding.closeButton.setOnClickListener { finish() }

        refresh()
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        setStatus(binding.serviceValue, SocketService.isRunning)

        val connected = socketManager.isConnected()
        setStatus(binding.socketValue, connected)

        val exempt = isIgnoringBatteryOptimizations()
        setStatus(binding.batteryValue, exempt)

        val alarmAllowed = isExactAlarmAllowed()
        setStatus(binding.alarmValue, alarmAllowed)
        binding.alarmButton.visibility =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmAllowed) View.VISIBLE else View.GONE

        binding.lastConnectValue.text = formatTime(socketManager.lastConnectedAt)
        binding.lastDisconnectValue.text = formatDisconnect()

        lifecycleScope.launch {
            val lastSync = CustomerSupportApp.preferencesManager.getLastSyncTime().first()
            binding.lastSyncValue.text = formatTime(lastSync)
        }
    }

    private fun setStatus(view: TextView, good: Boolean) {
        view.setText(
            when {
                view === binding.serviceValue -> if (good) R.string.health_value_running else R.string.health_value_stopped
                view === binding.socketValue -> if (good) R.string.health_value_connected else R.string.health_value_offline
                view === binding.batteryValue -> if (good) R.string.health_value_exempt else R.string.health_value_restricted
                else -> if (good) R.string.health_value_allowed else R.string.health_value_not_allowed
            }
        )
        view.setTextColor(ContextCompat.getColor(this, if (good) R.color.success else R.color.warning))
    }

    private fun formatTime(ms: Long): String {
        if (ms <= 0L) return getString(R.string.health_value_never)
        return SimpleDateFormat("dd MMM, HH:mm:ss", Locale.getDefault()).format(Date(ms))
    }

    private fun formatDisconnect(): String {
        val reason = socketManager.lastDisconnectReason
        if (reason.isNullOrBlank() || socketManager.lastDisconnectAt <= 0L) {
            return getString(R.string.health_value_none)
        }
        return "$reason · ${formatTime(socketManager.lastDisconnectAt)}"
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun isExactAlarmAllowed(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val am = getSystemService(ALARM_SERVICE) as AlarmManager
        return am.canScheduleExactAlarms()
    }

    @SuppressLint("BatteryLife")
    private fun openBatteryExemption() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            } catch (_: Exception) {
            }
        }
    }

    private fun openExactAlarmSettings() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (e: Exception) {
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                )
            } catch (_: Exception) {
            }
        }
    }
}
