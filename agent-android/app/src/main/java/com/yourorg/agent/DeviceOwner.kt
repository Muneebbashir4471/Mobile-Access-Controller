package com.yourorg.agent

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ComponentName
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.provider.Settings
import android.util.Log

/**
 * Policies applied when the agent is device owner (set once with
 * `adb shell dpm set-device-owner com.yourorg.agent/.AdminReceiver`).
 */
object DeviceOwner {
    private const val TAG = "DeviceOwner"

    fun isOwner(ctx: Context): Boolean =
        ctx.getSystemService(DevicePolicyManager::class.java).isDeviceOwnerApp(ctx.packageName)

    fun applyPolicies(ctx: Context) {
        if (!isOwner(ctx)) return
        val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
        val admin = ComponentName(ctx, AdminReceiver::class.java)
        val pkg = ctx.packageName

        fun attempt(what: String, block: () -> Unit) =
            runCatching(block).onFailure { Log.w(TAG, "policy '$what' failed", it) }

        // Hold system updates (postponed in 30-day windows) so a phone never reboots mid-session.
        attempt("system updates") { dpm.setSystemUpdatePolicy(admin, SystemUpdatePolicy.createPostponeInstallPolicy()) }
        // The agent cannot be uninstalled from the phone.
        attempt("uninstall block") { dpm.setUninstallBlocked(admin, pkg, true) }
        // No lock screen, and the screen stays on while charging.
        attempt("keyguard") { dpm.setKeyguardDisabled(admin, true) }
        attempt("stay on") {
            val all = BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB or
                BatteryManager.BATTERY_PLUGGED_WIRELESS
            dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, all.toString())
        }
        // Grant the agent's runtime permissions without anyone tapping dialogs.
        val perms = buildList {
            add(Manifest.permission.READ_PHONE_STATE)
            add(Manifest.permission.CAMERA)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
        }
        for (p in perms) attempt("grant $p") {
            dpm.setPermissionGrantState(admin, pkg, p, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED)
        }
        Log.i(TAG, "device owner policies applied")
    }
}
