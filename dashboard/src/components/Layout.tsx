import { useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../auth";
import { live } from "../live";

interface Alert {
  id: number;
  message: string;
}

export default function Layout() {
  const { me, signOut } = useAuth();
  const [connected, setConnected] = useState(live.connected);
  const [alerts, setAlerts] = useState<Alert[]>([]);

  useEffect(
    () =>
      live.subscribe((m) => {
        if (m.type === "_connected") setConnected(true);
        if (m.type === "_disconnected") setConnected(false);
        if (m.type === "alert") setAlerts((a) => [...a.slice(-4), { id: Date.now() + Math.random(), message: m.message }]);
      }),
    [],
  );

  const admin = me.role === "admin" || me.role === "superuser";
  return (
    <div className="app">
      <aside className="sidebar">
        <span className="brand">MT5 Phones</span>
        <nav>
          <NavLink to="/" end>Phones</NavLink>
          {admin && <NavLink to="/devices">Devices</NavLink>}
          {admin && <NavLink to="/users">Users</NavLink>}
          <NavLink to="/settings">Settings{me.totp_enabled ? "" : " ⚠"}</NavLink>
        </nav>
        <div className="sidebar-foot">
          <span className="who">
            <span className={`dot ${connected ? "ok" : "bad"}`} title={connected ? "Live" : "Reconnecting"} />
            <span className="muted small" title={me.email}>{me.email}</span>
          </span>
          <button className="ghost" onClick={signOut}>Sign out</button>
        </div>
      </aside>
      <div className="content">
      {me.must_enable_2fa && (
        <div className="alerts">
          <div className="alert">
            <span>Admin accounts must use two-factor login. Phones and admin pages stay locked until you turn it on.</span>
            <Link className="button" to="/settings">Turn on two-factor login</Link>
          </div>
        </div>
      )}
      {alerts.length > 0 && (
        <div className="alerts">
          {alerts.map((a) => (
            <div key={a.id} className="alert">
              <span>{a.message}</span>
              <button className="ghost" onClick={() => setAlerts((x) => x.filter((y) => y.id !== a.id))}>×</button>
            </div>
          ))}
        </div>
      )}
      <main>
        <Outlet />
      </main>
      </div>
    </div>
  );
}
