package com.yourorg.agent

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Pairing result, stored encrypted with a hardware-backed key. */
data class Credentials(val serverUrl: String, val deviceId: String, val token: String) {
    /** https://host → wss://host/ws/agent (http → ws for development servers). */
    val agentWsUrl: String
        get() = serverUrl.trimEnd('/').replaceFirst(Regex("^http"), "ws") + "/ws/agent"
}

object Prefs {
    private const val FILE = "agent_secure"
    @Volatile private var prefs: SharedPreferences? = null

    private fun get(ctx: Context): SharedPreferences = prefs ?: synchronized(this) {
        prefs ?: run {
            val key = MasterKey.Builder(ctx).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            EncryptedSharedPreferences.create(
                ctx, FILE, key,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ).also { prefs = it }
        }
    }

    fun credentials(ctx: Context): Credentials? {
        val p = get(ctx)
        val server = p.getString("server", null) ?: return null
        val id = p.getString("device_id", null) ?: return null
        val token = p.getString("token", null) ?: return null
        return Credentials(server, id, token)
    }

    fun save(ctx: Context, c: Credentials) {
        get(ctx).edit()
            .putString("server", c.serverUrl)
            .putString("device_id", c.deviceId)
            .putString("token", c.token)
            .apply()
    }

    fun clear(ctx: Context) {
        get(ctx).edit().clear().apply()
    }


    fun rememberServer(ctx: Context, url: String) = get(ctx).edit().putString("last_server", url).apply()
    fun lastServer(ctx: Context): String? = get(ctx).getString("last_server", null)
}
