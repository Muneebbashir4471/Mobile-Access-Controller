package com.yourorg.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class AgentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        // IMPORTANCE_MIN keeps the required foreground-service notice as unobtrusive as Android
        // allows: no sound, no heads-up banner, no status-bar icon, collapsed to the bottom of the
        // shade. A foreground capture service must keep *some* notification, so it can't be removed.
        nm.createNotificationChannel(
            NotificationChannel(
                AgentService.CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_MIN,
            ).apply {
                setShowBadge(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_SECRET
            }
        )
        // Finish pairing from a Device Owner setup QR if the app restarted before it completed.
        Provisioning.resume(this)
    }
}
