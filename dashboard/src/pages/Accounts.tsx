import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Account } from "../types";
import { useDevices } from "../useDevices";

export default function Accounts() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { devices } = useDevices();

  useEffect(() => {
    const t = window.setTimeout(() => {
      api<Account[]>(`/api/accounts?q=${encodeURIComponent(q)}`)
        .then((r) => (setRows(r), setError(null)))
        .catch((e) => setError(e.message));
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const byId = new Map(devices?.map((d) => [d.id, d]));
  return (
    <>
      <div className="toolbar">
        <h2>Account search</h2>
        <span className="spacer" />
        <input autoFocus placeholder="MT5 login or label" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <p className="error">{error}</p>}
      {rows && rows.length === 0 && <p className="muted">No matching accounts.</p>}
      {rows && rows.length > 0 && (
        <table>
          <thead>
            <tr><th>Login</th><th>Label</th><th>Server</th><th>Phone</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const d = byId.get(a.device_id);
              return (
                <tr key={a.id}>
                  <td className="mono">{a.login}</td>
                  <td>{a.label}</td>
                  <td>{a.broker_server}</td>
                  <td>
                    <span className={`dot ${d?.online ? "ok" : "bad"}`} /> {a.device_name}
                    {d?.lock && <span className="warn small"> · in use by {d.lock.user_email}</span>}
                  </td>
                  <td>{d?.online && <Link to={`/control/${a.device_id}`}>Open phone →</Link>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
