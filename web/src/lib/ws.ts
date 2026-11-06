import type { ClientMessage, ServerMessage } from "@lightesota/shared";

type Handler = (msg: ServerMessage) => void;

/** Reconnecting WebSocket client with request/ack correlation and server clock offset. */
export class WsClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private backoff = 500;
  private pingTimer: number | null = null;
  private reqCounter = 0;
  /** serverTime - clientTime (ms). */
  clockOffset = 0;
  connected = false;
  onStatus: ((connected: boolean) => void) | null = null;

  constructor(private url: string) {}

  connect() {
    if (this.ws) return;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.backoff = 500;
      this.onStatus?.(true);
      this.ping();
      this.pingTimer = window.setInterval(() => this.ping(), 5000);
    };
    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try { msg = JSON.parse(ev.data as string) as ServerMessage; } catch { return; }
      if (msg.type === "pong") {
        const now = Date.now();
        const rtt = now - msg.t;
        this.clockOffset = msg.serverTime + rtt / 2 - now;
      }
      if (msg.type === "ack" && msg.reqId) {
        const p = this.pending.get(msg.reqId);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.reqId); p.resolve(msg.result); }
      } else if (msg.type === "error" && msg.reqId) {
        const p = this.pending.get(msg.reqId);
        if (p) { clearTimeout(p.timer); this.pending.delete(msg.reqId); p.reject(new Error(msg.text)); return; }
      }
      for (const h of this.handlers) h(msg);
    };
    ws.onclose = () => {
      this.connected = false;
      this.ws = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("Disconnected: command result is unknown. Refresh state before retrying.")); }
      this.pending.clear();
      this.onStatus?.(false);
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 1.7);
    };
    ws.onerror = () => ws.close();
  }

  private ping() { this.send({ type: "ping", t: Date.now() }); }

  subscribe(h: Handler) { this.handlers.add(h); return () => this.handlers.delete(h); }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Send a message that carries a reqId and resolve with the ack result. */
  request<T = unknown>(msg: ClientMessage & { reqId?: string }): Promise<T> {
    if (!this.connected || this.ws?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Disconnected: command was not sent."));
    const reqId = `r${++this.reqCounter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => { this.pending.delete(reqId); reject(new Error("Request timed out")); }, 15000);
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ ...msg, reqId } as ClientMessage);
    });
  }

  serverNow() { return Date.now() + this.clockOffset; }
}

export function wsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/ws`;
}
