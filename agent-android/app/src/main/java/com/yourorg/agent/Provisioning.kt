package com.yourorg.agent

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.PersistableBundle
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.io.IOException

/**
 * Device Owner setup from the dashboard's QR code. A factory-reset phone scans the QR, Android
 * downloads this app, makes it device owner and hands over the QR's extras bundle
 * ({"server", "code"}). The app then pairs itself with that one-time code, so the phone comes up
 * already connected. Only the Accessibility service still has to be turned on by hand.
 */
object Provisioning {
    private const val TAG = "Provisioning"
    private const val MAX_ATTEMPTS = 40
    private const val RETRY_MS = 15_000L

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    @Volatile private var pairing = false

    @Suppress("DEPRECATION")
    fun extrasOf(intent: Intent?): PersistableBundle? =
        intent?.getParcelableExtra(DevicePolicyManager.EXTRA_PROVISIONING_ADMIN_EXTRAS_BUNDLE)

    /** Keeps the server and code from the setup QR, then pairs in the background. */
    fun start(ctx: Context, extras: PersistableBundle?) {
        val app = ctx.applicationContext
        val server = extras?.getString("server")?.trim()?.takeIf { it.isNotEmpty() }
        val code = extras?.getString("code")?.trim()?.takeIf { it.isNotEmpty() }
        scope.launch {
            if (server != null && code != null && Prefs.credentials(app) == null) {
                Prefs.savePendingPairing(app, server, code)
            }
            resumeNow(app)
        }
    }

    /** Called on every app start: finishes a setup-QR pairing that did not complete yet. */
    fun resume(ctx: Context) {
        val app = ctx.applicationContext
        scope.launch { resumeNow(app) }
    }

    private suspend fun resumeNow(app: Context) {
        if (Prefs.credentials(app) != null) {
            Prefs.clearPendingPairing(app)
            return
        }
        val (server, code) = Prefs.pendingPairing(app) ?: return
        if (pairing) return
        pairing = true
        try {
            var refused = 0
            for (attempt in 1..MAX_ATTEMPTS) {
                try {
                    val creds = PairingClient.pair(server, code)
                    Prefs.save(app, creds)
                    Prefs.clearPendingPairing(app)
                    Log.i(TAG, "paired from the setup QR")
                    DeviceOwner.applyPolicies(app)
                    AgentService.start(app)
                    return
                } catch (e: IOException) {
                    Log.w(TAG, "pairing attempt $attempt: no connection yet (${e.message})")
                } catch (e: Exception) {
                    // The server answered with an error. A used or expired code will not start
                    // working, so give up after a few tries; the phone can still be paired by hand.
                    Log.w(TAG, "pairing attempt $attempt refused: ${e.message}")
                    if (++refused >= 3) {
                        Prefs.clearPendingPairing(app)
                        return
                    }
                }
                delay(RETRY_MS)
            }
        } finally {
            pairing = false
        }
    }
}

/** Android 12+: asked during QR setup which mode to use. Always a fully managed (owned) phone. */
class ProvisioningModeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Provisioning.start(this, Provisioning.extrasOf(intent))
        val result = Intent().putExtra(
            DevicePolicyManager.EXTRA_PROVISIONING_MODE,
            DevicePolicyManager.PROVISIONING_MODE_FULLY_MANAGED_DEVICE,
        )
        setResult(RESULT_OK, result)
        finish()
    }
}

/** Android 12+: last step of QR setup. Applies the owner policies and starts pairing. */
class PolicyComplianceActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        DeviceOwner.applyPolicies(this)
        Provisioning.start(this, Provisioning.extrasOf(intent))
        setResult(RESULT_OK)
        finish()
    }
}
