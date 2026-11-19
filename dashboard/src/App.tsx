import { useCallback, useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { api, onUnauthorized } from "./api";
import { AuthContext } from "./auth";
import Layout from "./components/Layout";
import { live } from "./live";
import Control from "./pages/Control";
import Devices from "./pages/Devices";
import Login from "./pages/Login";
import Phones from "./pages/Phones";
import Settings from "./pages/Settings";
import type { Me } from "./types";

export default function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);

  useEffect(() => {
    api<Me>("/api/auth/me").then(setMe).catch(() => setMe(null));
    const off = onUnauthorized(() => setMe(null));
    const unsub = live.subscribe((m) => m.type === "signed_out" && setMe(null));
    return () => {
      off();
      unsub();
    };
  }, []);

  useEffect(() => {
    if (me) live.start();
    else live.stop();
  }, [me]);

  const signOut = useCallback(() => {
    api("/api/auth/logout", { method: "POST" }).finally(() => setMe(null));
  }, []);

  if (me === undefined) return <div className="center muted">Loading…</div>;
  if (me === null) return <Login onSignedIn={setMe} />;

  const admin = me.role === "admin" || me.role === "superuser";
  return (
    <AuthContext.Provider value={{ me, setMe, signOut }}>
      <Routes>
        <Route path="/control/:deviceId" element={<Control />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Phones />} />
          <Route path="/settings" element={<Settings />} />
          {admin && <Route path="/devices" element={<Devices />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AuthContext.Provider>
  );
}
