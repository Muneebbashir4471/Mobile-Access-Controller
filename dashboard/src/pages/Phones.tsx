import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth";
import { ago, signalBars } from "../format";
import type { Device } from "../types";
import { useDevices } from "../useDevices";

type Filter = "all" | "online" | "offline" | "free";

export default function Phones() {
  const { devices, error } = useDevices();
  const { me } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");

  const shown = useMemo(() => {
    if (!devices) return [];
    const term = q.trim().toLowerCase();
    return devices.filter((d) => {
      if (filter === "online" && !d.online) return false;
      if (filter === "offline" && d.online) return false;
      if (filter === "free" && (!d.online || d.lock)) return false;
      return !term || d.name.toLowerCase().includes(term) || (d.sim_carrier ?? "").toLowerCase().includes(term);
    });
  }, [devices, filter, q]);

  if (error) return <p className="error">{error}</p>;
  if (!devices) return <p className="muted">Loading phones…</p>;

  const online = devices.filter((d) => d.online).length;
  return (
    <>
      <div className="toolbar">
        <h2>Phones <span className="muted small">{online} of {devices.length} online</span></h2>
        <span className="spacer" />
        {devices.length > 0 && <Link className="button ghost-link" to="/multi">⧉ Multi-view</Link>}
        {me.role === "admin" && devices.length > 0 && <Link className="button ghost-link" to="/devices?pair=1">+ Pair a phone</Link>}
        <input placeholder="Filter by name or carrier" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="seg">
          {(["all", "online", "free", "offline"] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
          ))}
        </div>
      </div>
      {devices.length === 0 ? (
        <div className="card empty">
          <p>No phones yet.</p>
          {me.role === "admin" ? (
            <Link className="button" to="/devices?pair=1">+ Pair a phone</Link>
          ) : (
            <p className="muted">Ask an admin to pair phones and assign them to you.</p>
          )}
        </div>
      ) : (
        <div className="grid">
          {shown.map((d) => <PhoneCard key={d.id} d={d} />)}
        </div>
      )}
    </>
  );
}

function PhoneCard({ d }: { d: Device }) {
  const nav = useNavigate();
  const { me } = useAuth();
  const s = d.status;
  const mine = d.lock?.user_id === me.id;
  const bars = signalBars(s.signal);
  const lowBattery = typeof s.battery === "number" && s.battery < 20;
  return (
    <button className={`phone card ${d.online ? "" : "offline"}`} disabled={!d.online} onClick={() => nav(`/control/${d.id}`)}>
      <div className="row">
        <span className={`dot ${d.online ? "ok" : "bad"}`} />
        <strong className="name">{d.name}</strong>
      </div>
      <div className="meta">
        <span className={lowBattery ? "warn" : ""}>
          🔋 {s.battery ?? "–"}%{s.charging ? " ⚡" : ""}
        </span>
        <span title={s.signal != null ? `${s.signal} dBm` : "unknown"}>
          <span className="bars">{[1, 2, 3, 4].map((i) => <i key={i} className={i <= bars ? "on" : ""} />)}</span>
          {s.network_type ?? ""}
        </span>
        <span>{d.sim_carrier ?? s.carrier ?? "—"}</span>
      </div>
      <div className="foot small">
        {!d.online ? (
          <span className="muted">Offline · seen {ago(d.last_seen_at)}</span>
        ) : d.lock ? (
          <span className={mine ? "ok-text" : "warn"}>In use by {mine ? "you" : d.lock.user_email}</span>
        ) : (
          <span className="ok-text">Free</span>
        )}
        {d.online && s.screen_on === false && <span className="warn"> · screen off</span>}
        {d.online && s.screen_on !== false && s.locked && <span className="warn"> · locked</span>}
        {d.online && s.capture_mode === "fallback" && (
          <span className="warn" title="Screen capture consent is missing; the phone streams 1 frame per second"> · 1 fps fallback</span>
        )}
        {d.online && (s.capture_ready === false || s.input_ready === false) && (
          <span className="warn" title="Screen capture or input service is not ready on the phone">
            {s.capture_ready === false ? " · no capture" : ""}{s.input_ready === false ? " · no input" : ""}
          </span>
        )}
      </div>
    </button>
  );
}
