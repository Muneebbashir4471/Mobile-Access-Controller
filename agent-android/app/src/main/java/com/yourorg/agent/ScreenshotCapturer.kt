package com.yourorg.agent

import android.accessibilityservice.AccessibilityService
import android.graphics.Bitmap
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import android.view.Display
import androidx.annotation.RequiresApi
import org.webrtc.CapturerObserver
import org.webrtc.JavaI420Buffer
import org.webrtc.VideoFrame
import java.nio.ByteBuffer

/**
 * Fallback capture: AccessibilityService.takeScreenshot() needs no consent (Android 11+) but is
 * rate limited by the system to about one frame per second. Slow, but the phone stays reachable
 * after a reboot even if nobody has accepted the capture prompt.
 */
@RequiresApi(Build.VERSION_CODES.R)
class ScreenshotCapturer(
    private val observer: CapturerObserver,
    private val width: Int,
    private val height: Int,
) {
    companion object {
        private const val TAG = "ScreenshotCapturer"
        private const val INTERVAL_MS = 1_050L // the system refuses calls closer than ~1 s
    }

    private val thread = HandlerThread("screenshot").apply { start() }
    private val handler = Handler(thread.looper)
    @Volatile private var running = false

    fun start() {
        running = true
        observer.onCapturerStarted(true)
        handler.post(::tick)
    }

    fun stop() {
        running = false
        handler.removeCallbacksAndMessages(null)
        observer.onCapturerStopped()
        thread.quitSafely()
    }

    private fun tick() {
        if (!running) return
        val svc = InputService.instance
        if (svc == null) {
            handler.postDelayed(::tick, INTERVAL_MS)
            return
        }
        svc.takeScreenshot(Display.DEFAULT_DISPLAY, { it.run() }, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                try {
                    val hw = Bitmap.wrapHardwareBuffer(result.hardwareBuffer, result.colorSpace)
                    result.hardwareBuffer.close()
                    if (hw != null) {
                        val soft = hw.copy(Bitmap.Config.ARGB_8888, false)
                        hw.recycle()
                        val scaled = Bitmap.createScaledBitmap(soft, width, height, true)
                        if (scaled !== soft) soft.recycle()
                        deliver(scaled)
                        scaled.recycle()
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "frame failed", e)
                }
                if (running) handler.postDelayed(::tick, INTERVAL_MS)
            }

            override fun onFailure(errorCode: Int) {
                Log.d(TAG, "screenshot failed: $errorCode")
                if (running) handler.postDelayed(::tick, INTERVAL_MS)
            }
        })
    }

    private fun deliver(bmp: Bitmap) {
        val w = bmp.width
        val h = bmp.height
        val px = IntArray(w * h)
        bmp.getPixels(px, 0, w, 0, 0, w, h)
        val buf = JavaI420Buffer.allocate(w, h)
        argbToI420(px, w, h, buf.dataY, buf.strideY, buf.dataU, buf.strideU, buf.dataV, buf.strideV)
        val frame = VideoFrame(buf, 0, System.nanoTime())
        observer.onFrameCaptured(frame)
        frame.release()
    }

    /** BT.601 limited-range conversion; chroma sampled from the top-left pixel of each 2×2 block. */
    private fun argbToI420(
        px: IntArray, w: Int, h: Int,
        y: ByteBuffer, sy: Int, u: ByteBuffer, su: Int, v: ByteBuffer, sv: Int,
    ) {
        for (j in 0 until h) {
            val row = j * w
            for (i in 0 until w) {
                val p = px[row + i]
                val r = (p shr 16) and 0xff
                val g = (p shr 8) and 0xff
                val b = p and 0xff
                y.put(j * sy + i, (((66 * r + 129 * g + 25 * b + 128) shr 8) + 16).toByte())
                if (j and 1 == 0 && i and 1 == 0) {
                    val ci = (j / 2)
                    val cj = (i / 2)
                    u.put(ci * su + cj, (((-38 * r - 74 * g + 112 * b + 128) shr 8) + 128).toByte())
                    v.put(ci * sv + cj, (((112 * r - 94 * g - 18 * b + 128) shr 8) + 128).toByte())
                }
            }
        }
    }
}
