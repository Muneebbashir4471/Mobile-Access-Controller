import { FormEvent, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import Qr from "../components/Qr";
import { ACCENTS, THEMES, applyTheme, savedAccent, savedTheme, type ThemeDef } from "../theme";
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

function Preview({ t }: { t: ThemeDef }) {
  return (
    <div className="tp-preview" style={{ background: t.bg }}>
      <div className="tp-side" style={{ background: t.surface }}>
        <i style={{ background: t.accent }} /><i style={{ background: t.border }} /><i style={{ background: t.border }} />
      </div>
      <div className="tp-main">
        {[0, 1].map((n) => (
          <div key={n} className="tp-card" style={{ background: t.surface2, borderColor: t.border }}>
            <i style={{ background: t.muted, width: "70%" }} /><i style={{ background: n ? t.accent : t.border, width: "40%" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ThemeCard() {
  const [theme, setTheme] = useState(savedTheme());
  const [accent, setAccent] = useState<string | null>(savedAccent());
  const pickTheme = (id: string) => {
    applyTheme(id, null); // a theme brings its own accent
    setTheme(id);
    setAccent(null);
  };
  const pickAccent = (a: string | null) => {
    applyTheme(theme, a);
    setAccent(a);
  };
  const current = accent ?? THEMES.find((x) => x.id === theme)?.accent ?? null;
  const dark = THEMES[0];
  const light = THEMES[1];

  return (
    <section className="card">
      <h3>Appearance</h3>
      <p className="muted small">App theme. Choosing a theme also sets its accent color, which you can change below. Saved in this browser.</p>
      <div className="theme-grid">
        <button type="button" className={`tp${theme === "system" ? " on" : ""}`} onClick={() => pickTheme("system")}>
          <div className="tp-split"><Preview t={dark} /><Preview t={light} /></div>
          <span>System</span>
        </button>
        {THEMES.map((t) => (
          <button key={t.id} type="button" className={`tp${theme === t.id ? " on" : ""}`} onClick={() => pickTheme(t.id)}>
            <Preview t={t} />
            <span>{t.name}</span>
          </button>
        ))}
      </div>
      <div className="accent-row">
        <div>
          <strong>Accent color</strong>
          <div className="muted small">Buttons, highlights and selection</div>
        </div>
        <div className="swatches">
          {ACCENTS.map((a) => (
            <button key={a} type="button" title={a} className={`swatch${current === a ? " on" : ""}`}
              style={{ background: a }} onClick={() => pickAccent(a)} />
          ))}
          <label className="swatch swatch-custom" title="Custom color">
            <input type="color" value={current ?? "#3b82f6"} onChange={(e) => pickAccent(e.target.value)} />
          </label>
          {accent && <button type="button" className="ghost small" onClick={() => pickAccent(null)}>Reset</button>}
        </div>
      </div>
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
