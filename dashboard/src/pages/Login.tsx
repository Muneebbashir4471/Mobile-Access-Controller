import { FormEvent, useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../types";

export default function Login({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  // Shown only for users who turned on two-factor login in Settings.
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = needCode ? { email, password, code } : { email, password };
      onSignedIn(await api<Me>("/api/auth/login", { method: "POST", body }));
    } catch (err) {
      if (err instanceof ApiError && err.message === "one_time_code_required") {
        setNeedCode(true);
      } else {
        setError((err as Error).message);
        setCode("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <h1>MT5 Phones</h1>
        <label>
          Email
          <input type="email" autoComplete="username" value={email} readOnly={needCode}
            onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} readOnly={needCode}
            onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {needCode && (
          <label>
            One-time code from your authenticator app
            <input autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} required />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : needCode ? "Verify" : "Sign in"}</button>
        {needCode && (
          <button type="button" className="ghost" onClick={() => (setNeedCode(false), setCode(""), setError(null))}>
            Back
          </button>
        )}
      </form>
    </div>
  );
}
