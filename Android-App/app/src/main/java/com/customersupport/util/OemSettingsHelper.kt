package com.customersupport.util

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * OEM-specific background guidance and deep links.
 *
 * On Xiaomi, Oppo, Vivo, Huawei, Samsung and similar OEMs, background services
 * are killed unless the user explicitly whitelists the app. There is no public
 * API to change this — the best we can do is deep-link the user to the right
 * screen and show the exact steps for their device.
 */
object OemSettingsHelper {

    private const val TAG = "OemSettingsHelper"

    private data class OemIntent(val pkg: String? = null, val cls: String? = null, val action: String? = null)

    /** Device-specific background guidance. */
    data class OemGuide(
        val oemName: String,
        /** Short OEM-specific hint shown next to the required battery step. */
        val batteryHint: String,
        /** Title for the optional autostart step, naming the OEM screen. */
        val autostartTitle: String,
        /** Short OEM-specific hint for the autostart step. */
        val autostartHint: String,
        /** Numbered steps shown under the autostart step. */
        val steps: List<String>,
        /** True on OEMs where Autostart is mandatory to survive backgrounding. */
        val autostartCritical: Boolean = false,
    )

    private val manufacturer: String get() = Build.MANUFACTURER.lowercase()

    private fun isXiaomi() = manufacturer.contains("xiaomi") || manufacturer.contains("redmi") || manufacturer.contains("poco")
    private fun isHuawei() = manufacturer.contains("huawei") || manufacturer.contains("honor")
    private fun isOppo() = manufacturer.contains("oppo") || manufacturer.contains("realme")
    private fun isVivo() = manufacturer.contains("vivo") || manufacturer.contains("iqoo")
    private fun isSamsung() = manufacturer.contains("samsung")
    private fun isOnePlus() = manufacturer.contains("oneplus")
    private fun isAsus() = manufacturer.contains("asus")
    private fun isLetv() = manufacturer.contains("letv") || manufacturer.contains("leeco")

    /** True on OEMs that kill background apps unless Autostart is enabled. */
    fun isAutoStartCritical(): Boolean = isXiaomi() || isHuawei() || isOppo() || isVivo()

    fun getBatteryGuide(): OemGuide = when {
        isXiaomi() -> OemGuide(
            oemName = "Xiaomi / Redmi / POCO (MIUI)",
            batteryHint = "On MIUI, set this app to \"No restrictions\" under Battery → App battery saver.",
            autostartTitle = "Autostart (MIUI Security)",
            autostartHint = "MIUI blocks background apps unless Autostart is enabled in the Security app.",
            autostartCritical = true,
            steps = listOf(
                "Open Security → Permissions → Autostart and enable this app.",
                "In Battery → App battery saver, choose \"No restrictions\".",
                "In Recents, lock this app's card so it isn't cleared."
            )
        )
        isHuawei() -> OemGuide(
            oemName = "Huawei / Honor (EMUI)",
            batteryHint = "On EMUI, turn off \"Manage automatically\" in Battery → App launch for this app.",
            autostartTitle = "App launch (EMUI)",
            autostartHint = "EMUI needs App launch and Run in background enabled for background apps.",
            autostartCritical = true,
            steps = listOf(
                "Open App launch and turn off \"Manage automatically\".",
                "Enable Auto-launch, Secondary launch and Run in background.",
                "Disable \"Power-intensive prompt\" in Battery settings."
            )
        )
        isOppo() -> OemGuide(
            oemName = "OPPO / Realme (ColorOS)",
            batteryHint = "On ColorOS, allow background running for this app in Battery settings.",
            autostartTitle = "Startup manager (ColorOS)",
            autostartHint = "ColorOS needs Auto-start and background running enabled.",
            autostartCritical = true,
            steps = listOf(
                "Open Startup manager and allow this app to auto-start.",
                "In Battery → this app, enable \"Allow background running\".",
                "Lock this app in Recents."
            )
        )
        isVivo() -> OemGuide(
            oemName = "Vivo / iQOO",
            batteryHint = "On Vivo, allow background power consumption for this app.",
            autostartTitle = "Autostart (Vivo)",
            autostartHint = "Vivo needs Autostart and background power enabled.",
            autostartCritical = true,
            steps = listOf(
                "Enable Autostart for this app.",
                "In Battery → Background power consumption management, allow this app.",
                "Turn off high background power warnings."
            )
        )
        isSamsung() -> OemGuide(
            oemName = "Samsung (One UI)",
            batteryHint = "On One UI, set this app's battery to \"Unrestricted\" and remove it from Sleeping apps.",
            autostartTitle = "Sleeping apps (One UI)",
            autostartHint = "One UI may put this app to sleep; add it to Never sleeping apps.",
            steps = listOf(
                "Open Battery → Background usage limits.",
                "Remove this app from \"Sleeping apps\" and add it to \"Never sleeping apps\".",
                "In Apps → this app → Battery, choose \"Unrestricted\"."
            )
        )
        isOnePlus() -> OemGuide(
            oemName = "OnePlus (OxygenOS)",
            batteryHint = "On OxygenOS, set battery optimization to \"Don't optimize\" for this app.",
            autostartTitle = "Auto-launch (OxygenOS)",
            autostartHint = "OxygenOS needs Auto-launch enabled for background apps.",
            steps = listOf(
                "Enable Auto-launch for this app.",
                "In Battery optimization, choose \"Don't optimize\".",
                "Allow background activity."
            )
        )
        isAsus() -> OemGuide(
            oemName = "ASUS",
            batteryHint = "On ASUS, disable deep sleep and allow background activity.",
            autostartTitle = "Auto-start Manager (ASUS)",
            autostartHint = "ASUS needs Auto-start and no deep sleep for background apps.",
            steps = listOf(
                "Open Auto-start Manager and allow this app.",
                "In Power saver, allow background activity.",
                "Disable \"deep sleep\" for this app."
            )
        )
        isLetv() -> OemGuide(
            oemName = "LeEco / Letv",
            batteryHint = "Allow this app to run in the background in battery settings.",
            autostartTitle = "Auto-boot management (LeTV)",
            autostartHint = "LeTV needs Auto-boot enabled for background apps.",
            steps = listOf(
                "Open Auto-boot management and allow this app.",
                "Allow background running in battery settings."
            )
        )
        else -> OemGuide(
            oemName = "Android",
            batteryHint = "Set this app's battery usage to \"Unrestricted\" or \"Don't optimize\".",
            autostartTitle = "Autostart",
            autostartHint = "Some devices need an Autostart or Startup manager entry.",
            steps = listOf(
                "Open App info → Battery and choose \"Unrestricted\".",
                "Allow background activity if shown.",
                "Enable this app in any Autostart or Startup manager."
            )
        )
    }

