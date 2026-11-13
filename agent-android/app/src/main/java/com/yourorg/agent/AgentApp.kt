package com.yourorg.agent

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class AgentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                AgentService.CHANNEL_ID,
                getString(R.string.channel_name),
                NotificationManager.IMPORTANCE_LOW,
            )
        )
        // High importance so the "tap to install update" prompt is hard to miss: on Android 12+
        // the install-confirm dialog cannot pop itself from the background, so the user taps this.
        nm.createNotificationChannel(
            NotificationChannel(
                AgentService.UPDATE_CHANNEL_ID,
                "Agent updates",
                NotificationManager.IMPORTANCE_HIGH,
            )
        )
    }
}
