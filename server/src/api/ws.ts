import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import {
  requiredRole, roleAllows, type ClientMessage, type Presence, type Role, type ServerMessage, type Rig, type Settings,
} from "../../../shared/src/index.js";
import { deepMerge } from "../store.js";
import { parseCookies } from "./auth.js";
import { DEVICE_COOKIE, newDeviceId } from "./devices.js";
import type { AppContext } from "./context.js";
import { validateRig, validateSettings, validateScene, validatePlaylist, validateAudio } from "./validate.js";
import { dispatchControl, isControlCommand } from "./commands.js";

interface Client { ws: WebSocket; id: string; deviceId: string; role: Role; name: string; color: string; connectedAt: number; wantsDmx: boolean; alive: boolean; ip: string; openConv: string | null; listAll: boolean; }

/** Sliding-window counter keyed by string (per device ip, or "*" for everyone). */
class RateLimiter {
  private hits = new Map<string, number[]>();
  /** Returns 0 if allowed (and records the hit), else seconds until the next slot. */
  take(key: string, limit: number, windowMs = 3600_000): number {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= limit) { this.hits.set(key, list); return Math.ceil((list[0] + windowMs - now) / 1000); }
    list.push(now);
    this.hits.set(key, list);
    return 0;
  }
  private last = new Map<string, number>();
  /** Cooldown: returns 0 if at least `sec` seconds passed since the last hit for key (and records it), else seconds to wait. */
  cooldown(key: string, sec: number): number {
    const now = Date.now();
    const prev = this.last.get(key) ?? 0;
    if (now - prev < sec * 1000) return Math.ceil((prev + sec * 1000 - now) / 1000);
    this.last.set(key, now);
    return 0;
  }
}

const hashStr = (s: string) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; };
const fmtWait = (s: number) => (s < 90 ? `${s} s` : `${Math.ceil(s / 60)} min`);
const COLORS = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#4dabf7", "#9775fa", "#f783ac", "#63e6be", "#a9e34b"];

export class WsHub {
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  private limiter = new RateLimiter();
  private lastFrameSent = 0;
  private lastDmxSent = 0;

