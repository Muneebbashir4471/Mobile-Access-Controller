package com.yourorg.agent

import android.app.KeyguardManager
import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Foreground service: holds the outbound WebSocket to the hub (hello, status every heartbeat,
 * reconnect 1 s doubling to 60 s), owns screen capture, and runs operator sessions.
 *
 * All state changes run on one thread ([loop]); callbacks from OkHttp and WebRTC hop onto it.
 */
class AgentService : Service() {

    companion object {
        const val CHANNEL_ID = "agent"
        private const val NOTIF_ID = 1
        private const val TAG = "AgentService"
        private const val MIN_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 60_000L
        private const val EXTRA_CONSENT = "capture_consent"
        private const val CONSENT_RETRY_MS = 60_000L
        // Retrying on a dark screen means waking it, so do that less often.
        private const val WAKE_RETRY_MS = 5 * 60_000L
        // Our own wake-up fires SCREEN_ON; don't let that trigger a second prompt.
        private const val PROMPT_GUARD_MS = 5_000L
        private const val FALLBACK_AFTER_MS = 20_000L

        @Volatile private var running: AgentService? = null

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, AgentService::class.java))
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, AgentService::class.java))
        }

        /** Called by [CaptureConsentActivity] with the MediaProjection consent result. */
        fun onCaptureConsent(ctx: Context, data: Intent) {
            ctx.startForegroundService(Intent(ctx, AgentService::class.java).putExtra(EXTRA_CONSENT, data))
        }

        /** Called by [InputService] when it connects or disconnects. */
        fun onReadinessChanged(@Suppress("UNUSED_PARAMETER") ctx: Context) {
            running?.let { svc -> svc.scope.launch { svc.onCaptureOrInputChanged() } }
        }
    }

    private val loop = Executors.newSingleThreadExecutor().asCoroutineDispatcher()
    val scope = CoroutineScope(SupervisorJob() + loop)
    private val http = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS) // detects dead mobile connections quickly
        .build()

    private lateinit var reporter: StatusReporter
    private lateinit var capture: CaptureManager
    private var creds: Credentials? = null
    @Volatile private var ws: WebSocket? = null
    private var online = false
    private var generation = 0
    private var backoffMs = MIN_BACKOFF_MS
    private var reconnectJob: Job? = null
    private var heartbeatJob: Job? = null
    private var fallbackJob: Job? = null
    private var heartbeatSeconds = 60
    private var video = JSONObject().put("width", 720).put("fps", 30).put("bitrate", 3_000_000)
    private val sessions = mutableMapOf<String, RtcSession>()
    private var lastConsentPrompt = 0L
    private var lastInputWarning = 0L
    private var screenWake: PowerManager.WakeLock? = null
    // Held for the whole service lifetime so the WebSocket and video survive screen-off / Doze.
    private var cpuWake: PowerManager.WakeLock? = null
    private var wifiLock: android.net.wifi.WifiManager.WifiLock? = null

    // Screen on/off and unlock change what the operator can do; report them straight away.
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val unlocked = intent.action == Intent.ACTION_USER_PRESENT ||
                (intent.action == Intent.ACTION_SCREEN_ON &&
                    !getSystemService(KeyguardManager::class.java).isKeyguardLocked)
            scope.launch {
                // A consent prompt cannot show on a dark or locked screen. The moment the phone is
                // usable again, retry right away instead of waiting for the next heartbeat.
                if (unlocked && ::capture.isInitialized && capture.mode != CaptureManager.Mode.PROJECTION) {
                    ensureCapture(force = true)
                }
                ws?.let { sendStatus(it) }
            }
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // Signal came back: skip the remaining backoff.
            scope.launch {
                if (ws == null && creds != null) {
                    backoffMs = MIN_BACKOFF_MS
                    connect()
                }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = this
        reporter = StatusReporter(this)
        goForeground("Starting…", withProjection = false)
        capture = CaptureManager(this) { scope.launch { onCaptureOrInputChanged() } }
        acquireKeepAlive()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(networkCallback)
        DeviceOwner.applyPolicies(this)
        ContextCompat.registerReceiver(this, screenReceiver, IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        @Suppress("DEPRECATION")
        val consent = intent?.getParcelableExtra<Intent>(EXTRA_CONSENT)
        scope.launch {
            val c = Prefs.credentials(this@AgentService)
            if (c == null) {
                AgentState.set(AgentState.Conn.UNPAIRED)
                stopSelf()
                return@launch
            }
            creds = c
            if (consent != null) {
                // Android 14 requires the mediaProjection service type before capture starts.
                goForeground(AgentState.detail.value.ifBlank { "Starting capture" }, withProjection = true)
                capture.startProjection(consent, video.optInt("width", 720), video.optInt("fps", 15))
            }
            if (ws == null) connect()
            ensureCapture()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = null
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(networkCallback) }
        runCatching { unregisterReceiver(screenReceiver) }
        screenWake?.let { if (it.isHeld) it.release() }
        cpuWake?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        sessions.values.forEach { it.close() }
        sessions.clear()
        ws?.close(1000, "service stopped")
        runCatching { capture.release() }
        scope.cancel()
        loop.close()
        AgentState.set(AgentState.Conn.STOPPED)
        super.onDestroy()
    }

    // Capture -------------------------------------------------------------------

    /**
     * Gets capture running without anyone at the phone: prompt for consent (InputService
     * presses the button), and if that has not worked after a while, use the 1 fps fallback.
     */
    private fun ensureCapture(force: Boolean = false) {
        if (capture.mode == CaptureManager.Mode.PROJECTION) return
        if (!CaptureConsentActivity.awaitingConsent) maybePromptForConsent(force)
        if (capture.mode == CaptureManager.Mode.NONE && fallbackJob?.isActive != true) {
            fallbackJob = scope.launch {
                delay(FALLBACK_AFTER_MS)
                if (capture.mode == CaptureManager.Mode.NONE) capture.startFallback(video.optInt("width", 720))
            }
        }
    }

    /**
     * Shows the capture consent dialog; InputService presses its confirm button. The dialog cannot
     * appear over a dark or locked screen, so the screen is woken first and a swipe lock dismissed.
     * A PIN/password lock has to wait until someone unlocks the phone (USER_PRESENT retries then).
     * [force] skips the retry interval, for when someone is at the phone or watching it.
     */
    private fun maybePromptForConsent(force: Boolean) {
        val km = getSystemService(KeyguardManager::class.java)
        val pm = getSystemService(PowerManager::class.java)
        if (km.isKeyguardLocked && km.isKeyguardSecure) return
        val needsWake = !pm.isInteractive || km.isKeyguardLocked
        val now = SystemClock.elapsedRealtime()
        if (now - lastConsentPrompt < PROMPT_GUARD_MS) return
        if (!force) {
            // Nobody could press the button on a dark screen without the accessibility service.
            if (needsWake && !InputService.isReady) return
            if (now - lastConsentPrompt < if (needsWake) WAKE_RETRY_MS else CONSENT_RETRY_MS) return
        }
        lastConsentPrompt = now
        if (needsWake) {
            WakeActivity.launch(this)
            scope.launch {
                delay(1_500) // let the screen come on and the swipe lock go away
                if (capture.mode != CaptureManager.Mode.PROJECTION && !CaptureConsentActivity.awaitingConsent) {
                    CaptureConsentActivity.launch(this@AgentService)
                }
            }
        } else {
            CaptureConsentActivity.launch(this)
        }
    }

    private fun onCaptureOrInputChanged() {
        AgentState.setCaptureReady(capture.isRunning)
        AgentState.setCaptureMode(capture.mode.name.lowercase())
        if (capture.mode == CaptureManager.Mode.NONE) {
            // Projection was stopped: the open session's track is dead, so end it cleanly.
            sessions.values.toList().forEach { it.end("screen capture stopped on the phone") }
            ensureCapture()
        } else if (capture.mode == CaptureManager.Mode.FALLBACK) {
            ensureCapture() // keep trying for full-rate capture
        }
        ws?.let { sendStatus(it) }
    }

    // Connection -----------------------------------------------------------------

    private fun connect() {
        val c = creds ?: return
        reconnectJob?.cancel()
        ws?.cancel()
        val gen = ++generation
        setState(AgentState.Conn.CONNECTING, "Connecting to ${c.serverUrl}")
        val req = Request.Builder()
            .url(c.agentWsUrl)
            .header("Authorization", "Bearer ${c.token}")
            .build()
        ws = http.newWebSocket(req, Listener(gen))
    }

    private inner class Listener(private val gen: Int) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            scope.launch { if (gen == generation) onConnected(webSocket) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            scope.launch {
                if (gen != generation) return@launch
                val msg = runCatching { JSONObject(text) }.getOrNull() ?: return@launch
                handle(webSocket, msg)
            }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            scope.launch { if (gen == generation) onDisconnected(code, reason) }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            // The hub refuses an unknown or revoked token before the upgrade (HTTP 403).
            val code = if (response?.code == 403 || response?.code == 401) 4401 else 0
            scope.launch { if (gen == generation) onDisconnected(code, t.message ?: "connection failed") }
        }
    }

    private fun onConnected(socket: WebSocket) {
        online = true
        backoffMs = MIN_BACKOFF_MS
        setState(AgentState.Conn.ONLINE, "Connected")
        socket.send(
            JSONObject()
                .put("type", "hello")
                .put("device_id", creds?.deviceId)
                .put("app_version", BuildConfig.VERSION_NAME)
                .put("android_version", Build.VERSION.RELEASE)
                .put("model", PairingClient.modelName)
                .toString()
        )
        sendStatus(socket)
        startHeartbeat(socket)
    }

    private fun onDisconnected(code: Int, reason: String) {
        Log.i(TAG, "disconnected code=$code reason=$reason")
        online = false
        ws = null
        heartbeatJob?.cancel()
        // The hub ends sessions when we drop; release ours too.
        sessions.values.forEach { it.close() }
        sessions.clear()
        updateScreenWake()
        // A rejected token is not cleared automatically: a server misconfiguration must never
        // force all phones to be paired again by hand. Keep retrying slowly instead.
        if (code == 4401) {
            backoffMs = MAX_BACKOFF_MS
            setState(AgentState.Conn.WAITING, "Server rejected this phone (revoked?). Retrying…")
        }
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        val wait = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        if (AgentState.conn.value != AgentState.Conn.WAITING) {
            setState(AgentState.Conn.WAITING, "Offline, retrying in ${wait / 1000}s")
        }
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(wait)
            connect()
        }
    }

    private fun startHeartbeat(socket: WebSocket) {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(heartbeatSeconds * 1000L)
                // Stuck without full-rate capture (prompt cancelled, projection stopped): try again,
                // but only while nobody is using the phone, so the prompt never covers a session.
                if (capture.mode != CaptureManager.Mode.PROJECTION && sessions.isEmpty()) ensureCapture()
                sendStatus(socket)
            }
        }
    }

    /** A small JPEG of the screen for the dashboard's phone grid. Skipped while the screen is off. */
    private fun sendThumb(socket: WebSocket, width: Int) {
        if (!getSystemService(PowerManager::class.java).isInteractive) return
        val svc = InputService.instance ?: return
        svc.thumbnail(width.coerceIn(120, 480)) { jpeg ->
            if (jpeg != null) {
                socket.send(
                    JSONObject().put("type", "thumb")
                        .put("jpeg", Base64.encodeToString(jpeg, Base64.NO_WRAP)).toString()
                )
            }
        }
    }

    private fun sendStatus(socket: WebSocket) {
        val msg = reporter.status(captureReady = capture.isRunning, inputReady = InputService.isReady)
            .put("capture_mode", capture.mode.name.lowercase())
        socket.send(msg.toString())
    }

    // Messages from the hub --------------------------------------------------------

    private fun handle(socket: WebSocket, msg: JSONObject) {
        val sid = msg.optString("session_id")
        when (msg.optString("type")) {
            "config" -> {
                heartbeatSeconds = msg.optInt("heartbeat_seconds", 60).coerceIn(10, 600)
                msg.optJSONObject("video")?.let {
                    video = it
                    capture.applySettings(it.optInt("width", 720), it.optInt("fps", 15))
                }
                if (online) startHeartbeat(socket)
            }
            "session_start" -> startSession(socket, sid, msg)
            "thumb_request" -> sendThumb(socket, msg.optInt("width", 270))
            "rtc_offer" -> sessions[sid]?.onOffer(msg.optString("sdp"))
            "ice" -> msg.optJSONObject("candidate")?.let { sessions[sid]?.onRemoteIce(it) }
            "session_stop" -> {
                sessions.remove(sid)?.close()
                updateScreenWake()
            }
            // Input over the WebSocket when the data channel is down.
            "input" -> if (sessions.containsKey(sid)) msg.optJSONObject("event")?.let(::onInput)
            else -> Log.d(TAG, "ignored message ${msg.optString("type")}")
        }
    }

    private fun startSession(socket: WebSocket, sid: String, msg: JSONObject) {
        // One viewer per phone: anything older is stale.
        sessions.values.forEach { it.close() }
        sessions.clear()
        if (!capture.isRunning) {
            ensureCapture()
            socket.send(
                JSONObject().put("type", "session_ended").put("session_id", sid)
                    .put("reason", "screen capture is not running on the phone yet").toString()
            )
            return
        }
        msg.optJSONObject("video")?.let { video = it }
        // Turn the screen on (over a swipe lock) so the operator sees the phone, not a black frame.
        WakeActivity.launch(this)
        if (capture.mode == CaptureManager.Mode.FALLBACK) {
            // Stuck at 1 fps: ask for capture again now. Both modes feed the same video track, so
            // the operator's view switches to live video without reconnecting.
            scope.launch {
                delay(1_500)
                ensureCapture(force = true)
            }
        }
        try {
            sessions[sid] = RtcSession(
                sessionId = sid,
                capture = capture,
                turn = msg.getJSONObject("turn"),
                video = video,
                send = { out -> ws?.send(out.toString()) },
                onInput = ::onInput,
                onEnded = { s, _ -> scope.launch { if (sessions[s.sessionId] === s) sessions.remove(s.sessionId); updateScreenWake() } },
            )
            updateScreenWake()
        } catch (e: Exception) {
            Log.e(TAG, "session start failed", e)
            socket.send(
                JSONObject().put("type", "session_ended").put("session_id", sid)
                    .put("reason", "could not start the stream on the phone").toString()
            )
        }
    }

    /** Called from WebRTC threads; hops onto [loop] so it can see the session. */
    private fun onInput(event: JSONObject) {
        scope.launch {
            val sid = sessions.keys.firstOrNull() ?: return@launch
            val input = InputService.instance
            if (input == null) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastInputWarning > 10_000) {
                    lastInputWarning = now
                    sendNotice(sid, "Taps and typing need the MT5 Agent accessibility service: turn it on on the phone.")
                }
                return@launch
            }
            input.handle(event) { message -> scope.launch { sendNotice(sid, message) } }
        }
    }

    private fun sendNotice(sid: String, message: String) {
        ws?.send(JSONObject().put("type", "notice").put("session_id", sid).put("message", message).toString())
    }

    /**
     * Keeps the CPU and Wi-Fi radio awake for the whole service lifetime. Without this the phone
     * enters Doze within seconds of the screen turning off, the radio powers down, and both the
     * WebSocket and the live video die — the "disconnects when locked" symptom. The screen itself
     * is allowed to turn off (that is fine; the stream keeps flowing), so this costs little battery
     * on a charger.
     */
    @Suppress("DEPRECATION") // WifiLock HIGH_PERF is deprecated but is still the only way to pin the radio
    private fun acquireKeepAlive() {
        if (cpuWake?.isHeld != true) {
            cpuWake = getSystemService(PowerManager::class.java)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "mt5agent:keepalive")
                .also { it.setReferenceCounted(false); runCatching { it.acquire() } }
        }
        if (wifiLock?.isHeld != true) {
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                android.net.wifi.WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF
            wifiLock = getSystemService(android.net.wifi.WifiManager::class.java)
                .createWifiLock(mode, "mt5agent:keepalive")
                .also { it.setReferenceCounted(false); runCatching { it.acquire() } }
        }
    }

    /** Keeps the screen on while an operator is connected, so it cannot sleep mid-trade. */
    @Suppress("DEPRECATION") // SCREEN_BRIGHT_WAKE_LOCK: the only way a service can hold the screen on
    private fun updateScreenWake() {
        val want = sessions.isNotEmpty()
        val lock = screenWake ?: getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK, "mt5agent:session")
            .also { it.setReferenceCounted(false); screenWake = it }
        if (want && !lock.isHeld) lock.acquire(4 * 3600_000L) else if (!want && lock.isHeld) lock.release()
    }

    // Notification -------------------------------------------------------------

    private fun setState(state: AgentState.Conn, detail: String) {
        AgentState.set(state, detail)
        if (NotificationManagerCompat.from(this).areNotificationsEnabled()) {
            runCatching { NotificationManagerCompat.from(this).notify(NOTIF_ID, notification(detail)) }
        }
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, PairingActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("${getString(R.string.app_name)} ${BuildConfig.VERSION_NAME}")
            .setContentText(text)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setPriority(NotificationCompat.PRIORITY_MIN) // pre-Android 8 equivalent of IMPORTANCE_MIN
            .setContentIntent(open)
            .build()
    }

    private fun goForeground(text: String, withProjection: Boolean) {
        val n = notification(text)
        val type = when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE or
                    (if (withProjection) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION else 0)
            withProjection -> ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            else -> -1
        }
        if (type == -1) startForeground(NOTIF_ID, n) else startForeground(NOTIF_ID, n, type)
    }
}
