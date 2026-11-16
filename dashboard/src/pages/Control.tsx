import { FormEvent, PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth";
import { live } from "../live";
import type { LiveMessage } from "../types";
import { useDevices } from "../useDevices";

type Phase =
  | { kind: "opening" }
  | { kind: "connecting"; sessionId: string }
  | { kind: "live"; sessionId: string }
  | { kind: "denied"; reason: string; heldBy?: string | null }
  | { kind: "ended"; reason: string; by?: string | null; detail?: string | null };

type InputEvent =
  | { type: "tap"; x: number; y: number }
  | { type: "swipe"; x1: number; y1: number; x2: number; y2: number; duration_ms: number }
  | { type: "long_press"; x: number; y: number; duration_ms: number }
  | { type: "text"; value: string }
  | { type: "key"; name: "back" | "home" | "recents" | "enter" | "delete" }
  | { type: "wake" }
  | { type: "lock" }
  | { type: "unlock"; secret: string };

interface Stats {
  rtt?: number;
  fps?: number;
  kbps?: number;
  path?: string;
  jitterMs?: number;
  decodeMs?: number;
  codec?: string;
  size?: string;
}

interface PhoneStats {
  encoder: string;
  fps: number;
  width: number;
  height: number;
  target_kbps: number;
  limited_by: string;
  encode_ms: number | null;
  queue_ms: number | null;
}

const LONG_PRESS_MS = 600;
const DRAG_THRESHOLD = 0.02; // fraction of the screen
const ACTIVITY_EVERY_MS = 10_000;

const DENIED_TEXT: Record<string, string> = {
  locked: "Someone else is controlling this phone.",
  offline: "This phone is offline.",
  not_assigned: "This phone is not assigned to you.",
};
const ENDED_TEXT: Record<string, string> = {
  closed: "Session closed.",
  timeout: "Released after 5 minutes without input.",
  takeover: "An admin took over this phone.",
  device_lost: "The phone disconnected.",
  connection: "Connection to the server was lost.",
};

export default function Control() {
  const { deviceId = "" } = useParams();
  // When opened in its own pop-out window (from the Phones list), the close button shuts the window
  // instead of navigating this tab back to the list.
  const popped = typeof window !== "undefined" && window.opener != null;
  const nav = useNavigate();
  const { me } = useAuth();
  const { devices } = useDevices();
  const device = devices?.find((d) => d.id === deviceId);

  const [phase, setPhase] = useState<Phase>({ kind: "opening" });
  const [streamState, setStreamState] = useState<string>("new");
  const [stats, setStats] = useState<Stats>({});
  const [lockExpiry, setLockExpiry] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [text, setText] = useState("");
  const [secret, setSecret] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [phoneStats, setPhoneStats] = useState<PhoneStats | null>(null);
  const [aspect, setAspect] = useState<number | null>(null); // phone width / height
  const [ripples, setRipples] = useState<{ id: number; x: number; y: number }[]>([]);

  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const sessionRef = useRef<string | null>(null);
  const lastActivity = useRef(0);
  const lockTtl = useRef(300);

  // Opening and signaling -----------------------------------------------------

  const teardown = useCallback(() => {
    dcRef.current?.close();
    pcRef.current?.close();
    dcRef.current = null;
    pcRef.current = null;
  }, []);

  const startRtc = useCallback(async (sessionId: string, turn: { urls: string[]; username: string; credential: string }) => {
    teardown();
    // Direct when the network allows it (same LAN, open NAT); the TURN relay is the fallback,
    // which phones on SIM data (carrier NAT) will normally use.
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: turn.urls, username: turn.username, credential: turn.credential }],
      iceTransportPolicy: "all",
      bundlePolicy: "max-bundle",
    });
    pcRef.current = pc;
    const transceiver = pc.addTransceiver("video", { direction: "recvonly" });
    // Prefer H.264: nearly every Android phone encodes it in hardware (fast); VP8 is often software.
    try {
      const caps = RTCRtpReceiver.getCapabilities("video");
      if (caps && "setCodecPreferences" in transceiver) {
        const rank = (c: { mimeType: string; sdpFmtpLine?: string }) =>
          c.mimeType === "video/H264" ? (c.sdpFmtpLine?.includes("42e01f") ? 0 : 1) : c.mimeType === "video/VP8" ? 2 : 3;
        transceiver.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
      }
    } catch (e) {
      console.warn("codec preference not applied", e);
    }
    const dc = pc.createDataChannel("input", { ordered: true });
    dcRef.current = dc;

    pc.ontrack = (ev) => {
      // Remote control wants frames shown the moment they arrive, not smoothed by a jitter buffer.
      const r = ev.receiver as RTCRtpReceiver & { jitterBufferTarget?: number; playoutDelayHint?: number };
      try { r.jitterBufferTarget = 0; } catch { /* older browser */ }
      try { r.playoutDelayHint = 0; } catch { /* not Chrome */ }
      if (videoRef.current) videoRef.current.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
    };
    pc.onicecandidate = (ev) => {
      if (ev.candidate) live.send({ type: "ice", session_id: sessionId, candidate: ev.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      setStreamState(pc.connectionState);
      if (pc.connectionState === "connected") setPhase({ kind: "live", sessionId });
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Ask the phone's encoder to start near 1.5 Mbps instead of ramping up from ~300 kbps,
    // so the first seconds are not blurry and bursty.
    const sdp = (offer.sdp ?? "").replace(
      /^(a=fmtp:\d+ .*)$/gm,
      (line) => (line.includes("x-google-start-bitrate") ? line : `${line};x-google-start-bitrate=1500`),
    );
    live.send({ type: "rtc_offer", session_id: sessionId, sdp });
  }, [teardown]);

  useEffect(() => {
    const onMsg = async (m: LiveMessage) => {
      const sid = sessionRef.current;
      switch (m.type) {
        case "_connected":
          if (!sid) live.send({ type: "open", device_id: deviceId });
          break;
        case "_disconnected":
          if (sid) {
            sessionRef.current = null;
            teardown();
            setPhase({ kind: "ended", reason: "connection" });
          }
          break;
        case "opened":
          if (m.device_id !== deviceId) return;
          sessionRef.current = m.session_id;
          lockTtl.current = m.lock_ttl ?? 300;
          setLockExpiry(Date.now() + lockTtl.current * 1000);
          setPhase({ kind: "connecting", sessionId: m.session_id });
          startRtc(m.session_id, m.turn).catch((e) => console.error(e));
          break;
        case "denied":
          if (m.device_id === deviceId) setPhase({ kind: "denied", reason: m.reason, heldBy: m.held_by });
          break;
        case "rtc_answer":
          if (m.session_id === sid && pcRef.current) await pcRef.current.setRemoteDescription({ type: "answer", sdp: m.sdp });
          break;
        case "ice":
          if (m.session_id === sid && pcRef.current && m.candidate) {
            try {
              await pcRef.current.addIceCandidate(m.candidate);
            } catch (e) {
              console.warn("bad candidate", e);
            }
          }
          break;
        case "notice":
          if (m.session_id === sid) setNotice(m.message);
          break;
        case "rtc_stats":
          if (m.session_id === sid) setPhoneStats(m.stats);
          break;
        case "lock_refreshed":
          if (m.session_id === sid && m.expires_in) setLockExpiry(Date.now() + m.expires_in * 1000);
          break;
        case "session_ended":
          if (m.session_id === sid) {
            sessionRef.current = null;
            teardown();
            setPhase({ kind: "ended", reason: m.reason, by: m.by, detail: m.detail });
          }
          break;
      }
    };
    const unsub = live.subscribe(onMsg);
    if (live.connected) live.send({ type: "open", device_id: deviceId });

    const closeOnUnload = () => {
      if (sessionRef.current) live.send({ type: "close", session_id: sessionRef.current });
    };
    window.addEventListener("beforeunload", closeOnUnload);
    return () => {
      window.removeEventListener("beforeunload", closeOnUnload);
      unsub();
      closeOnUnload();
      sessionRef.current = null;
      teardown();
    };
  }, [deviceId, startRtc, teardown]);

  // Clock for the idle countdown, and connection stats.
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  useEffect(() => {
    let prevBytes = 0;
    let prevTs = 0;
    const t = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      const report = await pc.getStats();
      const next: Stats = {};
      const byId = new Map<string, any>();
      report.forEach((s: any) => byId.set(s.id, s));
      report.forEach((s: any) => {
        if (s.type === "candidate-pair" && s.nominated && s.state === "succeeded") {
          if (s.currentRoundTripTime != null) next.rtt = Math.round(s.currentRoundTripTime * 1000);
          const local = byId.get(s.localCandidateId);
          const remote = byId.get(s.remoteCandidateId);
          const relayed = local?.candidateType === "relay" || remote?.candidateType === "relay";
          next.path = relayed ? `relay (${local?.relayProtocol ?? local?.protocol ?? "udp"})` : "direct";
        }
        if (s.type === "inbound-rtp" && s.kind === "video") {
          next.fps = s.framesPerSecond;
          if (prevTs) next.kbps = Math.round(((s.bytesReceived - prevBytes) * 8) / (s.timestamp - prevTs));
          prevBytes = s.bytesReceived;
          prevTs = s.timestamp;
          if (s.jitterBufferEmittedCount) next.jitterMs = Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000);
          if (s.framesDecoded) next.decodeMs = Math.round((s.totalDecodeTime / s.framesDecoded) * 1000);
          if (s.frameWidth) next.size = `${s.frameWidth}×${s.frameHeight}`;
          const codec = byId.get(s.codecId);
          if (codec) next.codec = String(codec.mimeType).replace("video/", "");
        }
      });
      setStats(next);
    }, 2000);
    return () => window.clearInterval(t);
  }, []);

  // Input -----------------------------------------------------------------------

  const send = useCallback((ev: InputEvent) => {
    const sid = sessionRef.current;
    if (!sid) return;
    const dc = dcRef.current;
    if (dc?.readyState === "open") dc.send(JSON.stringify(ev));
    else live.send({ type: "input", session_id: sid, event: ev }); // WebSocket fallback
    const t = Date.now();
    if (t - lastActivity.current > ACTIVITY_EVERY_MS) {
      lastActivity.current = t;
      live.send({ type: "activity", session_id: sid });
    } else {
      setLockExpiry(t + lockTtl.current * 1000);
    }
  }, []);

  /** Horizontal swipe across the middle of the screen: "next" moves content left (like paging). */
  const page = useCallback((dir: "next" | "prev") => {
    const [x1, x2] = dir === "next" ? [0.85, 0.15] : [0.15, 0.85];
    send({ type: "swipe", x1, y1: 0.5, x2, y2: 0.5, duration_ms: 250 });
  }, [send]);

  /** Scroll content down (finger moves up) or up, around point (x, y). */
  const scroll = useCallback((dir: "down" | "up", x = 0.5, y = 0.5, amount = 0.3) => {
    const half = amount / 2;
    const from = Math.min(0.9, Math.max(0.1, y + (dir === "down" ? half : -half)));
    const to = Math.min(0.95, Math.max(0.05, y + (dir === "down" ? -half : half)));
    // Slow enough that Android treats it as a drag, not a fling.
    send({ type: "swipe", x1: x, y1: from, x2: x, y2: to, duration_ms: 350 });
  }, [send]);

  // Mouse wheel over the phone scrolls what is under the cursor (throttled to one swipe at a time).
  const wheelAt = useRef(0);
  const onWheel = (e: React.WheelEvent<HTMLVideoElement>) => {
    const p = toScreen(e as unknown as PointerEvent<HTMLVideoElement>);
    const now = performance.now();
    if (!p || Math.abs(e.deltaY) < 4 || now - wheelAt.current < 380) return;
    wheelAt.current = now;
    scroll(e.deltaY > 0 ? "down" : "up", p.x, p.y, Math.min(0.5, 0.2 + Math.abs(e.deltaY) / 1000));
  };

  // Keyboard: arrows swipe/scroll, Escape = Back, unless the operator is typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (!sessionRef.current || (t && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      const actions: Record<string, () => void> = {
        ArrowLeft: () => page("prev"),
        ArrowRight: () => page("next"),
        ArrowDown: () => scroll("down"),
        ArrowUp: () => scroll("up"),
        Escape: () => send({ type: "key", name: "back" }),
      };
      const act = actions[e.key];
      if (act) {
        e.preventDefault();
        act();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [page, scroll, send]);

  /** Pointer position as fractions of the phone screen, accounting for letterboxing. */
  const toScreen = (e: PointerEvent<HTMLVideoElement>): { x: number; y: number } | null => {
    const v = e.currentTarget;
    const r = v.getBoundingClientRect();
    if (!v.videoWidth || !v.videoHeight) return null;
    const scale = Math.min(r.width / v.videoWidth, r.height / v.videoHeight);
    const w = v.videoWidth * scale;
    const h = v.videoHeight * scale;
    const x = (e.clientX - r.left - (r.width - w) / 2) / w;
    const y = (e.clientY - r.top - (r.height - h) / 2) / h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x: +x.toFixed(4), y: +y.toFixed(4) };
  };

  const gesture = useRef<{ x: number; y: number; t: number; timer?: number; done: boolean; moved: boolean } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLVideoElement>) => {
    const p = toScreen(e);
    if (!p) return;
    // Instant local feedback while the phone's own reaction travels back.
    const rect = e.currentTarget.getBoundingClientRect();
    const id = performance.now();
    setRipples((r) => [...r.slice(-4), { id, x: e.clientX - rect.left, y: e.clientY - rect.top }]);
    window.setTimeout(() => setRipples((r) => r.filter((x) => x.id !== id)), 450);
    e.currentTarget.setPointerCapture(e.pointerId);
    const g = { ...p, t: performance.now(), done: false, moved: false, timer: undefined as number | undefined };
    g.timer = window.setTimeout(() => {
      if (!g.moved) {
        g.done = true;
        send({ type: "long_press", x: g.x, y: g.y, duration_ms: LONG_PRESS_MS });
      }
    }, LONG_PRESS_MS);
    gesture.current = g;
  };

  const onPointerMove = (e: PointerEvent<HTMLVideoElement>) => {
    const g = gesture.current;
    const p = g && toScreen(e);
    if (g && p && Math.hypot(p.x - g.x, p.y - g.y) > DRAG_THRESHOLD) {
      g.moved = true;
      window.clearTimeout(g.timer);
    }
  };

  const onPointerUp = (e: PointerEvent<HTMLVideoElement>) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    window.clearTimeout(g.timer);
    if (g.done) return;
    const p = toScreen(e) ?? { x: g.x, y: g.y };
    if (g.moved) {
      const duration = Math.max(80, Math.min(2000, Math.round(performance.now() - g.t)));
      send({ type: "swipe", x1: g.x, y1: g.y, x2: p.x, y2: p.y, duration_ms: duration });
    } else {
      send({ type: "tap", x: g.x, y: g.y });
    }
  };

  const submitText = (e: FormEvent) => {
    e.preventDefault();
    if (!text) return;
    send({ type: "text", value: text });
    setText("");
  };

  const unlock = (e: FormEvent) => {
    e.preventDefault();
    send({ type: "unlock", secret }); // sent over the encrypted stream, never stored
    setSecret("");
    setNotice("Unlocking…");
  };

  const release = () => {
    if (sessionRef.current) live.send({ type: "close", session_id: sessionRef.current });
    sessionRef.current = null;
    teardown();
    if (popped) window.close();
    else nav("/");
  };

  const retry = () => {
    setPhase({ kind: "opening" });
    live.send({ type: "open", device_id: deviceId });
  };

  const takeover = () => {
    setPhase({ kind: "opening" });
    live.send({ type: "takeover", device_id: deviceId });
  };

  // Render ------------------------------------------------------------------

  const active = phase.kind === "connecting" || phase.kind === "live";
  const secondsLeft = lockExpiry ? Math.max(0, Math.round((lockExpiry - now) / 1000)) : null;
  const streamBad = active && (streamState === "disconnected" || streamState === "failed");

  return (
    <div className="control">
      <aside className="panel">
        <button className="ghost" onClick={release}>{popped ? "✕ Close window" : "← Phones"}</button>
        <h2>{device?.name ?? "Phone"}</h2>
        {device && (
          <p className="muted small">
            {device.sim_carrier ?? device.status.carrier ?? ""} · {device.status.network_type ?? ""} · 🔋 {device.status.battery ?? "–"}%
          </p>
        )}

        {device?.status.capture_mode === "fallback" && (
          <p className="warn small">This phone is in 1 fps fallback mode (screen capture consent is missing). Avoid trading on it until it recovers.</p>
        )}
        {device && device.status.input_ready === false && (
          <p className="warn small">The phone's accessibility service is off, so taps and typing will not work.</p>
        )}

        {phase.kind === "denied" && (
          <div className="notice">
            <p>{DENIED_TEXT[phase.reason] ?? phase.reason}{phase.heldBy ? ` (${phase.heldBy})` : ""}</p>
            <div className="row">
              <button onClick={retry}>Try again</button>
              {me.role === "admin" && phase.reason === "locked" && <button className="danger" onClick={takeover}>Take over</button>}
            </div>
          </div>
        )}
        {phase.kind === "ended" && (
          <div className="notice">
            <p>{ENDED_TEXT[phase.reason] ?? phase.reason}{phase.by ? ` (by ${phase.by})` : ""}</p>
            {phase.detail && <p className="muted small">Phone says: {phase.detail}</p>}
            <button onClick={retry}>Reopen</button>
          </div>
        )}

        {active && (
          <>
            {(device?.status.screen_on === false || device?.status.locked) && (
              <p className="warn small">{device?.status.screen_on === false ? "The phone's screen is off." : "The phone is locked."}</p>
            )}
            <div className="row">
              <button className="ghost" onClick={() => (send({ type: "wake" }), setNotice("Waking the screen…"))}>☀ Wake screen</button>
              <button className="ghost" onClick={() => (send({ type: "lock" }), setNotice("Locking the screen…"))}>🔒 Lock screen</button>
            </div>
            <form onSubmit={unlock} className="row">
              <input type="password" autoComplete="off" placeholder="Phone PIN / password" value={secret}
                onChange={(e) => setSecret(e.target.value)} />
              <button type="submit" className="ghost">Unlock</button>
            </form>
            {notice && <p className="small notice-line">{notice}</p>}
            <form onSubmit={submitText} className="textbox">
              <input placeholder="Type, then Enter to send" value={text} onChange={(e) => setText(e.target.value)} />
              <div className="row">
                <button type="button" onClick={() => send({ type: "key", name: "delete" })}>⌫</button>
                <button type="button" onClick={() => send({ type: "key", name: "enter" })}>Enter key</button>
              </div>
            </form>
            <dl className="stats small">
              <dt>Stream</dt><dd className={streamBad ? "warn" : ""}>{streamState}</dd>
              <dt>Round trip</dt><dd className={stats.rtt && stats.rtt > 300 ? "warn" : ""}>{stats.rtt != null ? `${stats.rtt} ms` : "—"}</dd>
              <dt>Frames</dt><dd>{stats.fps != null ? `${stats.fps} fps` : "—"}</dd>
              <dt>Bitrate</dt><dd>{stats.kbps != null ? `${stats.kbps} kbps` : "—"}</dd>
              <dt>Path</dt><dd>{stats.path ?? "—"}</dd>
              <dt>Codec</dt><dd>{stats.codec ? `${stats.codec} ${stats.size ?? ""}` : "—"}</dd>
              <dt>Buffer</dt><dd className={stats.jitterMs != null && stats.jitterMs > 80 ? "warn" : ""}>{stats.jitterMs != null ? `${stats.jitterMs} ms` : "—"}</dd>
              <dt>Decode</dt><dd>{stats.decodeMs != null ? `${stats.decodeMs} ms` : "—"}</dd>
              {phoneStats && (
                <>
                  <dt className="stats-head">Phone</dt><dd />
                  <dt>Encoder</dt><dd className="mono small">{phoneStats.encoder}</dd>
                  <dt>Encode</dt><dd className={(phoneStats.encode_ms ?? 0) > 30 ? "warn" : ""}>{phoneStats.encode_ms != null ? `${phoneStats.encode_ms} ms` : "—"}</dd>
                  <dt>Send queue</dt><dd className={(phoneStats.queue_ms ?? 0) > 50 ? "warn" : ""}>{phoneStats.queue_ms != null ? `${phoneStats.queue_ms} ms` : "—"}</dd>
                  <dt>Sending</dt><dd>{Math.round(phoneStats.fps)} fps · {phoneStats.width}×{phoneStats.height} · {phoneStats.target_kbps} kbps</dd>
                  <dt>Limited by</dt><dd className={phoneStats.limited_by !== "none" ? "warn" : ""}>{phoneStats.limited_by}</dd>
                </>
              )}
              <dt>Est. delay</dt><dd>{stats.rtt != null && stats.jitterMs != null ? `~${Math.round(stats.rtt / 2 + stats.jitterMs + (stats.decodeMs ?? 0) + (phoneStats?.encode_ms ?? 0) + (phoneStats?.queue_ms ?? 0) + 1000 / Math.max(stats.fps ?? 30, 1))} ms` : "—"}</dd>
            </dl>
            {secondsLeft != null && secondsLeft <= 60 && (
              <p className="warn">Releasing in {secondsLeft}s unless you use the phone.</p>
            )}
            <button className="danger" onClick={release}>Release</button>
          </>
        )}
      </aside>

      <section className="screen">
        {streamBad && <div className="banner">Stream dropped — waiting for the phone to reconnect…</div>}
        {phase.kind === "opening" && <p className="muted">Opening…</p>}
        {phase.kind === "connecting" && <p className="muted overlay">Connecting to the phone…</p>}

        <div className={`stage ${active ? "" : "hidden"}`}>
          <button className="side-arrow" title="Swipe right (previous page) · ←" onClick={() => page("prev")}>‹</button>
          <div className="phone-frame" style={aspect ? { aspectRatio: String(aspect) } : undefined}>
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              onLoadedMetadata={(e) => e.currentTarget.videoWidth && setAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
              onResize={(e) => e.currentTarget.videoWidth && setAspect(e.currentTarget.videoWidth / e.currentTarget.videoHeight)}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (gesture.current = null)}
              onWheel={onWheel}
              onContextMenu={(e) => e.preventDefault()}
            />
            {ripples.map((r) => <span key={r.id} className="ripple" style={{ left: r.x, top: r.y }} />)}
          </div>
          <button className="side-arrow" title="Swipe left (next page) · →" onClick={() => page("next")}>›</button>
        </div>

        {active && (
          <nav className="navbar">
            <button title="Scroll up · ↑" onClick={() => scroll("up")}>▲</button>
            <button title="Back · Esc" onClick={() => send({ type: "key", name: "back" })}>◀ Back</button>
            <button title="Home" onClick={() => send({ type: "key", name: "home" })}>● Home</button>
            <button title="Recent apps" onClick={() => send({ type: "key", name: "recents" })}>■ Recents</button>
            <button title="Scroll down · ↓" onClick={() => scroll("down")}>▼</button>
          </nav>
        )}
      </section>
    </div>
  );
}
