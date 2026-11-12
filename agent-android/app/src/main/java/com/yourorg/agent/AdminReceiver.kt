package com.yourorg.agent

import android.app.admin.DeviceAdminReceiver

/**
 * Device owner entry point. Set once on a factory-reset phone with no accounts:
 *   adb shell dpm set-device-owner com.yourorg.agent/.AdminReceiver
 * Milestone 6 uses it to block system updates, prevent removal and install updates silently.
 */
class AdminReceiver : DeviceAdminReceiver()
