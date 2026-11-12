import type { LiveMessage } from "./types";

type Handler = (msg: LiveMessage) => void;

/**
 * The dashboard's single WebSocket to /ws/operator. Reconnects with backoff and fans
 * messages out to subscribers. Emits {type: "_connected"} and {type: "_disconnected"}.
 */
class Live {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private backoff = 1000;
  private wanted = false;
  private timer: number | undefined;
  private pinger: number | undefined;
  connected = false;

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.connect();
  }

  stop() {
    this.wanted = false;
    window.clearTimeout(this.timer);
    this.ws?.close();
    this.ws = null;
  }

  subscribe(fn: Handler) {
    this.handlers.add(fn);
    return () => {
      this.handlers.delete(fn);
    };
  }

  send(msg: LiveMessage): boolean {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private emit(msg: LiveMessage) {
    this.handlers.forEach((fn) => fn(msg));
  }

  private connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws/operator`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 1000;
      this.connected = true;
      this.emit({ type: "_connected" });
      this.pinger = window.setInterval(() => this.send({ type: "ping" }), 25000);
    };
    ws.onmessage = (ev) => {
      try {
        this.emit(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    ws.onclose = (ev) => {
      window.clearInterval(this.pinger);
      const was = this.connected;
      this.connected = false;
      if (was) this.emit({ type: "_disconnected" });
      if (ev.code === 4401) {
        this.wanted = false;
        this.emit({ type: "signed_out" });
        return;
      }
      if (this.wanted && this.ws === ws) {
        this.timer = window.setTimeout(() => this.connect(), this.backoff);
        this.backoff = Math.min(this.backoff * 2, 30000);
      }
    };
  }
}

export const live = new Live();
