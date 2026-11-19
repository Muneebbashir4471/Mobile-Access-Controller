import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { Device, Role, UserRow } from "../types";

const ROLE_LABEL: Record<Role, string> = { operator: "Operator", admin: "Admin", superuser: "Superuser" };

export default function Users() {
  const { me } = useAuth();
  const isSuper = me.role === "superuser";
  // A superuser manages everyone; an admin may only touch operators.
  const canManage = (u: UserRow) => isSuper || u.role === "operator";
  const grantable: Role[] = isSuper ? ["operator", "admin", "superuser"] : ["operator"];
  const [users, setUsers] = useState<UserRow[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api<UserRow[]>("/api/users").then(setUsers).catch((e) => setError(e.message));
    api<Device[]>("/api/devices").then(setDevices);
  };
  useEffect(load, []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("operator");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const u = await api<UserRow>("/api/users", { method: "POST", body: { email, password, role } });
      setNotice(`Created ${u.email}. They sign in with this password and can turn on two-factor login under Settings.`);
      setEmail("");
      setPassword("");
      setError(null);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const patch = async (u: UserRow, body: object) => {
    try {
      await api(`/api/users/${u.id}`, { method: "PATCH", body });
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const reset2fa = async (u: UserRow) => {
    if (!confirm(`Turn off two-factor login for ${u.email}? Use this if they lost their authenticator; they can set it up again under Settings.`)) return;
    await api(`/api/users/${u.id}/reset-2fa`, { method: "POST" });
    setNotice(`Two-factor login is off for ${u.email}.`);
    load();
  };

  return (
    <>
      <div className="toolbar"><h2>Users</h2></div>

      <form className="card row wrap" onSubmit={create}>
        <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Initial password (12+)" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} required />
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {grantable.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button type="submit">Create user</button>
      </form>
      {error && <p className="error">{error}</p>}

      {notice && (
        <div className="card row notice-bar">
          <span>{notice}</span>
          <span className="spacer" />
          <button className="ghost" onClick={() => setNotice(null)}>×</button>
        </div>
      )}

      <table>
        <thead>
          <tr><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Phones</th><th /></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td>
              <td>
                <select value={u.role} disabled={u.id === me.id || !canManage(u)}
                  onChange={(e) => patch(u, { role: e.target.value })}>
                  {[...new Set<Role>([u.role, ...grantable])].map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </td>
              <td>
                <label className="inline">
                  <input type="checkbox" checked={u.active} disabled={u.id === me.id || !canManage(u)}
                    onChange={(e) => patch(u, { active: e.target.checked })} /> active
                </label>
              </td>
              <td>{u.totp_enabled ? <span className="ok-text">on</span> : <span className="muted">off</span>}</td>
              <td>
                {u.role !== "operator" ? (
                  <span className="muted">all</span>
                ) : editing === u.id ? (
                  <AssignEditor user={u} devices={devices} onDone={() => (setEditing(null), load())} />
                ) : (
                  <button className="ghost" onClick={() => setEditing(u.id)}>{u.device_ids.length} assigned ✎</button>
                )}
              </td>
              <td>{u.totp_enabled && canManage(u) && <button className="ghost" onClick={() => reset2fa(u)}>Turn off 2FA</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AssignEditor({ user, devices, onDone }: { user: UserRow; devices: Device[]; onDone: () => void }) {
  const [sel, setSel] = useState(new Set(user.device_ids));
  const toggle = (id: string) => {
    const next = new Set(sel);
    next.has(id) ? next.delete(id) : next.add(id);
    setSel(next);
  };
  const save = async () => {
    await api(`/api/users/${user.id}/devices`, { method: "PUT", body: { device_ids: [...sel] } });
    onDone();
  };
  return (
    <div className="assign">
      <div className="checks">
        {devices.map((d) => (
          <label key={d.id} className="inline">
            <input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} /> {d.name}
          </label>
        ))}
      </div>
      <div className="row">
        <button onClick={save}>Save</button>
        <button className="ghost" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}
