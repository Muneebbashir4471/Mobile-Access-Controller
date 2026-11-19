# AGENT.md — Android agent architecture

The phone app in `agent-android/` (Kotlin, package `com.yourorg.agent`, `minSdk 29` / Android 10+,
`compileSdk 35`). It mirrors the screen over WebRTC and accepts remote input, staying alive as a
foreground service. Built in Docker — see `CLAUDE.md` for the build/release process.

## Key dependencies

- **WebRTC:** `io.getstream:stream-webrtc-android:1.3.10` — a maintained build of Google's `org.webrtc`.
- **OkHttp 4.12.0** — WebSocket to the hub + HTTP downloads.
- **CameraX 1.4.1 + ML Kit barcode 17.3.0** — scan the pairing QR.
- **AndroidX security-crypto 1.1.0-alpha06** — encrypted prefs for the device token.
- Kotlin coroutines 1.9.0. No Compose; plain Activities + a foreground Service.

## Components (files in `app/src/main/java/com/yourorg/agent/`)

| File | Role |
|---|---|
| `AgentService.kt` | The heart. Foreground service: WebSocket to hub, session lifecycle, wake locks, updater loop, heartbeat/status. `START_STICKY`. |
| `CaptureManager.kt` | Screen capture: PROJECTION (MediaProjection) or FALLBACK (1 fps accessibility screenshot). Owns the shared WebRTC `VideoTrack`. |
| `RtcSession.kt` | One operator session = one `PeerConnection`. Receives the browser's offer, sends the screen track, reports encoder stats. |
| `InputService.kt` | `AccessibilityService`: taps/swipes/text, global Back/Home/Recents, wake, unlock (PIN/password), lock. |
| `Updater.kt` | Checks `/api/agent/latest`, verifies sha256, installs via `PackageInstaller`. Posts a tap-to-install notification when a user action is required. |
| `DeviceOwner.kt` | `DevicePolicyManager` policies when the app is device owner (keyguard off, stay-on-while-charging, block uninstall/updates, auto-grant runtime perms). |
| `AdminReceiver.kt` | `DeviceAdminReceiver` entry point for device owner (`dpm set-device-owner com.yourorg.agent/.AdminReceiver`). |
| `PairingActivity.kt` | UI: version, server, device id, setup checklist, pair, unpair. Accepts adb extras (`--es server`, `--es code`). |
| `QrScanActivity.kt` / `PairingClient.kt` | QR scan + pairing HTTP exchange (exchanges a pairing code for a device token). |
| `CaptureConsentActivity.kt` | Transparent activity that requests MediaProjection consent ("Start now"). |
| `WakeActivity.kt` | `showWhenLocked` + `turnScreenOn`; dismisses a non-secure keyguard; surfaces the PIN pad for a secure one. |
| `ScreenshotCapturer.kt` | The 1 fps fallback: `takeScreenshot()` via accessibility, fed into the WebRTC source. |
| `StatusReporter.kt` | Builds the status payload (battery, carrier, signal, `capture_mode`, `screen_on`, `locked`). |
| `BootReceiver.kt` | Restarts the service on boot and after `MY_PACKAGE_REPLACED` (post-update). |
| `Prefs.kt` / `AgentState.kt` / `AgentApp.kt` | Encrypted creds, in-memory state for the UI, notification channels. |

## Capture modes — the central design point

Live video needs **MediaProjection** (`capture_mode: projection`), which requires a **one-time-use
consent token** from the "Start now" dialog. Two hard Android rules drive everything:

1. The consent token is **single-use**.
2. It **does not survive the app process being killed** — a restart needs a fresh "Start now" tap.

`ensureCapture()` in `AgentService.kt`:
- If already PROJECTION → done.
- Else re-launch `CaptureConsentActivity` at most once per `CONSENT_RETRY_MS` (60 s).
- If still nothing after `FALLBACK_AFTER_MS` (20 s) → start the **1 fps screenshot FALLBACK** so the
  operator sees *something*.

