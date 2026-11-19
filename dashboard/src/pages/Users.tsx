import { FormEvent, useEffect, useState } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { Device, Role, UserRow } from "../types";

const ROLE_LABEL: Record<Role, string> = { operator: "Operator", admin: "Admin", superuser: "Superuser" };

const ICON: Record<string, string> = {
  edit: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-4-4L4 16v4zM13.5 6.5l4 4",
  key: "M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7zm1.5 1.5h.01",
  shield: "M12 3l7 3v5c0 4.5-3 8.4-7 10-4-1.6-7-5.5-7-10V6l7-3z",
  off: "M6 6l12 12M18 6L6 18",
  on: "M5 12l5 5 9-10",
};

function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={ICON[name]} /></svg>
  );
}

function when(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never";
}

export default function Users() {
  const { me } = useAuth();
  const isSuper = me.role === "superuser";
  // A superuser manages everyone; an admin manages operators and other admins, not superusers.
  const canManage = (u: UserRow) => isSuper || u.role !== "superuser";
  const grantable: Role[] = isSuper ? ["operator", "admin", "superuser"] : ["operator", "admin"];
  const [users, setUsers] = useState<UserRow[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api<UserRow[]>("/api/users").then(setUsers).catch((e) => setError(e.message));
    api<Device[]>("/api/devices").then(setDevices);
  };
  useEffect(load, []);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("operator");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const u = await api<UserRow>("/api/users", { method: "POST", body: { name: name || null, email, password, role } });
      setNotice(`Created ${u.email}. They sign in with this password and can turn on two-factor login under Settings.`);
      setName("");
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
      setError(null);
      load();
    } catch (err: any) {
      setError(err.message);
    }
  };

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const u = users.find((x) => x.id === renaming.id);
    if (u) await patch(u, { name: renaming.name });
    setRenaming(null);
  };

  const changePassword = async (u: UserRow) => {
    const pw = prompt(`New password for ${u.email} (12+ characters):`);
    if (pw === null) return;
    if (pw.length < 12) {
      setError("Passwords must be at least 12 characters.");
      return;
    }
    try {
      await api(`/api/users/${u.id}`, { method: "PATCH", body: { password: pw } });
      setError(null);
      setNotice(`Password changed for ${u.email}.`);
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

  const toggleActive = (u: UserRow) => {
    if (u.active && !confirm(`Disable ${u.email}? They are signed out and cannot sign in until enabled again.`)) return;
    patch(u, { active: !u.active });
  };

  return (
    <>
      <div className="toolbar"><h2>Users</h2></div>

      <form className="card row wrap" onSubmit={create}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
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

      <div className="card users-card">
        <p className="muted small">
          Admins and superusers see every phone. Operators only see the phones assigned to them. Admins manage
          operators and other admins; only a superuser manages superusers.
        </p>
        <table className="users">
          <thead>
            <tr><th>User</th><th>Role</th><th>Status</th><th>Phones</th><th>Last sign-in</th><th /></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const manage = canManage(u);
              const self = u.id === me.id;
              return (
                <tr key={u.id} className={u.active ? "" : "inactive"}>
                  <td>
                    <div className="who-cell">
                      <span className="avatar">{(u.name || u.email).trim()[0]?.toUpperCase()}</span>
                      {renaming?.id === u.id ? (
                        <form onSubmit={saveName} className="row">
                          <input autoFocus value={renaming.name} placeholder="Name"
                            onChange={(e) => setRenaming({ id: u.id, name: e.target.value })} />
                          <button type="submit">Save</button>
                          <button type="button" className="ghost" onClick={() => setRenaming(null)}>Cancel</button>
                        </form>
                      ) : (
                        <div>
                          <div className="who-name">{u.name || u.email.split("@")[0]}{self && <span className="muted"> (you)</span>}</div>
                          <div className="muted small">{u.email}</div>
                        </div>
                      )}
                    </div>
                  </td>
                  <td>
                    <select value={u.role} disabled={self || !manage} onChange={(e) => patch(u, { role: e.target.value })}>
                      {[...new Set<Role>([u.role, ...grantable])].map((r) => (
                        <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <span className={`pill ${u.active ? "pill-ok" : "pill-off"}`}>{u.active ? "Active" : "Disabled"}</span>
                    {u.totp_enabled && <span className="pill pill-muted">2FA</span>}
                  </td>
                  <td>
                    {u.role !== "operator" ? (
                      <span className="muted">All</span>
                    ) : editing === u.id ? (
                      <AssignEditor user={u} devices={devices} onDone={() => (setEditing(null), load())} />
                    ) : (
                      <button className="ghost" onClick={() => setEditing(u.id)}>{u.device_ids.length} assigned</button>
                    )}
                  </td>
                  <td className="muted small nowrap">{when(u.last_login_at)}</td>
                  <td>
                    {manage && (
                      <div className="icon-actions">
                        <button className="icon-btn" title="Edit name" onClick={() => setRenaming({ id: u.id, name: u.name ?? "" })}><Icon name="edit" /></button>
                        <button className="icon-btn" title="Set password" onClick={() => changePassword(u)}><Icon name="key" /></button>
                        {u.totp_enabled && !self && (
                          <button className="icon-btn" title="Turn off two-factor login" onClick={() => reset2fa(u)}><Icon name="shield" /></button>
                        )}
                        {!self && (
                          <button className={`icon-btn${u.active ? " danger-icon" : ""}`} title={u.active ? "Disable" : "Enable"}
                            onClick={() => toggleActive(u)}><Icon name={u.active ? "off" : "on"} /></button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
