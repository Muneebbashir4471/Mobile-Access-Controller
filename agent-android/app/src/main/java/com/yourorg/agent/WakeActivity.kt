package com.yourorg.agent

import android.app.Activity
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.WindowManager

/**
 * Invisible activity that turns the screen on over the lock screen and asks Android to dismiss
 * the keyguard. A swipe-only lock is dismissed outright; a PIN/password lock shows its entry pad,
 * which [InputService] then fills in. Finishes itself once done.
 *
 * Starting it from the background is allowed because the accessibility service is bound
 * (and for device owners).
 */
class WakeActivity : Activity() {

    companion object {
        private const val TAG = "WakeActivity"

        fun launch(ctx: Context) {
            val i = Intent(ctx, WakeActivity::class.java).addFlags(
                Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION or
                    Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS
            )
            runCatching { ctx.startActivity(i) }.onFailure { Log.w(TAG, "could not start", it) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val km = getSystemService(KeyguardManager::class.java)
        if (km.isKeyguardLocked) {
            km.requestDismissKeyguard(this, object : KeyguardManager.KeyguardDismissCallback() {
                override fun onDismissSucceeded() = finish()
                override fun onDismissCancelled() = finish()
                override fun onDismissError() = finish()
            })
            // The PIN pad stays up while this activity lives; give the operator time to unlock.
            window.decorView.postDelayed({ if (!isFinishing) finish() }, 30_000)
        } else {
            window.decorView.postDelayed({ finish() }, 500)
        }
    }
}
