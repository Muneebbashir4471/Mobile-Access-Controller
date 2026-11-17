package com.yourorg.agent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

/**
 * Replays the operator's input: taps, swipes and long presses with dispatchGesture, text with
 * ACTION_SET_TEXT, and Back / Home / Recents with performGlobalAction.
 *
 * It also presses the confirm button on the screen capture consent dialog while
 * [CaptureConsentActivity] is waiting, so a rebooted phone needs no one at the phone.
 */
class InputService : AccessibilityService() {

    companion object {
        private const val TAG = "InputService"

        @Volatile var instance: InputService? = null
            private set

        val isReady: Boolean get() = instance != null

        /** Confirm-button labels on the consent dialog, by Android version and language. */
        private val CONSENT_BUTTONS = listOf(
            "Start now", "Start", "Share screen", "Start recording or casting", "Next",
            "立即开始", "开始", "Iniciar ahora", "Démarrer", "Jetzt starten", "Avvia ora",
            "ابدأ الآن", "ابھی شروع کریں",
        )
    }

    private val main = Handler(Looper.getMainLooper())

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        Log.i(TAG, "connected")
        AgentService.onReadinessChanged(this)
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        AgentService.onReadinessChanged(this)
        return super.onUnbind(intent)
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onInterrupt() = Unit

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (!CaptureConsentActivity.awaitingConsent) return
        if (event.packageName?.toString() != "com.android.systemui") return
        watchForConsent()
    }

    private var consentWatch = false

    /**
     * Presses the consent dialog's confirm button. The dialog's buttons are often not readable at
     * the moment its window appears, so this keeps looking for a few seconds instead of once.
     * Also started directly by [CaptureConsentActivity], so it does not depend on events.
     */
    fun watchForConsent() {
        main.post {
            if (consentWatch) return@post
            consentWatch = true
            tryAcceptConsent(0)
        }
    }

    private fun tryAcceptConsent(attempt: Int) {
        if (!CaptureConsentActivity.awaitingConsent || acceptConsentDialog() || attempt >= 20) {
            consentWatch = false
            return
        }
        main.postDelayed({ tryAcceptConsent(attempt + 1) }, 250)
    }

    /** Returns true once the confirm button was pressed. */
    private fun acceptConsentDialog(): Boolean {
        val roots = (windows.mapNotNull { it.root } + listOfNotNull(rootInActiveWindow))
            .filter { it.packageName?.toString() == "com.android.systemui" }
            .distinct()
        // Android 14+: the dialog may first offer "single app" vs "entire screen"; the consent
        // intent already asks for the whole display, so only the confirm button is pressed.
        for (root in roots) {
            for (label in CONSENT_BUTTONS) {
                val node = root.findAccessibilityNodeInfosByText(label)
                    .firstOrNull { it.isClickable && it.isEnabled && it.text?.toString().equals(label, ignoreCase = true) }
                    ?: continue
                Log.i(TAG, "pressing consent button '$label'")
                return node.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            // Some skins label it differently; the positive dialog button is android:id/button1.
            root.findAccessibilityNodeInfosByViewId("android:id/button1").firstOrNull { it.isEnabled }?.let {
                Log.i(TAG, "pressing consent button android:id/button1")
                return it.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
        }
        return false
    }

    // Input events --------------------------------------------------------------

    /** Handles one data-channel event. Safe to call from any thread. [reply] sends a short
     *  message back to the operator's control view. */
    fun handle(ev: JSONObject, reply: (String) -> Unit = {}) {
        main.post {
            try {
                when (ev.optString("type")) {
                    "wake" -> {
                        WakeActivity.launch(this)
                        reply(if (keyguard().isKeyguardSecure && keyguard().isKeyguardLocked)
                            "Screen on. This phone has a PIN/password lock: enter it under Unlock."
                            else "Screen on.")
                    }
                    "unlock" -> unlock(ev.optString("secret"), reply)
                    "lock" -> {
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                            performGlobalAction(GLOBAL_ACTION_LOCK_SCREEN)
                            reply("Screen locked.")
                        } else reply("Locking needs Android 9 or newer.")
                    }
                    "tap" -> gesture(stroke(ev.getDouble("x"), ev.getDouble("y")), 50)
                    "long_press" -> gesture(
                        stroke(ev.getDouble("x"), ev.getDouble("y")),
                        ev.optLong("duration_ms", 600).coerceIn(500, 3000),
                    )
                    "swipe" -> gesture(
                        stroke(ev.getDouble("x1"), ev.getDouble("y1"), ev.getDouble("x2"), ev.getDouble("y2")),
                        ev.optLong("duration_ms", 300).coerceIn(50, 3000),
                    )
                    "text" -> typeText(ev.optString("value"))
                    "key" -> key(ev.optString("name"))
                    else -> Log.d(TAG, "unknown input ${ev.optString("type")}")
                }
            } catch (e: Exception) {
                Log.w(TAG, "bad input event $ev", e)
            }
        }
    }

    // Wake and unlock ---------------------------------------------------------------

    private fun keyguard() = getSystemService(android.app.KeyguardManager::class.java)

    /**
     * Wakes the screen and unlocks it. A swipe lock is dismissed by [WakeActivity]; for a PIN or
     * password the lock screen's own keys are pressed through accessibility. Pattern locks cannot
     * be entered this way. The secret is used once and never stored.
     */
    private fun unlock(secret: String, reply: (String) -> Unit) {
        val km = keyguard()
        WakeActivity.launch(this)
        if (!km.isKeyguardLocked) {
            reply("The phone is not locked.")
            return
        }
        if (!km.isKeyguardSecure) {
            main.postDelayed({ reply(if (km.isKeyguardLocked) "Could not dismiss the lock screen." else "Unlocked.") }, 1500)
            return
        }
        if (secret.isEmpty()) {
            reply("This phone has a PIN/password lock: type it in the Unlock box.")
            return
        }
        main.postDelayed({ enterSecret(secret, reply, attempt = 0) }, 900)
    }

    private fun lockRoots(): List<AccessibilityNodeInfo> =
        (windows.mapNotNull { it.root } + listOfNotNull(rootInActiveWindow)).distinct()

    private fun findNode(root: AccessibilityNodeInfo, match: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        if (match(root)) return root
        for (i in 0 until root.childCount) {
            val child = root.getChild(i) ?: continue
            findNode(child, match)?.let { return it }
        }
        return null
    }

    private fun clickable(node: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
        var n = node
        while (n != null && !n.isClickable) n = n.parent
        return n
    }

    /** The PIN pad key for one digit: a node whose text or description is the digit (or "2 ABC"). */
    private fun pinKey(roots: List<AccessibilityNodeInfo>, digit: Char): AccessibilityNodeInfo? {
        val d = digit.toString()
        fun labelMatches(cs: CharSequence?): Boolean {
            val t = cs?.toString()?.trim() ?: return false
            return t == d || t.startsWith("$d ") || t.startsWith("$d,")
        }
        for (r in roots) {
            val hit = findNode(r) { labelMatches(it.text) || labelMatches(it.contentDescription) }
            clickable(hit)?.let { return it }
        }
        return null
    }

    private fun enterSecret(secret: String, reply: (String) -> Unit, attempt: Int) {
        val km = keyguard()
        if (!km.isKeyguardLocked) {
            reply("Unlocked.")
            return
        }
        val roots = lockRoots()

        // Password lock: a password field on the bouncer.
        val field = roots.firstNotNullOfOrNull { r -> findNode(r) { it.isPassword && it.isEditable } }
        if (field != null) {
            setText(field, secret)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
            }
            checkUnlocked(reply)
            return
        }

        // PIN lock: press each digit, then Enter if the pad has one.
        if (secret.all { it.isDigit() }) {
            val keys = secret.map { pinKey(roots, it) }
            if (keys.all { it != null }) {
                keys.forEachIndexed { i, key ->
                    main.postDelayed({ key!!.performAction(AccessibilityNodeInfo.ACTION_CLICK) }, i * 150L)
                }
                main.postDelayed({
                    val enter = lockRoots().firstNotNullOfOrNull { r ->
                        clickable(findNode(r) {
                            val id = it.viewIdResourceName.orEmpty()
                            val desc = it.contentDescription?.toString().orEmpty()
                            id.endsWith("key_enter") || desc.equals("Enter", true) || desc.equals("OK", true)
                        })
                    }
                    enter?.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                    checkUnlocked(reply)
                }, secret.length * 150L + 200)
                return
            }
        }

        // Pad not visible yet: swipe up once to bring it up, then look again.
        if (attempt < 3) {
            if (attempt == 1) gesture(stroke(0.5, 0.85, 0.5, 0.3), 250)
            main.postDelayed({ enterSecret(secret, reply, attempt + 1) }, 800)
        } else {
            reply("Could not find the PIN/password entry on this lock screen. Pattern locks cannot be unlocked remotely.")
        }
    }

    private fun checkUnlocked(reply: (String) -> Unit) {
        main.postDelayed({
            reply(if (keyguard().isKeyguardLocked) "Still locked: wrong PIN/password?" else "Unlocked.")
        }, 1500)
    }

    private fun screenSize(): Pair<Int, Int> {
        val m = DisplayMetrics()
        @Suppress("DEPRECATION")
        getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(m)
        return m.widthPixels to m.heightPixels
    }

    /** Fractions (0–1) of the screen to a path in pixels. */
    private fun stroke(vararg fractions: Double): Path {
        val (w, h) = screenSize()
        fun px(f: Double, size: Int) = (f.coerceIn(0.0, 1.0) * (size - 1)).toFloat()
        return Path().apply {
            moveTo(px(fractions[0], w), px(fractions[1], h))
            if (fractions.size >= 4) lineTo(px(fractions[2], w), px(fractions[3], h))
        }
    }

    private fun gesture(path: Path, durationMs: Long) {
        val g = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, durationMs))
            .build()
        dispatchGesture(g, null, null)
    }

    private fun focusedField(): AccessibilityNodeInfo? =
        rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)

    /**
     * Appends to the focused field (or fills it if it only shows a hint). ACTION_SET_TEXT
     * replaces the whole value, which is more reliable than key-by-key entry.
     */
    private fun typeText(value: String) {
        val node = focusedField() ?: run { Log.d(TAG, "no focused field for text"); return }
        val current = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
        setText(node, current + value)
    }

    private fun setText(node: AccessibilityNodeInfo, text: String) {
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun key(name: String) {
        when (name) {
            "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
            "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
            "recents" -> performGlobalAction(GLOBAL_ACTION_RECENTS)
            "delete" -> focusedField()?.let { node ->
                if (!node.isShowingHintText) {
                    val t = node.text?.toString().orEmpty()
                    if (t.isNotEmpty()) setText(node, t.dropLast(1))
                }
            }
            "enter" -> focusedField()?.let { node ->
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
                }
            }
        }
    }
}
