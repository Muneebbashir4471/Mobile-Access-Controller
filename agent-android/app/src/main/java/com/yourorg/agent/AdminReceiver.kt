package com.yourorg.agent

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent

/**
 * Device owner entry point. Becomes owner either through the dashboard's Device Owner setup QR
 * (factory-reset phone, tap the welcome screen six times) or over adb on a phone with no accounts:
 *   adb shell dpm set-device-owner com.yourorg.agent/.AdminReceiver
 */
class AdminReceiver : DeviceAdminReceiver() {
    /** Android 10–11 QR setup ends here (12+ uses PolicyComplianceActivity as well). */
    override fun onProfileProvisioningComplete(context: Context, intent: Intent) {
        DeviceOwner.applyPolicies(context)
        Provisioning.start(context, Provisioning.extrasOf(intent))
    }
}
