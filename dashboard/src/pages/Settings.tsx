import { FormEvent, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import Qr from "../components/Qr";
import Users from "./Users";
import type { Me } from "../types";

export default function Settings() {
  const { me, setMe } = useAuth();
  return (
    <>
      <div className="toolbar"><h2>Settings</h2></div>
      <section className="card settings">
        <h3>Two-factor login</h3>
        <p className="muted">
          Asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator,
          Authy) after your password. Anyone with dashboard access can trade on the phones, so turning this
          on is strongly recommended.
        </p>
        {me.totp_enabled ? <Disable onDone={setMe} /> : <Enable onDone={setMe} />}
      </section>
      {(me.role === "admin" || me.role === "superuser") && !me.must_enable_2fa && <Users />}
    </>
  );
}

function Enable({ onDone }: { onDone: (me: Me) => void }) {
  const [setup, setSetup] = useState<{ secret: string; totp_uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setError(null);
    try {
      setSetup(await api("/api/auth/2fa/setup", { method: "POST" }));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api<Me>("/api/auth/2fa/enable", { method: "POST", body: { code } }));
    } catch (err: any) {
      setError(err.message);
      setCode("");
    }
  };

  if (!setup) {
    return (
      <>
        <p>Status: <strong className="warn">Off</strong></p>
        <button onClick={start}>Set up two-factor login</button>
        {error && <p className="error">{error}</p>}
      </>
    );
  }

  return (
    <div className="pairing">
      <Qr value={setup.totp_uri} />
      <form onSubmit={confirm} className="steps">
        <ol>
          <li>Install an authenticator app on your phone.</li>
          <li>Tap <strong>+</strong> → <strong>Scan a QR code</strong> and scan this code.
            <br /><span className="muted small">Or enter the key by hand: <span className="mono">{setup.secret}</span></span></li>
          <li>Type the 6-digit code the app shows:</li>
        </ol>
        <div className="row">
          <input autoFocus inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="123456" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          <button type="submit">Turn on</button>
          <button type="button" className="ghost" onClick={() => setSetup(null)}>Cancel</button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

function Disable({ onDone }: { onDone: (me: Me) => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      onDone(await api<Me>("/api/auth/2fa/disable", { method: "POST", body: { password, code } }));
    } catch (err: any) {
      setError(err.message);
    }
  };

  return (
    <>
      <p>Status: <strong className="ok-text">On</strong></p>
      {!open ? (
        <button className="ghost" onClick={() => setOpen(true)}>Turn off…</button>
      ) : (
        <form onSubmit={submit} className="row wrap">
          <input type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <input inputMode="numeric" pattern="[0-9]{6}" maxLength={6} placeholder="Current code" value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          <button type="submit" className="danger">Turn off</button>
          <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
