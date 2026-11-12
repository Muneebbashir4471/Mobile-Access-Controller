import { useEffect, useState } from "react";
import { api } from "./api";
import { live } from "./live";
import type { Device } from "./types";

/** Device list from REST, kept current by device_update / lock_update / device_removed events. */
export function useDevices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api<Device[]>("/api/devices")
        .then((d) => !cancelled && (setDevices(d), setError(null)))
        .catch((e) => !cancelled && setError(String(e.message ?? e)));
    load();
    const unsub = live.subscribe((msg) => {
      if (msg.type === "_connected") load(); // resync after a reconnect
      if (msg.type === "device_update") {
        setDevices((prev) => {
          if (!prev) return prev;
          const i = prev.findIndex((d) => d.id === msg.device_id);
          if (i < 0) return [...prev, msg.device].sort((a, b) => a.name.localeCompare(b.name));
          const next = prev.slice();
          next[i] = msg.device;
          return next;
        });
      } else if (msg.type === "lock_update") {
        setDevices((prev) => prev && prev.map((d) => (d.id === msg.device_id ? { ...d, lock: msg.lock } : d)));
      } else if (msg.type === "device_removed") {
        setDevices((prev) => prev && prev.filter((d) => d.id !== msg.device_id));
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  return { devices, error, setDevices };
}
