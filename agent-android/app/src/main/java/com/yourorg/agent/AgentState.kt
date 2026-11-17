package com.yourorg.agent

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** Connection state shown in the app's own screen and notification. */
object AgentState {
    enum class Conn { STOPPED, CONNECTING, ONLINE, WAITING, UNPAIRED }

    private val _conn = MutableStateFlow(Conn.STOPPED)
    val conn: StateFlow<Conn> = _conn
    private val _detail = MutableStateFlow("")
    val detail: StateFlow<String> = _detail

    private val _captureReady = MutableStateFlow(false)
    val captureReady: StateFlow<Boolean> = _captureReady

    // "none" | "projection" (live) | "fallback" (1 fps). Lets the checklist tell live capture apart
    // from the degraded fallback instead of showing a misleading green tick for both.
    private val _captureMode = MutableStateFlow("none")
    val captureMode: StateFlow<String> = _captureMode

    fun setCaptureReady(ready: Boolean) {
        _captureReady.value = ready
    }

    fun setCaptureMode(mode: String) {
        _captureMode.value = mode
    }

    fun set(c: Conn, detail: String = "") {
        _conn.value = c
        _detail.value = detail
    }
}
