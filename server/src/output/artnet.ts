import dgram from "node:dgram";
import { EventEmitter } from "node:events";

const HEADER = Buffer.from("Art-Net\0", "ascii");
const OP_DMX = 0x5000;

export function buildArtDmx(universe: number, data: Uint8Array, sequence: number): Buffer {
  const len = 512;
  const buf = Buffer.alloc(18 + len);
  HEADER.copy(buf, 0);
  buf.writeUInt16LE(OP_DMX, 8);
  buf.writeUInt16BE(14, 10);          // protocol version
  buf[12] = sequence;                 // 1..255, 0 = disabled
  buf[13] = 0;                        // physical port
  buf.writeUInt16LE(universe & 0x7fff, 14);
  buf.writeUInt16BE(len, 16);
  buf.set(data.subarray(0, len), 18);
  return buf;
}

export function parseArtDmx(msg: Buffer): { universe: number; data: Uint8Array } | null {
  if (msg.length < 18 || !msg.subarray(0, 8).equals(HEADER)) return null;
  if (msg.readUInt16LE(8) !== OP_DMX) return null;
  const universe = msg.readUInt16LE(14);
  const len = Math.min(msg.readUInt16BE(16), msg.length - 18, 512);
  const data = new Uint8Array(512);
  data.set(msg.subarray(18, 18 + len));
  return { universe, data };
}

export interface ArtNetSenderOptions { host: string; port: number; }

/** Unicast Art-Net sender for a single universe with keepalive refresh. */
export class ArtNetSender {
  private socket: dgram.Socket | null = null;
  private seq = 1;
  frames = 0;
  lastSentAt = 0;
  error: string | undefined;
  constructor(public opts: ArtNetSenderOptions) {}

  private ensure() {
    if (this.socket) return;
    this.socket = dgram.createSocket("udp4");
    this.socket.on("error", (e) => { this.error = e.message; });
    this.socket.unref();
  }

  send(universe: number, data: Uint8Array) {
    this.ensure();
    const pkt = buildArtDmx(universe, data, this.seq);
    this.seq = this.seq >= 255 ? 1 : this.seq + 1;
    this.socket!.send(pkt, this.opts.port, this.opts.host, (err) => {
      if (err) this.error = err.message; else this.error = undefined;
    });
    this.frames++;
    this.lastSentAt = Date.now();
  }

  close() { this.socket?.close(); this.socket = null; }
}

interface UpstreamEvents { frame: [{ universe: number; data: Uint8Array; from: string }]; error: [string]; }

/**
 * Listens for Art-Net from an upstream controller (Home Assistant) so its frame can be merged
 * with ours. Lets this app be the single sender the ODE sees while HA keeps driving the lasers.
 */
export class ArtNetListener extends EventEmitter<UpstreamEvents> {
  private socket: dgram.Socket | null = null;
  lastFrameAt = 0;
  lastFrom = "";
  frames = 0;
  readonly universes = new Map<number, Uint8Array>();

  constructor(public port: number, public allowFrom: string) { super(); }

  start() {
    if (this.socket) return;
    const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
    s.on("message", (msg, rinfo) => {
      if (this.allowFrom && rinfo.address !== this.allowFrom) return;
      const p = parseArtDmx(msg);
      if (!p) return;
      this.universes.set(p.universe, p.data);
      this.lastFrameAt = Date.now();
      this.lastFrom = rinfo.address;
      this.frames++;
      this.emit("frame", { ...p, from: rinfo.address });
    });
    s.on("error", (e) => { this.emit("error", e.message); this.socket = null; });
    s.bind(this.port);
    s.unref();
    this.socket = s;
  }

  /** Upstream frame for a universe if it is fresh (< maxAgeMs). */
  fresh(universe: number, maxAgeMs = 5000): Uint8Array | null {
    if (Date.now() - this.lastFrameAt > maxAgeMs) return null;
    return this.universes.get(universe) ?? null;
  }

  stop() { this.socket?.close(); this.socket = null; }
}
