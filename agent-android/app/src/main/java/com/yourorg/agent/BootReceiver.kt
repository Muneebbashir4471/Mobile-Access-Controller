package com.yourorg.agent

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts the agent after a reboot or after the app updates itself. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (Prefs.credentials(context) != null) AgentService.start(context)
            }
        }
    }
}
