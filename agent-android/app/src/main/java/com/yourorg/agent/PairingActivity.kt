package com.yourorg.agent

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Setup screen. Unpaired: scan the admin's QR or type the server address and code.
 * Paired: shows the connection state and the remaining setup steps from the checklist.
 */
class PairingActivity : AppCompatActivity() {

    private lateinit var root: LinearLayout
    private lateinit var stateText: TextView

    private val scanQr = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { res ->
        val raw = res.data?.getStringExtra(QrScanActivity.EXTRA_QR) ?: return@registerForActivityResult
        val json = runCatching { JSONObject(raw) }.getOrNull()
        val server = json?.optString("server").orEmpty()
        val code = json?.optString("code").orEmpty()
        if (server.isBlank() || code.isBlank()) {
            showError("That QR is not a pairing code.")
        } else {
            doPair(server, code)
        }
    }

    private val askPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        render()
    }

    private var errorText: TextView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(24), dp(20), dp(24))
        }
        setContentView(ScrollView(this).apply { addView(root) })
        stateText = TextView(this)

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(AgentState.conn, AgentState.detail) { _, _ -> describeState() }.collect { stateText.text = it }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        render() // permissions may have changed in Settings
        pairFromIntent()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
    }

    /** Provisioning over adb: am start -n …/.PairingActivity --es server URL --es code CODE */
    private fun pairFromIntent() {
        val server = intent?.getStringExtra("server") ?: return
        val code = intent?.getStringExtra("code") ?: return
        intent?.removeExtra("server")
        intent?.removeExtra("code")
        if (Prefs.credentials(this) == null) doPair(server, code)
    }

    private fun render() {
        root.removeAllViews()
        title(getString(R.string.app_name))
        text("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})").apply { textSize = 13f; alpha = 0.7f }
        val creds = Prefs.credentials(this)
        if (creds == null) renderUnpaired() else renderPaired(creds)
    }

    // Unpaired --------------------------------------------------------------------

    private fun renderUnpaired() {
        text("Ask an admin for a pairing QR on the dashboard's Devices page.")
        button("Scan pairing QR") { scanQr.launch(Intent(this, QrScanActivity::class.java)) }

        text("\nOr type it in:")
        val server = EditText(this).apply {
            hint = "Server address, e.g. https://phones.example.com"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
            setText(Prefs.lastServer(this@PairingActivity) ?: "https://")
        }
        val code = EditText(this).apply {
            hint = "Pairing code"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
        }
        root.addView(server)
        root.addView(code)
        button("Pair") { doPair(server.text.toString(), code.text.toString()) }
        errorText = text("").apply { setTextColor(0xFFC62828.toInt()) }
    }

    private fun doPair(server: String, code: String) {
        if (!server.startsWith("https://") && !(BuildConfig.DEBUG && server.startsWith("http://"))) {
            showError("The server address must start with https://")
            return
        }
        Prefs.rememberServer(this, server.trim())
        showError("Pairing…")
        lifecycleScope.launch {
            try {
                val creds = PairingClient.pair(server, code)
                Prefs.save(this@PairingActivity, creds)
                AgentService.start(this@PairingActivity)
                render()
            } catch (e: Exception) {
                showError(e.message ?: "Pairing failed")
            }
        }
    }

    private fun showError(msg: String) {
        errorText?.text = msg
    }

    // Paired ----------------------------------------------------------------------

    private fun renderPaired(creds: Credentials) {
        AgentService.start(this) // idempotent; makes sure it runs after an install or force-stop
        text("Server: ${creds.serverUrl}")
        text("Device: ${creds.deviceId.take(8)}")
        root.addView(stateText.also { (it.parent as? LinearLayout)?.removeView(it); it.text = describeState() })

        text("\nSetup checklist").apply { textSize = 18f }
        step("Notifications allowed", notificationsAllowed()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                askPermissions.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
            }
        }
        step("Exempt from battery optimisation", batteryExempt()) { requestBatteryExemption() }
        step("Phone state (shows LTE/5G on the dashboard)", hasPermission(Manifest.permission.READ_PHONE_STATE)) {
            askPermissions.launch(arrayOf(Manifest.permission.READ_PHONE_STATE))
        }
        step("Device owner (blocks updates and removal)", DeviceOwner.isOwner(this)) {
            AlertDialog.Builder(this)
                .setMessage("Run once from a computer on a factory-reset phone with no accounts:\n\n" +
                    "adb shell dpm set-device-owner com.yourorg.agent/.AdminReceiver\n\n" +
                    "or use deploy/provision-phone.sh, which does every setup step.")
                .setPositiveButton("OK", null).show()
        }
        step("Accessibility service (remote input)", InputService.isReady) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        step("Screen capture running", captureReady()) {
            CaptureConsentActivity.launch(this)
        }
        text(
            "Also: allow autostart on Xiaomi, Oppo and Vivo; turn off the screen lock; keep the " +
                "screen on while charging; turn off automatic system and MT5 updates."
        ).apply { textSize = 13f }

        text("")
        button("Unpair this phone") { confirmUnpair() }
    }

    private fun describeState(): String {
        val label = when (AgentState.conn.value) {
            AgentState.Conn.ONLINE -> "● Online"
            AgentState.Conn.CONNECTING -> "◌ Connecting"
            AgentState.Conn.WAITING -> "○ Offline"
            AgentState.Conn.STOPPED -> "○ Stopped"
            AgentState.Conn.UNPAIRED -> "○ Not paired"
        }
        val detail = AgentState.detail.value
        return if (detail.isBlank()) label else "$label — $detail"
    }

    private fun confirmUnpair() {
        AlertDialog.Builder(this)
            .setTitle("Unpair this phone?")
            .setMessage("It disconnects from the server and must be paired again with a new code.")
            .setPositiveButton("Unpair") { _, _ ->
                AgentService.stop(this)
                Prefs.clear(this)
                render()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    /** Read from the status the service last sent; good enough for a checklist tick. */
    private fun captureReady() = AgentState.captureReady.value

    private fun notificationsAllowed() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPermission(Manifest.permission.POST_NOTIFICATIONS)

    private fun batteryExempt() =
        getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)

    @SuppressLint("BatteryLife") // dedicated device; staying alive is the whole point
    private fun requestBatteryExemption() {
        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
    }

    private fun hasPermission(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    // Tiny view helpers -------------------------------------------------------------

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun title(s: String) = text(s).apply { textSize = 22f; setPadding(0, 0, 0, dp(12)) }

    private fun text(s: String): TextView = TextView(this).apply {
        text = s
        textSize = 15f
        setPadding(0, dp(4), 0, dp(4))
        root.addView(this)
    }

    private fun button(label: String, onClick: () -> Unit): Button = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
        root.addView(this)
    }

    private fun step(label: String, done: Boolean, fix: () -> Unit) {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(TextView(this).apply {
            text = (if (done) "✓ " else "✗ ") + label
            textSize = 15f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        })
        row.addView(Button(this).apply {
            text = "Fix"
            visibility = if (done) View.GONE else View.VISIBLE
            setOnClickListener { fix() }
        })
        root.addView(row)
    }
}
