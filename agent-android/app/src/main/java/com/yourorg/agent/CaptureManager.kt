package com.yourorg.agent

import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjection
import android.os.Build
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.PeerConnectionFactory
import org.webrtc.ScreenCapturerAndroid
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Captures the whole screen into one WebRTC video track, shared by every session.
 *
 * Mode PROJECTION: MediaProjection at full frame rate. Started once when consent arrives and kept
 * alive while the service runs, because Android 14+ asks for consent again for each new session.
 * Mode FALLBACK: one accessibility screenshot per second, no consent needed (Android 11+).
 *
 * With no operator connected the track is attached to no peer connection, so nothing is encoded.
 */
class CaptureManager(
    private val ctx: Context,
    private val onStateChanged: () -> Unit,
) {
    enum class Mode { NONE, PROJECTION, FALLBACK }

    companion object {
        private const val TAG = "CaptureManager"
    }

    val egl: EglBase = EglBase.create()
    val factory: PeerConnectionFactory

    private var projection: ScreenCapturerAndroid? = null
    private var fallback: ScreenshotCapturer? = null
    private var helper: SurfaceTextureHelper? = null
    private var source: VideoSource? = null
    var track: VideoTrack? = null
        private set

    @Volatile var mode = Mode.NONE
        private set

    val isRunning: Boolean get() = mode != Mode.NONE

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(ctx.applicationContext).createInitializationOptions()
        )
        // Hardware H.264 or VP8, whichever the phone supports; software VP8 as the fallback.
        factory = PeerConnectionFactory.builder()
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(egl.eglBaseContext, true, false))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(egl.eglBaseContext))
            .createPeerConnectionFactory()
    }

    private fun ensureTrack(): VideoSource {
        source?.let { return it }
        val src = factory.createVideoSource(/* isScreencast = */ true)
        source = src
        track = factory.createVideoTrack("screen", src)
        return src
    }

    /** Starts MediaProjection capture. Call only after the foreground service has been promoted
     *  to type mediaProjection. Replaces fallback mode if it was running. */
    fun startProjection(consentData: Intent, shortSide: Int, fps: Int): Boolean {
        if (mode == Mode.PROJECTION) return true
        stopFallback()
        val (w, h) = captureSize(shortSide)
        val src = ensureTrack()
        return try {
            val cap = ScreenCapturerAndroid(consentData, object : MediaProjection.Callback() {
                override fun onStop() {
                    Log.w(TAG, "MediaProjection stopped")
                    stopProjection()
                    onStateChanged()
                }
            })
            val sth = SurfaceTextureHelper.create("ScreenCapture", egl.eglBaseContext)
            cap.initialize(sth, ctx, src.capturerObserver)
            cap.startCapture(w, h, fps)
            projection = cap
            helper = sth
            mode = Mode.PROJECTION
            Log.i(TAG, "projection capture ${w}x$h @ $fps fps")
            onStateChanged()
            true
        } catch (e: Exception) {
            // On Android 14+ a consent result can only be used once; a stale one throws here.
            Log.e(TAG, "projection capture failed to start", e)
            stopProjection()
            onStateChanged()
            false
        }
    }

    /** Starts the one-frame-per-second fallback if nothing better is running. */
    fun startFallback(shortSide: Int): Boolean {
        if (mode != Mode.NONE) return true
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R || !InputService.isReady) return false
        val (w, h) = captureSize(shortSide)
        val cap = ScreenshotCapturer(ensureTrack().capturerObserver, w, h)
        cap.start()
        fallback = cap
        mode = Mode.FALLBACK
        Log.i(TAG, "fallback capture ${w}x$h @ 1 fps")
        onStateChanged()
        return true
    }

    /**
     * Applies new video settings without recreating the virtual display (recreating it would
     * need fresh consent on Android 14+). Resolution and frame rate are adapted at the source.
     */
    fun applySettings(shortSide: Int, fps: Int) {
        if (mode != Mode.PROJECTION) return
        val (w, h) = captureSize(shortSide)
        source?.adaptOutputFormat(w, h, fps)
    }

    private fun captureSize(shortSide: Int): Pair<Int, Int> {
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        ctx.getSystemService(WindowManager::class.java).defaultDisplay.getRealMetrics(metrics)
        val real = min(metrics.widthPixels, metrics.heightPixels)
        val scale = min(shortSide, real).toDouble() / real
        fun even(v: Double) = max((v.roundToInt() / 2) * 2, 2) // encoders want even sizes
        return even(metrics.widthPixels * scale) to even(metrics.heightPixels * scale)
    }

    private fun stopProjection() {
        runCatching { projection?.stopCapture() }
        runCatching { projection?.dispose() }
        runCatching { helper?.dispose() }
        projection = null
        helper = null
        if (mode == Mode.PROJECTION) mode = Mode.NONE
    }

    private fun stopFallback() {
        runCatching { fallback?.stop() }
        fallback = null
        if (mode == Mode.FALLBACK) mode = Mode.NONE
    }

    fun release() {
        stopProjection()
        stopFallback()
        runCatching { track?.dispose() }
        runCatching { source?.dispose() }
        track = null
        source = null
        factory.dispose()
        egl.release()
    }
}
