export type Role = "superuser" | "admin" | "operator";

export interface Me {
  id: string;
  email: string;
  role: Role;
  totp_enabled: boolean;
}

export interface DeviceStatus {
  battery?: number | null;
  charging?: boolean | null;
  signal?: number | null;
  carrier?: string | null;
  network_type?: string | null;
  capture_ready?: boolean | null;
  input_ready?: boolean | null;
  capture_mode?: "projection" | "fallback" | "none" | null;
  screen_on?: boolean | null;
  locked?: boolean | null;
  ip?: string;
  received_at?: string;
}

export interface Lock {
  session_id: string;
  user_id: string;
  user_email: string | null;
  started_at?: string;
}

export interface VideoSettings {
  width: number;
  fps: number;
  bitrate: number;
}

export interface Device {
  id: string;
  name: string;
  model: string | null;
  android_version: string | null;
  app_version: string | null;
  sim_carrier: string | null;
  notes: string | null;
  video_settings: VideoSettings;
  online: boolean;
  last_seen_at: string | null;
  status: DeviceStatus;
  lock: Lock | null;
}

export interface Account {
  id: string;
  device_id: string;
  device_name?: string;
  login: string;
  broker_server: string;
  label: string | null;
  notes: string | null;
}

export interface UserRow {
  id: string;
  email: string;
  role: Role;
  active: boolean;
  totp_enabled: boolean;
  created_at: string | null;
  device_ids: string[];
}

export interface SessionRow {
  id: string;
  device_id: string;
  device_name: string;
  user_id: string;
  user_email: string;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
}

export interface AuditRow {
  id: number;
  at: string;
  user_id: string | null;
  user_email: string | null;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

export type LiveMessage = { type: string; [key: string]: any };