So **fallback is a symptom, not the disease.** The disease is the process being killed (OEM battery
killers, esp. OnePlus/OxygenOS) → consent lost → can't silently re-grant → fallback. In-app wake
locks (added 0.5.1: a lifetime `PARTIAL_WAKE_LOCK` + `WifiLock`) prevent Doze but **cannot stop an
OEM from killing the process.** The only guaranteed cure is **device owner** (keyguard disabled +
stay-on-while-charging so the screen never locks, and the app isn't killed), set on a factory-reset,
account-free phone.

`CaptureManager` detail: the WebRTC video source is created with `isScreencast = false` (real-time /
camera-like pipeline, not the slide-optimized screencast mode) for lower latency. `applySettings()`
adapts resolution/fps at the source via `adaptOutputFormat` so the virtual display is never recreated
(recreating it would need fresh consent on Android 14+).

## WebRTC flow (per session)

1. Operator opens the phone in the dashboard → hub tells the agent `session_start`.
2. The **browser makes the offer** (`rtc_offer`); the agent sets it as remote description.
3. Agent reuses the browser's recvonly transceiver as its send side, attaches the shared screen track,
   applies encoding limits, and returns an **answer** (`rtc_answer`).
4. ICE candidates exchanged via the hub. `IceTransportsType.ALL` — direct on LAN/open NAT, TURN relay
   otherwise (phones on SIM behind carrier NAT usually relay).
5. Encoding limits (`applyVideoLimits`): `maxBitrate` from the server's `default_video` (3 Mbps), `minBitrate`
   floor `min(100k, max)` so the encoder doesn't starve while bandwidth is probed, `maxFramerate` from
   fps, `DegradationPreference.BALANCED`.
6. **Input** arrives on a WebRTC data channel the browser opens ("input"), with a WebSocket fallback
   (`{type:"input", event:…}`). Events: `tap`, `long_press`, `text`, `key` (back/home/recents/enter/
   delete), `wake`, `unlock`, `lock`.
7. Every 2 s the agent sends `rtc_stats` (encoder impl, fps, w/h, target kbps, encode ms, send-queue
   ms, `qualityLimitationReason`) — shown in the dashboard's "Phone" stats panel to locate lag.

## Lifecycle / resilience

- Foreground service types: `specialUse | mediaProjection`. `START_STICKY`, restarted by `BootReceiver`.
- WebSocket reconnect with 1–60 s backoff; a `ConnectivityManager` callback skips backoff when the
  network returns. OkHttp `pingInterval(20s)` detects dead mobile links.
- Wake locks: a **screen-bright** lock only while a session is open (`updateScreenWake`); a **lifetime
  CPU + Wi-Fi** keep-alive (`acquireKeepAlive`, added 0.5.1) to survive screen-off/Doze.
- No self-updater (removed in 0.5.4): new versions are installed by hand over the old one.

## Device owner (the production setup)

`DeviceOwner.applyPolicies()` when owner: postpone system updates, block uninstall, `setKeyguardDisabled(true)`,
`STAY_ON_WHILE_PLUGGED_IN`, and grant runtime permissions silently. Set once on a **factory-reset,
account-free** phone via `deploy/provision-phone.sh` (`adb shell dpm set-device-owner …`) or the
dashboard's Device Owner setup QR (`Provisioning.kt` pairs with the code embedded in the QR). The QR
installs the APK set on the server with `deploy/set-agent-apk.sh`. This is what makes the fleet
reliable: no lock screen, no process kills, no fallback.

## Manifest highlights

Permissions: INTERNET, FOREGROUND_SERVICE(+SPECIAL_USE/+MEDIA_PROJECTION), POST_NOTIFICATIONS,
RECEIVE_BOOT_COMPLETED, REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, WAKE_LOCK, ACCESS_NETWORK_STATE,
READ_PHONE_STATE, CAMERA. Components: AgentService, InputService (accessibility, `canTakeScreenshot`),
PairingActivity, QrScanActivity, CaptureConsentActivity, WakeActivity (showWhenLocked/turnScreenOn),
AdminReceiver (device_admin), BootReceiver, ProvisioningModeActivity + PolicyComplianceActivity
(Device Owner QR setup).
