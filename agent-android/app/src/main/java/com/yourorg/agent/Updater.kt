package com.yourorg.agent

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Checks the server for a newer agent APK, verifies its SHA-256 and installs it with
 * PackageInstaller. As device owner the install is silent; otherwise Android asks at the phone.
 * After the update, BootReceiver (MY_PACKAGE_REPLACED) restarts the service.
 */
object Updater {
    private const val TAG = "Updater"
    private val http = OkHttpClient.Builder().callTimeout(10, TimeUnit.MINUTES).build()

    /** Returns a short description of what happened. */
    suspend fun checkAndInstall(ctx: Context, creds: Credentials): String = withContext(Dispatchers.IO) {
        val auth = "Bearer ${creds.token}"
        val base = creds.serverUrl.trimEnd('/')
        val latest = http.newCall(Request.Builder().url("$base/api/agent/latest").header("Authorization", auth).build())
            .execute().use { res ->
                if (res.code == 204) return@withContext "no release published"
                if (!res.isSuccessful) return@withContext "check failed: HTTP ${res.code}"
                JSONObject(res.body!!.string())
            }
        val code = latest.getInt("version_code")
        if (code <= BuildConfig.VERSION_CODE) return@withContext "up to date (${BuildConfig.VERSION_NAME})"

        val apk = File(ctx.cacheDir, "agent-update.apk")
        http.newCall(Request.Builder().url(base + latest.getString("url")).header("Authorization", auth).build())
            .execute().use { res ->
                if (!res.isSuccessful) return@withContext "download failed: HTTP ${res.code}"
                apk.outputStream().use { out -> res.body!!.byteStream().copyTo(out) }
            }
        val sha = MessageDigest.getInstance("SHA-256").digest(apk.readBytes()).joinToString("") { "%02x".format(it) }
        if (!sha.equals(latest.getString("sha256"), ignoreCase = true)) {
            apk.delete()
            return@withContext "checksum mismatch, update refused"
        }
        install(ctx, apk)
        "installing ${latest.optString("version_name")} (code $code)"
    }

    private fun install(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
            setAppPackageName(ctx.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("agent.apk", 0, apk.length()).use { out ->
                apk.inputStream().use { it.copyTo(out) }
                session.fsync(out)
            }
            val result = PendingIntent.getBroadcast(
                ctx, id, Intent(ctx, InstallResultReceiver::class.java),
                PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            session.commit(result.intentSender)
        }
        Log.i(TAG, "install session $id committed")
    }
}

class InstallResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Not device owner: Android wants someone at the phone to confirm.
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { runCatching { context.startActivity(it) } }
            }
            PackageInstaller.STATUS_SUCCESS -> Log.i("Updater", "update installed")
            else -> Log.w("Updater", "update failed: $status ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
        }
    }
}
