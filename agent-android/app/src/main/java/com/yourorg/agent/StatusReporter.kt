package com.yourorg.agent

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.telephony.TelephonyManager
import org.json.JSONObject

/** Builds the 60-second `status` message: battery, signal, carrier and network type. */
class StatusReporter(private val ctx: Context) {
    private val battery = ctx.getSystemService(BatteryManager::class.java)
    private val telephony = ctx.getSystemService(TelephonyManager::class.java)
    private val connectivity = ctx.getSystemService(ConnectivityManager::class.java)
    private val power = ctx.getSystemService(android.os.PowerManager::class.java)
    private val keyguard = ctx.getSystemService(android.app.KeyguardManager::class.java)

    fun status(captureReady: Boolean, inputReady: Boolean): JSONObject = JSONObject()
        .put("type", "status")
        .put("battery", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
        .put("charging", battery.isCharging)
        .put("signal", signalDbm() ?: JSONObject.NULL)
        .put("carrier", carrier() ?: JSONObject.NULL)
        .put("network_type", networkType())
        .put("capture_ready", captureReady)
        .put("input_ready", inputReady)
        .put("screen_on", power.isInteractive)
        .put("locked", keyguard.isKeyguardLocked)

    private fun signalDbm(): Int? = try {
        telephony.signalStrength?.cellSignalStrengths
            ?.map { it.dbm }
            ?.firstOrNull { it != Int.MAX_VALUE && it != Int.MIN_VALUE }
    } catch (e: SecurityException) {
        null
    }

    private fun carrier(): String? =
        telephony.networkOperatorName?.takeIf { it.isNotBlank() }
            ?: telephony.simOperatorName?.takeIf { it.isNotBlank() }

    /** "none", "wifi", or the cellular generation ("LTE", "5G", "3G", "2G", or "cellular"). */
    fun networkType(): String {
        val caps = connectivity.activeNetwork?.let { connectivity.getNetworkCapabilities(it) } ?: return "none"
        if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return "none"
        if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return "wifi"
        if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) return "other"
        if (ctx.checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return "cellular"
        }
        return try {
            when (telephony.dataNetworkType) {
                TelephonyManager.NETWORK_TYPE_NR -> "5G"
                TelephonyManager.NETWORK_TYPE_LTE, TelephonyManager.NETWORK_TYPE_IWLAN -> "LTE"
                TelephonyManager.NETWORK_TYPE_HSPAP, TelephonyManager.NETWORK_TYPE_HSPA,
                TelephonyManager.NETWORK_TYPE_HSDPA, TelephonyManager.NETWORK_TYPE_HSUPA,
                TelephonyManager.NETWORK_TYPE_UMTS, TelephonyManager.NETWORK_TYPE_EVDO_0,
                TelephonyManager.NETWORK_TYPE_EVDO_A, TelephonyManager.NETWORK_TYPE_EVDO_B,
                TelephonyManager.NETWORK_TYPE_TD_SCDMA -> "3G"
                TelephonyManager.NETWORK_TYPE_EDGE, TelephonyManager.NETWORK_TYPE_GPRS,
                TelephonyManager.NETWORK_TYPE_GSM, TelephonyManager.NETWORK_TYPE_CDMA,
                TelephonyManager.NETWORK_TYPE_1xRTT -> "2G"
                else -> "cellular"
            }
        } catch (e: SecurityException) {
            "cellular"
        }
    }
}
