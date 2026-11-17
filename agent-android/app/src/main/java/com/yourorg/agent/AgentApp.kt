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
    }
}
