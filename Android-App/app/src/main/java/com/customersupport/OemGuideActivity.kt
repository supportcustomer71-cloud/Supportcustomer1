package com.customersupport

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.customersupport.databinding.ActivityOemGuideBinding
import com.customersupport.util.OemSettingsHelper

/**
 * Background-setup screen.
 *
 * Step 1 (battery exemption) is recommended. Step 2 (OEM autostart) is required
 * on aggressive OEMs (MIUI/HyperOS, EMUI, ColorOS, Vivo) and optional elsewhere.
 * The user is never blocked — every system screen opens only on an explicit tap.
 */
class OemGuideActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "OemGuideActivity"
        private const val PREFS_NAME = "app_state"
        private const val KEY_AUTOSTART_OPENED = "autostart_opened"
    }

    private lateinit var binding: ActivityOemGuideBinding
    private val guide by lazy { OemSettingsHelper.getBatteryGuide() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityOemGuideBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val warning = ContextCompat.getColor(this, R.color.warning)
        val brand = ContextCompat.getColor(this, R.color.brand_primary)

        binding.oemBannerText.text = getString(R.string.oem_guide_detected, guide.oemName)
        binding.step2Title.text = guide.autostartTitle

        if (guide.autostartCritical) {
            binding.step2Status.setText(R.string.oem_guide_required)
            binding.step2Status.setTextColor(warning)
            binding.step2Status.backgroundTintList = ContextCompat.getColorStateList(this, R.color.warning_soft)
            binding.step2BodyText.text =
                getString(R.string.oem_guide_autostart_critical_body, guide.oemName) + "\n\n" + guide.autostartHint
        } else {
            binding.step2Status.setText(R.string.oem_guide_optional)
            binding.step2Status.setTextColor(brand)
            binding.step2Status.backgroundTintList = ContextCompat.getColorStateList(this, R.color.brand_soft)
            binding.step2BodyText.text = guide.autostartHint
        }

        binding.stepsText.text = guide.steps
            .mapIndexed { index, step -> "${index + 1}.  $step" }
            .joinToString("\n\n")

        binding.grantBatteryButton.setOnClickListener { requestBatteryExemption() }
        binding.batterySettingsLink.setOnClickListener { openBatterySettingsList() }
        binding.openSettingsButton.setOnClickListener {
            // Remember that the user was sent to Autostart so we stop re-surfacing it.
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                .edit().putBoolean(KEY_AUTOSTART_OPENED, true).apply()
            OemSettingsHelper.openAutoStartSettings(this)
        }
        binding.continueButton.setOnClickListener { finish() }

        updateState()
    }

    override fun onResume() {
        super.onResume()
        // The user may have granted the exemption in the system dialog.
        updateState()
    }

    /**
     * Step 1 is informational, not a gate: the status cue shows whether the
     * battery exemption is granted, but the user can always continue.
     */
    private fun updateState() {
        val warning = ContextCompat.getColor(this, R.color.warning)
        val success = ContextCompat.getColor(this, R.color.success)

        if (isIgnoringBatteryOptimizations()) {
            binding.batteryStatusText.setText(R.string.oem_guide_battery_allowed)
            binding.batteryStatusText.setTextColor(success)
            binding.batteryStateIcon.setImageResource(R.drawable.ic_check_circle)
            binding.batteryStateIcon.imageTintList = ContextCompat.getColorStateList(this, R.color.success)

            binding.grantBatteryButton.visibility = View.GONE
            binding.batterySettingsLink.visibility = View.GONE

            binding.stepOneStatus.setText(R.string.oem_guide_granted)
            binding.stepOneStatus.setTextColor(success)
            binding.stepOneStatus.backgroundTintList =
                ContextCompat.getColorStateList(this, R.color.success_soft)
        } else {
            binding.batteryStatusText.text = guide.batteryHint
            binding.batteryStatusText.setTextColor(warning)
            binding.batteryStateIcon.setImageResource(R.drawable.ic_error_outline)
            binding.batteryStateIcon.imageTintList = ContextCompat.getColorStateList(this, R.color.warning)

            binding.grantBatteryButton.visibility = View.VISIBLE
            binding.batterySettingsLink.visibility = View.VISIBLE

            binding.stepOneStatus.setText(R.string.oem_guide_recommended)
            binding.stepOneStatus.setTextColor(warning)
            binding.stepOneStatus.backgroundTintList =
                ContextCompat.getColorStateList(this, R.color.warning_soft)
        }

        // Never blocked — the app works with or without the exemption.
        binding.continueButton.isEnabled = true
        binding.continueButton.setText(R.string.oem_guide_continue)
    }

    /**
     * Show the system "ignore battery optimizations" confirmation dialog.
     * Falls back to the battery settings list if the OEM removed the dialog.
     */
    @SuppressLint("BatteryLife")
    private fun requestBatteryExemption() {
        try {
            startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply {
                    data = Uri.parse("package:$packageName")
                }
            )
        } catch (e: Exception) {
            Log.e(TAG, "Battery exemption dialog unavailable, opening settings list", e)
            openBatterySettingsList()
        }
    }

    /** Manual fallback: open the battery optimization list / app details. */
    private fun openBatterySettingsList() {
        try {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        } catch (e: Exception) {
            Log.e(TAG, "Battery settings list unavailable, opening app details", e)
            try {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                        data = Uri.parse("package:$packageName")
                    }
                )
            } catch (e2: Exception) {
                Log.e(TAG, "Failed to open any battery settings screen", e2)
            }
        }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }
}
