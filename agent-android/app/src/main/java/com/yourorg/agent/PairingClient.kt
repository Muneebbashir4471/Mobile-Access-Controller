package com.yourorg.agent

import android.os.Build
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

object PairingClient {
    private val http = OkHttpClient.Builder().callTimeout(20, TimeUnit.SECONDS).build()

    val modelName: String
        get() {
            val maker = Build.MANUFACTURER.replaceFirstChar { it.uppercase() }
            return if (Build.MODEL.startsWith(maker, ignoreCase = true)) Build.MODEL else "$maker ${Build.MODEL}"
        }

    /** Exchanges a one-time pairing code for a device id and token (POST /api/devices/pair). */
    suspend fun pair(serverUrl: String, code: String): Credentials = withContext(Dispatchers.IO) {
        val server = serverUrl.trim().trimEnd('/')
        val body = JSONObject()
            .put("code", code.trim())
            .put("model", modelName)
            .put("android_version", Build.VERSION.RELEASE)
            .put("app_version", BuildConfig.VERSION_NAME)
            .toString()
            .toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$server/api/devices/pair").post(body).build()
        http.newCall(req).execute().use { res ->
            val text = res.body?.string().orEmpty()
            if (!res.isSuccessful) {
                val detail = runCatching { JSONObject(text).optString("detail") }.getOrNull()
                throw IllegalStateException(detail?.takeIf { it.isNotBlank() } ?: "Pairing failed (HTTP ${res.code})")
            }
            val json = JSONObject(text)
            Credentials(server, json.getString("device_id"), json.getString("token"))
        }
    }
}
