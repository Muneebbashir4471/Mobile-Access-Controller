import { FormEvent, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import Qr from "../components/Qr";
import { ago } from "../format";
import type { Account, Device } from "../types";
import { useDevices } from "../useDevices";

interface PairingCode {
  code: string;
  expires_at: string;
  qr_payload: { server: string; code: string };
}

export default function Devices() {
  const { devices, error } = useDevices();
  const [pairing, setPairing] = useState<PairingCode | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [provisioning, setProvisioning] = useState(false);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const newCode = async () => setPairing(await api<PairingCode>("/api/devices/pairing-codes", { method: "POST" }));

  // Arriving from "Pair a phone" on the Phones page: open a code straight away (once).
  const [params, setParams] = useSearchParams();
  const autoPaired = useRef(false);
  useEffect(() => {
    if (params.get("pair") === "1" && !autoPaired.current) {
      autoPaired.current = true;
      setParams({}, { replace: true });
      newCode();
    }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const left = pairing ? Math.max(0, Math.round((new Date(pairing.expires_at).getTime() - now) / 1000)) : 0;

  return (
    <>
      <div className="toolbar">
        <h2>Devices</h2>
        <span className="spacer" />
        <button className="ghost" onClick={() => setProvisioning(true)}>Device Owner setup QR</button>
        <button onClick={newCode}>Pair a new phone</button>
      </div>

      {provisioning && <ProvisionPanel onClose={() => setProvisioning(false)} />}

      {pairing && (
        <div className="card pairing">
          <Qr value={JSON.stringify(pairing.qr_payload)} />
          <div>
            <p>Scan this with the agent app, or type the code with the server address.</p>
            <p className="code mono">{pairing.code.slice(0, 4)}-{pairing.code.slice(4)}</p>
            <p className="muted small">Server: {pairing.qr_payload.server}</p>
            <p className={left < 60 ? "warn" : "muted"}>
              {left > 0 ? `Valid for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}, one use only` : "Expired"}
            </p>
            <button className="ghost" onClick={() => setPairing(null)}>Done</button>
          </div>
        </div>
      )}

      {error && <p className="error">{error}</p>}
      {devices && (
        <table>
          <thead>
            <tr><th>Name</th><th>Model</th><th>Android</th><th>Agent</th><th>Carrier</th><th>Last seen</th><th /></tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <DeviceRows key={d.id} d={d} open={open === d.id} toggle={() => setOpen(open === d.id ? null : d.id)} />
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function DeviceRows({ d, open, toggle }: { d: Device; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr className="clickable" onClick={toggle}>
        <td><span className={`dot ${d.online ? "ok" : "bad"}`} /> {d.name}</td>
        <td>{d.model}</td>
        <td>{d.android_version}</td>
        <td>{d.app_version}</td>
        <td>{d.sim_carrier}</td>
        <td>{d.online ? "online" : ago(d.last_seen_at)}</td>
        <td>{open ? "▲" : "▼"}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7}><DeviceEditor d={d} /></td>
        </tr>
      )}
    </>
  );
}

function DeviceEditor({ d }: { d: Device }) {
  const [name, setName] = useState(d.name);
  const [carrier, setCarrier] = useState(d.sim_carrier ?? "");
  const [notes, setNotes] = useState(d.notes ?? "");
  const [fps, setFps] = useState(d.video_settings.fps);
  const [kbps, setKbps] = useState(Math.round(d.video_settings.bitrate / 1000));
  const [width, setWidth] = useState(d.video_settings.width);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/devices/${d.id}`, {
        method: "PATCH",
        body: { name, sim_carrier: carrier || null, notes: notes || null, video_settings: { fps, bitrate: kbps * 1000, width } },
      });
      setMsg("Saved");
    } catch (err: any) {
      setMsg(err.message);
    }
  };

  const revoke = async () => {
    if (!confirm(`Revoke ${d.name}? The phone is disconnected at once and must be paired again.`)) return;
    await api(`/api/devices/${d.id}`, { method: "DELETE" });
  };

  return (
    <div className="editor">
      <form onSubmit={save} className="form-grid">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>SIM carrier<input value={carrier} onChange={(e) => setCarrier(e.target.value)} /></label>
        <label className="wide">Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} /></label>
        <label>Frames per second<input type="number" min={1} max={30} value={fps} onChange={(e) => setFps(+e.target.value)} /></label>
        <label>Bitrate cap (kbps)<input type="number" min={100} max={4000} step={50} value={kbps} onChange={(e) => setKbps(+e.target.value)} /></label>
        <label>Short side (px)<input type="number" min={240} max={1440} step={8} value={width} onChange={(e) => setWidth(+e.target.value)} /></label>
        <div className="row wide">
          <button type="submit">Save</button>
          {msg && <span className="muted small">{msg}</span>}
          <span className="spacer" />
          <button type="button" className="danger" onClick={revoke}>Revoke</button>
        </div>
      </form>
      <AccountsEditor deviceId={d.id} />
    </div>
  );
}

function AccountsEditor({ deviceId }: { deviceId: string }) {
  const [rows, setRows] = useState<Account[]>([]);
  const [login, setLogin] = useState("");
  const [server, setServer] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = () => api<Account[]>(`/api/devices/${deviceId}/accounts`).then(setRows);
  useEffect(() => {
    load();
  }, [deviceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/devices/${deviceId}/accounts`, { method: "POST", body: { login, broker_server: server, label: label || null } });
      setLogin("");
      setLabel("");
      setError(null);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const remove = async (a: Account) => {
    if (!confirm(`Remove account ${a.login} from this phone's directory?`)) return;
    await api(`/api/accounts/${a.id}`, { method: "DELETE" });
    load();
  };

  return (
    <div>
      <h3>MT5 accounts on this phone</h3>
      <p className="muted small">Directory only. MT5 passwords are never stored here.</p>
      <table className="compact">
        <tbody>
          {rows.map((a) => (
            <tr key={a.id}>
              <td className="mono">{a.login}</td>
              <td>{a.broker_server}</td>
              <td>{a.label}</td>
              <td><button className="ghost" onClick={() => remove(a)}>Remove</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <form onSubmit={add} className="row">
        <input placeholder="Login" value={login} onChange={(e) => setLogin(e.target.value)} required />
        <input placeholder="Broker server" value={server} onChange={(e) => setServer(e.target.value)} required />
        <input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

interface Provision {
  code: string;
  expires_at: string;
  apk_version: string;
  qr_payload: Record<string, unknown>;
}

/** Android Device Owner setup QR for a factory-reset phone. */
function ProvisionPanel({ onClose }: { onClose: () => void }) {
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [data, setData] = useState<Provision | null>(null);
  const [error, setError] = useState<string | null>(null);

  const make = async (e: FormEvent) => {
    e.preventDefault();
    try {
      setError(null);
      setData(await api<Provision>("/api/devices/provisioning-qr", {
        method: "POST",
        body: { wifi_ssid: ssid || null, wifi_password: password || null },
      }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <div className="card provision">
      <div className="row">
        <h3 style={{ margin: 0 }}>Device Owner setup</h3>
        <span className="spacer" />
        <button className="ghost" onClick={onClose}>×</button>
      </div>
      <p className="muted small">
        Recommended for dedicated phones. The agent becomes the phone's owner: Android can't kill or uninstall it,
        the lock screen is off and its permissions are granted automatically. Needs a factory-reset phone with no
        Google account.
      </p>
      <form className="row wrap" onSubmit={make}>
        <input placeholder="Wi-Fi name (optional)" value={ssid} onChange={(e) => setSsid(e.target.value)} />
        <input type="password" placeholder="Wi-Fi password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button type="submit">{data ? "Make a new QR" : "Create setup QR"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {data && (
        <div className="pairing">
          <Qr value={JSON.stringify(data.qr_payload)} size={300} />
          <div>
            <ol>
              <li>Factory-reset the phone. Do not add a Google account.</li>
              <li>On the first welcome screen, tap the same empty spot 6 times. A QR scanner opens.</li>
              <li>Scan this code. The phone joins Wi-Fi, downloads agent {data.apk_version} and sets it up as owner.</li>
              <li>When setup finishes, open the agent and turn on its Accessibility service. Android only allows this step by hand.</li>
            </ol>
            <p className="muted small">
              The phone pairs itself with the one-time code inside this QR. One phone only, valid until{" "}
              {new Date(data.expires_at).toLocaleTimeString()}.{ssid ? " The QR contains the Wi-Fi password, so don't share it." : ""}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
