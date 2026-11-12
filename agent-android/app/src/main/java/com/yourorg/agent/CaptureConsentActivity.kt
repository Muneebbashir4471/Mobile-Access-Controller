package com.yourorg.agent

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log

/**
 * Shows Android's screen capture consent dialog and hands the result to [AgentService].
 *
 * While it is showing, [awaitingConsent] lets [InputService] press the dialog's confirm button
 * itself, so a rebooted phone can come back without anyone touching it.
 */
class CaptureConsentActivity : Activity() {

    companion object {
        private const val REQ = 1
        @Volatile var awaitingConsent = false
            private set

        fun launch(ctx: Context) {
            val i = Intent(ctx, CaptureConsentActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            try {
                ctx.startActivity(i)
            } catch (e: Exception) {
                // Background starts are allowed for device owners and while the accessibility
                // service is bound; otherwise the setup screen's checklist button is the way in.
                Log.w("CaptureConsent", "could not open consent screen", e)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mpm = getSystemService(MediaProjectionManager::class.java)
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Whole screen, not a single app.
            mpm.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
        } else {
            mpm.createScreenCaptureIntent()
        }
        awaitingConsent = true
        @Suppress("DEPRECATION")
        startActivityForResult(intent, REQ)
        InputService.instance?.watchForConsent()
    }

    @Deprecated("Activity result API kept simple on purpose")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        awaitingConsent = false
        if (requestCode == REQ && resultCode == RESULT_OK && data != null) {
            AgentService.onCaptureConsent(this, data)
        } else {
            Log.w("CaptureConsent", "consent refused")
        }
        finish()
    }

    override fun onDestroy() {
        awaitingConsent = false
        super.onDestroy()
    }
}
