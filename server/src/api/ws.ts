import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { nanoid } from "nanoid";
import {
  requiredRole, roleAllows, type ClientMessage, type Presence, type Role, type ServerMessage, type Rig, type Settings,
} from "../../../shared/src/index.js";
import { deepMerge } from "../store.js";
import type { AppContext } from "./context.js";
import { validateRig } from "./validate.js";

interface Client { ws: WebSocket; id: string; role: Role; name: string; color: string; connectedAt: number; wantsDmx: boolean; alive: boolean; }

const COLORS = ["#ff6b6b", "#ffa94d", "#ffd43b", "#69db7c", "#38d9a9", "#4dabf7", "#9775fa", "#f783ac", "#63e6be", "#a9e34b"];

export class WsHub {
  private wss: WebSocketServer;
  private clients = new Map<string, Client>();
  private lastFrameSent = 0;
  private lastDmxSent = 0;

  constructor(server: Server, private ctx: AppContext) {
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.wss.on("connection", (ws, req) => {
      const role = ctx.auth.roleForRequest(req);
      const id = nanoid(8);
      const client: Client = { ws, id, role, name: `Guest ${this.clients.size + 1}`, color: COLORS[this.clients.size % COLORS.length], connectedAt: Date.now(), wantsDmx: false, alive: true };
      this.clients.set(id, client);
      this.send(client, { type: "hello", clientId: id, role, serverTime: Date.now(), name: client.name });
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

  presence(): Presence[] {
    return [...this.clients.values()].map((c) => ({ id: c.id, name: c.name, role: c.role, color: c.color, connectedAt: c.connectedAt }));
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
    try { msg = JSON.parse(raw) as ClientMessage; } catch { return; }
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
    switch (msg.type) {
      case "ping": this.send(client, { type: "pong", t: msg.t, serverTime: Date.now() }); return;
      case "setName": client.name = String(msg.name).slice(0, 24) || client.name; this.broadcastPresence(); return;
      case "setPattern": show.setPattern(msg.patternId, msg.params, msg.crossfadeMs); return;
      case "setParams": show.setParams(msg.params, msg.merge ?? true); return;
      case "setMaster": show.setMaster(Number(msg.master)); return;
      case "setBlackout": show.setBlackout(!!msg.blackout); return;
      case "setSpeed": show.setSpeed(Number(msg.speed)); return;
      case "setCrossfade": show.setCrossfade(Number(msg.crossfadeMs)); return;
      case "setBpm": show.setBpm(Number(msg.bpm)); return;
      case "tap": show.tap(); return;
      case "resync": show.resync(); return;
      case "nudge": show.nudge(Number(msg.ms)); return;
      case "setOverride": show.setOverride(msg.fixtureId, msg.override); return;
      case "clearOverrides": show.clearOverrides(); return;
      case "setSolo": show.setSolo(msg.fixtureIds); return;
      case "setReleased": show.setReleased(!!msg.released); ctx.output.released = !!msg.released; return;
      case "recallScene": show.recallScene(msg.sceneId, msg.crossfadeMs); return;
      case "saveScene": return show.captureScene(msg.name, msg.sceneId);
      case "updateScene": {
        const s = library.scenes.find((x) => x.id === msg.scene.id);
        if (!s) throw new Error("Scene not found");
        const { id: _id, ...patch } = msg.scene;
        library.upsertScene({ ...s, ...patch, updatedAt: Date.now() });
        return;
      }
      case "deleteScene": library.deleteScene(msg.sceneId); return;
      case "reorderScenes": library.reorderScenes(msg.ids); return;
      case "savePlaylist": {
        const pl = msg.playlist;
        if (!pl.id) pl.id = nanoid(8);
        pl.updatedAt = Date.now();
        pl.createdAt ||= pl.updatedAt;
        library.upsertPlaylist(pl);
        return pl.id;
      }
      case "deletePlaylist": library.deletePlaylist(msg.playlistId); if (show.state.playlist?.playlistId === msg.playlistId) show.stopPlaylist(); return;
      case "playPlaylist": show.playPlaylist(msg.playlistId, msg.stepIndex); return;
      case "stopPlaylist": show.stopPlaylist(); return;
      case "playlistNext": show.playlistNext(); return;
      case "playlistPrev": show.playlistPrev(); return;
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
        return;
      case "duplicatePattern": {
        const p = library.duplicatePattern(msg.patternId);
        this.send(client, { type: "pattern", pattern: p });
        return p.id;
      }
      case "setRig": {
        const rig = validateRig(msg.rig as Rig);
        ctx.rigFile.set(rig);
        ctx.applyConfig();
        this.broadcast({ type: "rig", rig });
        return;
      }
      case "setSettings": {
        const merged = deepMerge(ctx.settingsFile.get(), msg.settings);
        merged.artnet.fps = Math.max(5, Math.min(60, Number(merged.artnet.fps) || 40));
        merged.previewFps = Math.max(5, Math.min(40, Number(merged.previewFps) || 20));
        ctx.settingsFile.set(merged);
        ctx.applyConfig();
        this.broadcastSettings(merged);
        return;
      }
      case "subscribeDmx": client.wantsDmx = msg.on; return;
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
      case "audio": show.setAudio(client.id, client.name, msg.frame); return;
      case "setFollowMicBpm": show.setFollowMicBpm(!!msg.on); return;
      case "setSleep": show.setSleep(msg.minutes === null ? null : Number(msg.minutes)); return;
      case "testFixture": {
        // Flash a single fixture white for a moment via a temporary override.
        const secs = Math.min(10, Math.max(0.5, msg.seconds ?? 2));
        show.setOverride(msg.fixtureId, { r: 1, g: 1, b: 1, w: 1, dim: 1, mix: 1 });
        setTimeout(() => { if (show.state.overrides[msg.fixtureId]?.w === 1) show.setOverride(msg.fixtureId, null); }, secs * 1000);
        return;
      }
    }
  }

  private handleAgent(client: Client, cmd: ClientMessage extends infer T ? T extends { type: "agent"; command: infer C } ? C : never : never) {
    const agent = this.ctx.agent;
    const sendTo = (ev: Parameters<typeof agent["broadcast"]>[0]) => this.send(client, { type: "agent", event: ev });
    switch (cmd.type) {
      case "list": sendTo({ type: "conversations", conversations: agent.list() }); return;
      case "new": { const c = agent.create(); const { history: _h, ...pub } = c; sendTo({ type: "conversation", conversation: pub }); sendTo({ type: "conversations", conversations: agent.list() }); return c.id; }
      case "open": { const c = agent.open(cmd.conversationId); if (!c) throw new Error("Conversation not found"); sendTo({ type: "conversation", conversation: c }); return; }
      case "delete": agent.delete(cmd.conversationId); sendTo({ type: "conversations", conversations: agent.list() }); return;
      case "cancel": agent.cancel(cmd.conversationId); return;
      case "send":
        agent.send(cmd.conversationId, cmd.text, cmd.context).catch((e: Error) => this.send(client, { type: "error", text: e.message }));
        return;
    }
  }
}
