export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dateTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function duration(start: string, end: string | null): string {
  const ms = (end ? new Date(end).getTime() : Date.now()) - new Date(start).getTime();
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return m ? `${m}m ${s}s` : `${s}s`;
}

/** Signal in dBm to 0–4 bars (LTE RSRP-ish thresholds). */
export function signalBars(dbm: number | null | undefined): number {
  if (dbm == null) return 0;
  if (dbm >= -85) return 4;
  if (dbm >= -95) return 3;
  if (dbm >= -105) return 2;
  if (dbm >= -115) return 1;
  return 0;
}
