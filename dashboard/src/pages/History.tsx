import { useEffect, useState } from "react";
import { api } from "../api";
import { dateTime, duration } from "../format";
import type { AuditRow, Device, SessionRow, UserRow } from "../types";

export default function History() {
  const [tab, setTab] = useState<"sessions" | "audit">("sessions");
  const [devices, setDevices] = useState<Device[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [deviceId, setDeviceId] = useState("");
  const [userId, setUserId] = useState("");
  const [action, setAction] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);

  useEffect(() => {
    api<Device[]>("/api/devices").then(setDevices);
    api<UserRow[]>("/api/users").then(setUsers);
  }, []);

  useEffect(() => {
    const p = new URLSearchParams();
    if (userId) p.set("user_id", userId);
    if (tab === "sessions") {
      if (deviceId) p.set("device_id", deviceId);
      api<SessionRow[]>(`/api/sessions?${p}`).then(setSessions);
    } else {
      if (action) p.set("action", action);
      api<AuditRow[]>(`/api/audit?${p}`).then(setAudit);
    }
  }, [tab, deviceId, userId, action]);

  return (
    <>
      <div className="toolbar">
        <div className="seg">
          <button className={tab === "sessions" ? "on" : ""} onClick={() => setTab("sessions")}>Sessions</button>
          <button className={tab === "audit" ? "on" : ""} onClick={() => setTab("audit")}>Audit log</button>
        </div>
        <span className="spacer" />
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">All users</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
        </select>
        {tab === "sessions" ? (
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">All phones</option>
            {devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        ) : (
          <input placeholder="Action (e.g. takeover)" value={action} onChange={(e) => setAction(e.target.value.trim())} />
        )}
      </div>

      {tab === "sessions" ? (
        <table>
          <thead>
            <tr><th>Started</th><th>Phone</th><th>User</th><th>Length</th><th>Ended by</th></tr>
          </thead>
          <tbody>
            {sessions.map((s) => (
              <tr key={s.id}>
                <td>{dateTime(s.started_at)}</td>
                <td>{s.device_name}</td>
                <td>{s.user_email}</td>
                <td>{duration(s.started_at, s.ended_at)}{!s.ended_at && <span className="ok-text"> · live</span>}</td>
                <td>{s.end_reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <table>
          <thead>
            <tr><th>When</th><th>User</th><th>Action</th><th>Target</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id}>
                <td>{dateTime(a.at)}</td>
                <td>{a.user_email ?? "—"}</td>
                <td>{a.action}</td>
                <td className="mono small">{a.target}</td>
                <td className="mono small">{a.detail ? JSON.stringify(a.detail) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
