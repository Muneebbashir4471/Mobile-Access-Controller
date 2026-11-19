import { FormEvent, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import Qr from "../components/Qr";
import { applyTheme, savedTheme, type Theme } from "../theme";
import type { Me } from "../types";

export default function Settings() {
  const { me, setMe } = useAuth();
  return (
    <>
      <div className="toolbar"><h2>Settings</h2></div>
      <ThemeCard />
      <PasswordCard />
      <section className="card settings">
        <h3>Two-factor login</h3>
        <p className="muted">
          Asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator,
          Authy) after your password. Anyone with dashboard access can trade on the phones, so turning this
          on is strongly recommended.
        </p>
        {me.totp_enabled ? <Disable onDone={setMe} /> : <Enable onDone={setMe} />}
      </section>
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

function ThemeCard() {
  const [theme, setTheme] = useState<Theme>(savedTheme());
  const pick = (t: Theme) => {
    applyTheme(t);
    setTheme(t);
  };
  const label: Record<Theme, string> = { system: "System", light: "Light", dark: "Dark" };
  return (
    <section className="card settings">
      <h3>Theme</h3>
      <div className="theme-pick">
        {(["system", "light", "dark"] as Theme[]).map((t) => (
          <button key={t} type="button" className={`ghost${theme === t ? " on" : ""}`} onClick={() => pick(t)}>
            {label[t]}
          </button>
        ))}
      </div>
      <p className="muted small">Saved in this browser. System follows your computer's light/dark setting.</p>
    </section>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== again) {
      setMsg({ ok: false, text: "The new passwords do not match." });
      return;
    }
    try {
      await api("/api/auth/password", { method: "POST", body: { current_password: current, new_password: next } });
      setCurrent("");
      setNext("");
      setAgain("");
      setMsg({ ok: true, text: "Password changed." });
    } catch (err: any) {
      setMsg({ ok: false, text: err.message });
    }
  };

  return (
    <section className="card settings">
      <h3>Change password</h3>
      <form onSubmit={submit} className="row wrap">
        <input type="password" placeholder="Current password" autoComplete="current-password" value={current}
          onChange={(e) => setCurrent(e.target.value)} required />
        <input type="password" placeholder="New password (12+)" autoComplete="new-password" minLength={12} value={next}
          onChange={(e) => setNext(e.target.value)} required />
        <input type="password" placeholder="New password again" autoComplete="new-password" minLength={12} value={again}
          onChange={(e) => setAgain(e.target.value)} required />
        <button type="submit">Change password</button>
      </form>
      {msg && <p className={msg.ok ? "ok-text small" : "error"}>{msg.text}</p>}
    </section>
  );
}
