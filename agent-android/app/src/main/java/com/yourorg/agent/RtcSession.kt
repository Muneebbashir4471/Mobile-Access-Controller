package com.yourorg.agent

import android.util.Log
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.RtpParameters
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * One operator session: a relayed peer connection that sends the screen track and receives
 * input events on the "input" data channel the browser opens. The browser makes the offer.
 *
 * Callbacks arrive on WebRTC threads; [send] and [onEnded] must be thread-safe.
 */
class RtcSession(
    val sessionId: String,
    private val capture: CaptureManager,
    turn: JSONObject,
    private val video: JSONObject,
    private val send: (JSONObject) -> Unit,
    private val onInput: (JSONObject) -> Unit,
    private val onEnded: (RtcSession, String) -> Unit,
) {
    companion object {
        private const val TAG = "RtcSession"
    }

    private val pc: PeerConnection
    private var remoteSet = false
    private val pendingIce = mutableListOf<IceCandidate>()
    private var closed = false
    private val statsTimer = Executors.newSingleThreadScheduledExecutor()
    private var lastStats: Map<String, Double> = emptyMap()

    init {
        val urls = turn.getJSONArray("urls").let { a -> (0 until a.length()).map { a.getString(it) } }
        val ice = PeerConnection.IceServer.builder(urls)
            .setUsername(turn.getString("username"))
            .setPassword(turn.getString("credential"))
            .createIceServer()
        val config = PeerConnection.RTCConfiguration(listOf(ice)).apply {
            // Direct when the network allows it (LAN, open NAT), relayed otherwise. Phones on SIM data
            // sit behind carrier NAT, so in production most sessions still use the TURN relay.
            iceTransportsType = PeerConnection.IceTransportsType.ALL
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        pc = capture.factory.createPeerConnection(config, Observer())
            ?: throw IllegalStateException("could not create peer connection")
        statsTimer.scheduleWithFixedDelay({ runCatching { reportStats() } }, 2, 2, TimeUnit.SECONDS)
    }

    /**
     * Sends the sender's view to the control view: which encoder runs, how long encoding takes,
     * how long packets wait in the send queue (pacer), and what limits quality. These show where
     * screen delay comes from on the phone side.
     */
    private fun reportStats() {
        pc.getStats { report ->
            val out = report.statsMap.values.firstOrNull { it.type == "outbound-rtp" && it.members["kind"] == "video" }
                ?: return@getStats
            val m = out.members
            fun num(k: String) = (m[k] as? Number)?.toDouble() ?: 0.0
            val now = mapOf(
                "encodeTime" to num("totalEncodeTime"), "framesEncoded" to num("framesEncoded"),
                "sendDelay" to num("totalPacketSendDelay"), "packetsSent" to num("packetsSent"),
            )
            val prev = lastStats
            lastStats = now
            fun delta(k: String) = (now[k] ?: 0.0) - (prev[k] ?: 0.0)
            val frames = delta("framesEncoded")
            val packets = delta("packetsSent")
            val stats = JSONObject()
                .put("encoder", m["encoderImplementation"]?.toString() ?: "?")
                .put("fps", num("framesPerSecond"))
                .put("width", num("frameWidth").toInt())
                .put("height", num("frameHeight").toInt())
                .put("target_kbps", (num("targetBitrate") / 1000).toInt())
                .put("limited_by", m["qualityLimitationReason"]?.toString() ?: "none")
                .put("encode_ms", if (frames > 0) (delta("encodeTime") / frames * 1000).toInt() else JSONObject.NULL)
                .put("queue_ms", if (packets > 0) (delta("sendDelay") / packets * 1000).toInt() else JSONObject.NULL)
            send(JSONObject().put("type", "rtc_stats").put("session_id", sessionId).put("stats", stats))
        }
    }

    fun onOffer(sdp: String) {
        pc.setRemoteDescription(object : SimpleSdp("setRemote") {
            override fun onSetSuccess() {
                synchronized(pendingIce) {
                    remoteSet = true
                    pendingIce.forEach { pc.addIceCandidate(it) }
                    pendingIce.clear()
                }
                // Reuses the browser's recvonly video transceiver as our send side.
                val track = capture.track
                if (track == null) {
                    end("screen capture is not running on the phone")
                    return
                }
                val sender = pc.addTrack(track, listOf("screen"))
                applyVideoLimits(sender.parameters)?.let { sender.setParameters(it) }
                createAnswer()
            }
        }, SessionDescription(SessionDescription.Type.OFFER, sdp))
    }

    private fun applyVideoLimits(params: RtpParameters): RtpParameters? {
        if (params.encodings.isEmpty()) return null
        val maxBitrate = video.optInt("bitrate", 3_000_000)
        params.encodings[0].maxBitrateBps = maxBitrate
        // A floor stops the encoder from starving itself (and stalling) while bandwidth is probed.
        params.encodings[0].minBitrateBps = minOf(500_000, maxBitrate)
        params.encodings[0].maxFramerate = video.optInt("fps", 30)
        // Under pressure, trade a little of both rather than freezing on sharp-but-stale frames.
        params.degradationPreference = RtpParameters.DegradationPreference.BALANCED
        return params
    }

    private fun createAnswer() {
        pc.createAnswer(object : SimpleSdp("createAnswer") {
            override fun onCreateSuccess(desc: SessionDescription) {
                pc.setLocalDescription(object : SimpleSdp("setLocal") {
                    override fun onSetSuccess() {
                        send(
                            JSONObject().put("type", "rtc_answer").put("session_id", sessionId)
                                .put("sdp", desc.description)
                        )
                    }
                }, desc)
            }
        }, MediaConstraints())
    }

    /** Candidate as sent by the browser: RTCIceCandidateInit JSON. */
    fun onRemoteIce(c: JSONObject) {
        val cand = c.optString("candidate")
        if (cand.isEmpty()) return // end-of-candidates marker
        val ice = IceCandidate(c.optString("sdpMid", "0"), c.optInt("sdpMLineIndex", 0), cand)
        synchronized(pendingIce) {
            if (remoteSet) pc.addIceCandidate(ice) else pendingIce.add(ice)
        }
    }

    /** Ends from our side (failure) and tells the hub. */
    fun end(reason: String) {
        if (close()) {
            send(JSONObject().put("type", "session_ended").put("session_id", sessionId).put("reason", reason))
            onEnded(this, reason)
        }
    }

    /** Closes quietly (the hub already ended it). Returns false if already closed. */
    fun close(): Boolean {
        synchronized(this) {
            if (closed) return false
            closed = true
        }
        statsTimer.shutdownNow()
        runCatching { pc.dispose() } // also disposes the senders; the shared track stays alive
        return true
    }

    private inner class Observer : PeerConnection.Observer {
        override fun onIceCandidate(c: IceCandidate) {
            send(
                JSONObject().put("type", "ice").put("session_id", sessionId).put(
                    "candidate",
                    JSONObject().put("candidate", c.sdp).put("sdpMid", c.sdpMid).put("sdpMLineIndex", c.sdpMLineIndex)
                )
            )
        }

        override fun onDataChannel(dc: DataChannel) {
            dc.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) = Unit
                override fun onStateChange() = Unit
                override fun onMessage(buffer: DataChannel.Buffer) {
                    val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                    runCatching { JSONObject(String(bytes, StandardCharsets.UTF_8)) }.getOrNull()?.let(onInput)
                }
            })
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            Log.i(TAG, "session $sessionId connection $state")
            if (state == PeerConnection.PeerConnectionState.FAILED) end("stream connection failed")
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = Unit
    }

    private open inner class SimpleSdp(private val step: String) : SdpObserver {
        override fun onCreateSuccess(desc: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) {
            Log.e(TAG, "$step failed: $error")
            end("$step failed")
        }

        override fun onSetFailure(error: String) {
            Log.e(TAG, "$step failed: $error")
            end("$step failed")
        }
    }
}