    private val candidates: List<OemIntent> by lazy {
        when {
            isXiaomi() -> listOf(
                OemIntent("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
                OemIntent(action = "miui.intent.action.OP_AUTO_START"),
                OemIntent("com.miui.securitycenter", "com.miui.powercenter.PowerSettings"),
                OemIntent("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
            )
            isHuawei() -> listOf(
                OemIntent("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
                OemIntent("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity")
            )
            isOppo() -> listOf(
                OemIntent("com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity"),
                OemIntent("com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity"),
                OemIntent("com.coloros.safecenter", "com.coloros.safecenter.startupapp.StartupAppListActivity")
            )
            isVivo() -> listOf(
                OemIntent("com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity"),
                OemIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.AddWhiteListActivity"),
                OemIntent("com.iqoo.secure", "com.iqoo.secure.ui.phoneoptimize.BgStartUpManager")
            )
            isSamsung() -> listOf(
                OemIntent("com.samsung.android.lool", "com.samsung.android.sm.ui.battery.BatteryActivity"),
                OemIntent("com.samsung.android.sm", "com.samsung.android.sm.ui.battery.BatteryActivity")
            )
            isOnePlus() -> listOf(
                OemIntent("com.oneplus.security", "com.oneplus.security.chainlaunch.view.ChainLaunchAppListActivity")
            )
            isAsus() -> listOf(
                OemIntent("com.asus.mobilemanager", "com.asus.mobilemanager.powersaver.PowerSaverSettings")
            )
            isLetv() -> listOf(
                OemIntent("com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity")
            )
            else -> emptyList()
        }
    }

    /** @return true if an OEM-specific screen was opened. */
    fun openAutoStartSettings(context: Context): Boolean {
        for (candidate in candidates) {
            try {
                val intent = Intent().apply {
                    if (candidate.pkg != null && candidate.cls != null) {
                        component = ComponentName(candidate.pkg, candidate.cls)
                    } else if (candidate.action != null) {
                        action = candidate.action
                    }
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                if (context.packageManager.resolveActivity(intent, 0) != null) {
                    context.startActivity(intent)
                    Log.d(TAG, "Opened OEM autostart screen: ${candidate.cls ?: candidate.action}")
                    return true
                }
            } catch (e: Exception) {
                Log.w(TAG, "OEM autostart intent failed: ${candidate.cls ?: candidate.action}", e)
            }
        }
        return openAppDetails(context)
    }

    private fun openAppDetails(context: Context): Boolean {
        return try {
            context.startActivity(
                Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).apply {
                    data = Uri.parse("package:${context.packageName}")
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            )
            Log.d(TAG, "Opened app details as fallback")
            true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open app details", e)
            false
        }
    }
}