  constructor(server: Server, private ctx: AppContext) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws, req) => {
      const role = ctx.auth.roleForRequest(req);
      const id = nanoid(8);
      const ip = (typeof req.headers["x-forwarded-for"] === "string" ? req.headers["x-forwarded-for"].split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
      const deviceId = parseCookies(req.headers.cookie)[DEVICE_COOKIE] || newDeviceId();
      const known = ctx.devices.touch(deviceId, { role, visits: 1 });
      const color = COLORS[hashStr(deviceId) % COLORS.length];
      const client: Client = { ws, id, deviceId, role, name: known.name || `Guest ${this.clients.size + 1}`, color, connectedAt: Date.now(), wantsDmx: false, alive: true, ip, openConv: null, listAll: false };
      this.clients.set(id, client);
      this.send(client, { type: "hello", clientId: id, deviceId, role, serverTime: Date.now(), name: client.name });
      this.send(client, this.snapshot(client.role));
      this.broadcastPresence();
      ws.on("message", (data) => this.onMessage(client, data.toString()));
      ws.on("pong", () => { client.alive = true; });
      ws.on("close", () => { this.clients.delete(id); ctx.show.setAudio(id, client.name, null); this.broadcastPresence(); });
      ws.on("error", () => { /* close follows */ });
    });
    setInterval(() => {
      for (const c of this.clients.values()) {
        if (!c.alive) { c.ws.terminate(); continue; }
        c.alive = false;
        c.ws.ping();
      }
    }, 30000).unref();

    // Wire domain events.
    ctx.show.on("show", (show) => this.broadcast({ type: "show", show }));
    ctx.show.on("toast", (t) => this.broadcast({ type: "toast", ...t }));
    ctx.library.on("patterns", () => this.broadcast({ type: "patterns", patterns: ctx.library.listPatterns() }));
    ctx.library.on("scenes", () => this.broadcast({ type: "scenes", scenes: ctx.library.scenes }));
    ctx.library.on("playlists", () => this.broadcast({ type: "playlists", playlists: ctx.library.playlists }));
    ctx.show.engine.on("frame", (f) => {
      const now = Date.now();
      const interval = 1000 / Math.max(5, Math.min(40, ctx.settingsFile.get().previewFps));
      if (now - this.lastFrameSent < interval) return;
      this.lastFrameSent = now;
      this.broadcast({ type: "frame", t: now, colors: f.colors });
    });
    ctx.output.onDmx = (universe, data) => {
      const now = Date.now();
      if (now - this.lastDmxSent < 100) return;
      this.lastDmxSent = now;
      const msg: ServerMessage = { type: "dmx", universe, data: Array.from(data) };
      for (const c of this.clients.values()) if (c.wantsDmx && roleAllows(c.role, "editor")) this.send(c, msg);
    };
    ctx.show.engine.on("log", (line) => {
      const msg: ServerMessage = { type: "toast", level: "info", text: `pattern: ${line}` };
      for (const c of this.clients.values()) if (roleAllows(c.role, "editor")) this.send(c, msg);
    });
    setInterval(() => this.broadcast({ type: "status", status: ctx.output.status(ctx.agent.hasCredentials()) }), 1000).unref();
  }

  snapshot(role: Role): ServerMessage {
    const c = this.ctx;
    return {
      type: "snapshot", rig: c.rigFile.get(), show: c.show.state, patterns: c.library.listPatterns(), scenes: c.library.scenes,
      playlists: c.library.playlists, settings: this.publicSettings(c.settingsFile.get(), role), status: c.output.status(c.agent.hasCredentials()), presence: this.presence(),
    };
  }

  /** Strip secrets (the Hue app key) for everyone below admin. */
  private publicSettings(s: Settings, role: Role): Settings {
    if (roleAllows(role, "admin")) return s;
    return { ...s, hue: { ...s.hue, username: s.hue.username ? "(hidden)" : "" } };
  }
  private broadcastSettings(s: Settings) {
    for (const c of this.clients.values()) this.send(c, { type: "settings", settings: this.publicSettings(s, c.role) });
  }

  /** One presence row per device, however many tabs it has open. */
  presence(): Presence[] {
    const byDevice = new Map<string, Presence>();
    for (const c of this.clients.values()) {
      const p = byDevice.get(c.deviceId);
      if (p) { p.connections++; if (roleAllows(c.role, p.role)) p.role = c.role; }
      else byDevice.set(c.deviceId, { id: c.id, deviceId: c.deviceId, name: c.name, role: c.role, color: c.color, connectedAt: c.connectedAt, connections: 1 });
    }
    return [...byDevice.values()];
  }
  broadcastPresence() { this.broadcast({ type: "presence", presence: this.presence() }); }

  broadcast(msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
  broadcastRole(minRole: Role, msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const c of this.clients.values()) if (roleAllows(c.role, minRole) && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
  private send(c: Client, msg: ServerMessage) { if (c.ws.readyState === WebSocket.OPEN) c.ws.send(JSON.stringify(msg)); }

  private onMessage(client: Client, raw: string) {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw) as ClientMessage; if (!msg || typeof msg !== "object" || Array.isArray(msg)) return; } catch { return; }
    const reqId = "reqId" in msg ? msg.reqId : undefined;
    if (!roleAllows(client.role, requiredRole(msg))) {
      this.send(client, { type: "error", text: `Not allowed (${client.role} role)`, reqId });
      return;
    }
    try {
      const result = this.handle(client, msg);
      if (reqId) this.send(client, { type: "ack", reqId, result });
    } catch (e) {
      this.send(client, { type: "error", text: (e as Error).message, reqId });
    }
  }

  private handle(client: Client, msg: ClientMessage): unknown {
    const { show, library, ctx } = { show: this.ctx.show, library: this.ctx.library, ctx: this.ctx };
    if (isControlCommand(msg)) {
      dispatchControl(ctx, msg, client, (msg as ClientMessage & {generation?: number}).generation);
      this.broadcast({ type: "show", show: show.state });
      return { generation: show.state.generation };
    }
    switch (msg.type) {
      case "ping": this.send(client, { type: "pong", t: msg.t, serverTime: Date.now() }); return;
      case "setName": {
        const name = String(msg.name).trim().slice(0, 24);
        if (!name) return;
        ctx.devices.touch(client.deviceId, { name });
        for (const c of this.clients.values()) if (c.deviceId === client.deviceId) c.name = name;
        this.broadcastPresence();
        return;
      }
      case "saveScene": return show.captureScene(msg.name, msg.sceneId);
      case "updateScene": {
        const s = library.scenes.find((x) => x.id === msg.scene.id);
        if (!s) throw new Error("Scene not found");
        const { id: _id, ...patch } = msg.scene;
        library.upsertScene(validateScene({ ...s, ...patch, updatedAt: Date.now() }, ctx.rigFile.get()));
        return;
      }
      case "deleteScene": library.deleteScene(msg.sceneId); return;
      case "reorderScenes": library.reorderScenes(msg.ids); return;
      case "savePlaylist": {
        const pl = msg.playlist;
        if (!pl.id) pl.id = nanoid(8);
        pl.updatedAt = Date.now();
        pl.createdAt ||= pl.updatedAt;
        library.upsertPlaylist(validatePlaylist(pl));
        return pl.id;
      }
      case "deletePlaylist": library.deletePlaylist(msg.playlistId); if (show.state.playlist?.playlistId === msg.playlistId) show.stopPlaylist(); return;
      case "getPattern": {
        const p = library.getPattern(msg.patternId);
        if (!p) throw new Error("Pattern not found");
        this.send(client, { type: "pattern", pattern: p });
        return;
      }
      case "savePattern": {
        const saved = library.savePattern(msg.pattern);
        show.patternUpdated(saved.id);
        this.send(client, { type: "pattern", pattern: saved });
        return saved.id;
      }
      case "deletePattern":
        if (show.state.patternId === msg.patternId) show.setPattern(null);
        library.deletePattern(msg.patternId);
        show.forgetPattern(msg.patternId);
        return;
      case "duplicatePattern": {
        const p = library.duplicatePattern(msg.patternId);
        this.send(client, { type: "pattern", pattern: p });
        return p.id;
      }
      case "setRig": {
        const rig = validateRig(msg.rig as Rig);
        show.stopLighting();
        ctx.rigFile.set(rig);
        ctx.applyConfig();
        this.broadcast({ type: "rig", rig });
        return;
      }
      case "setSettings": {
        const merged = validateSettings(deepMerge(ctx.settingsFile.get(), msg.settings));
        show.stopLighting();
        ctx.settingsFile.set(merged);
        ctx.applyConfig();
        this.broadcastSettings(merged);
        return;
      }
      case "subscribeDmx": client.wantsDmx = msg.on; return;
      case "listDevices": this.send(client, { type: "devices", devices: ctx.devices.list() }); return;
      case "forgetDevice": ctx.devices.forget(msg.deviceId); this.send(client, { type: "devices", devices: ctx.devices.list() }); return;
      case "agent": return this.handleAgent(client, msg.command);
      case "huePair": {
        const hue = ctx.output.hue;
        if (!hue) throw new Error("Enable Hue and set the bridge IP first");
        hue.pair().then((username) => {
          ctx.settingsFile.update((s) => ({ ...s, hue: { ...s.hue, username } }));
          ctx.applyConfig();
          this.broadcastSettings(ctx.settingsFile.get());
          this.send(client, { type: "toast", level: "success", text: "Paired with the Hue bridge" });
          if (msg.reqId) this.send(client, { type: "ack", reqId: msg.reqId, result: true });
        }).catch((e: Error) => this.send(client, { type: "error", text: `Hue pairing failed: ${e.message}`, reqId: msg.reqId }));
        return;
      }
      case "hueListLights": {
        const hue = ctx.output.hue;
        if (!hue) throw new Error("Enable Hue first");
        hue.listLights().then((lights) => this.send(client, { type: "hueLights", lights }))
          .catch((e: Error) => this.send(client, { type: "error", text: `Hue: ${e.message}`, reqId: msg.reqId }));
        return;
      }
      case "audio": {
        if (msg.frame !== null && (msg as ClientMessage & {generation?: number}).generation !== show.state.generation) throw new Error("Stale control generation");
        show.setAudio(client.id, client.name, msg.frame === null ? null : validateAudio(msg.frame)); return;
      }
      default: throw new Error("Unknown message type");
    }
  }

  /** Agent events go to the conversation owner's devices and to anyone who has it open (admins may). */
  agentEvent(ev: Parameters<AppContext["agent"]["send"]> extends never ? never : import("../../../shared/src/index.js").AgentEvent, conversationId: string | null, owner: string | undefined) {
    for (const c of this.clients.values()) {
      const involved = (owner && c.deviceId === owner) || (conversationId !== null && c.openConv === conversationId);
      if (!involved) continue;
      if (ev.type === "conversations") this.send(c, { type: "agent", event: { type: "conversations", conversations: this.ctx.agent.list(c.deviceId, c.listAll && roleAllows(c.role, "admin")), all: c.listAll } });
      else this.send(c, { type: "agent", event: ev });
    }
  }

  private handleAgent(client: Client, cmd: ClientMessage extends infer T ? T extends { type: "agent"; command: infer C } ? C : never : never) {
    const agent = this.ctx.agent;
    const sendTo = (ev: Parameters<typeof agent["broadcast"]>[0]) => this.send(client, { type: "agent", event: ev });
    const isGuest = !roleAllows(client.role, "editor");
    if (isGuest) {
      const a = this.ctx.settingsFile.get().agent;
      if (!a.guestAccess) throw new Error("The agent is not open to guests right now");
      if (cmd.type === "delete") throw new Error("Guests cannot delete conversations");
      if (cmd.type === "send") {
        const wait = this.limiter.cooldown(client.deviceId, Math.max(1, a.guestIntervalSec));
        if (wait) throw new Error(`One prompt every ${a.guestIntervalSec} s per person. Try again in ${fmtWait(wait)}.`);
        const waitAll = this.limiter.take("*", Math.max(1, a.guestTotalPerHour));
        if (waitAll) throw new Error(`The room has used its agent budget for this hour. Try again in ${fmtWait(waitAll)}.`);
      }
    }
    const isAdmin = roleAllows(client.role, "admin");
    const canTouch = (id: string) => { const o = agent.ownerOf(id); return isAdmin || (o !== undefined && o === client.deviceId); };
    const listFor = () => ({ type: "conversations" as const, conversations: agent.list(client.deviceId, client.listAll && isAdmin), all: client.listAll && isAdmin });
    const owner = { deviceId: client.deviceId, name: client.name };
    switch (cmd.type) {
      case "list": client.listAll = !!cmd.all; sendTo(listFor()); return;
      case "new": { const c = agent.create(owner); client.openConv = c.id; const { history: _h, ...pub } = c; sendTo({ type: "conversation", conversation: pub }); sendTo(listFor()); return c.id; }
      case "open": { if (!canTouch(cmd.conversationId)) throw new Error("That conversation belongs to someone else"); const c = agent.open(cmd.conversationId); if (!c) throw new Error("Conversation not found"); client.openConv = c.id; sendTo({ type: "conversation", conversation: c }); return; }
      case "delete": if (!canTouch(cmd.conversationId)) throw new Error("That conversation belongs to someone else"); agent.delete(cmd.conversationId); sendTo(listFor()); return;
      case "cancel": if (!canTouch(cmd.conversationId)) throw new Error("That conversation belongs to someone else"); agent.cancel(cmd.conversationId); return;
      case "send":
        if (cmd.conversationId && !canTouch(cmd.conversationId)) throw new Error("That conversation belongs to someone else");
        if (cmd.conversationId) client.openConv = cmd.conversationId;
        agent.send(cmd.conversationId, cmd.text, { ...cmd.context, by: client.name, owner, role: client.role }).then((id) => { client.openConv = id; }).catch((e: Error) => this.send(client, { type: "error", text: e.message }));
        return;
    }
  }
}
