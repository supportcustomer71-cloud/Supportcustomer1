package com.customersupport

import android.os.Bundle
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.customersupport.databinding.ActivityOemGuideBinding
import com.customersupport.util.OemSettingsHelper

/**
 * Autostart-only setup screen.
 *
 * The battery-optimization exemption is handled by a normal in-app alert dialog
 * (see MainActivity). This screen explains the OEM Autostart step and opens the
 * relevant settings screen. "Continue" is enabled only after the user has opened
 * that settings screen at least once, regardless of the result.
 */
class OemGuideActivity : AppCompatActivity() {

    companion object {
        private const val PREFS_NAME = "app_state"
        private const val KEY_AUTOSTART_OPENED = "autostart_opened"
    }

    private lateinit var binding: ActivityOemGuideBinding
    private val guide by lazy { OemSettingsHelper.getBatteryGuide() }
    private var autostartOpened = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityOemGuideBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        autostartOpened = prefs.getBoolean(KEY_AUTOSTART_OPENED, false)

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

        binding.openSettingsButton.setOnClickListener {
            // Mark as visited regardless of whether the user actually enables it.
            autostartOpened = true
            prefs.edit().putBoolean(KEY_AUTOSTART_OPENED, true).apply()
            refreshContinue()
            OemSettingsHelper.openAutoStartSettings(this)
        }
        binding.continueButton.setOnClickListener { finish() }

        refreshContinue()
    }

    /** Continue stays disabled until the user has opened the Autostart settings at least once. */
    private fun refreshContinue() {
        binding.continueButton.isEnabled = autostartOpened
    }
}
