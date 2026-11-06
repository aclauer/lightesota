import { findProfile, type OutputStatus, type Rig, type Settings } from "@lightesota/shared";
import type { Engine, EngineFrame } from "../engine/engine.js";
import { OUT_STRIDE } from "../engine/sandbox.js";
import { ArtNetListener, ArtNetSender } from "./artnet.js";
import { planUniverse, renderUniverse, type DmxPlan } from "./dmx.js";
import { HueBridge } from "./hue.js";

/** Converts engine frames to DMX/Hue and keeps the status block the UI shows. */
export class OutputManager {
  private sender: ArtNetSender | null = null;
  private listener: ArtNetListener | null = null;
  hue: HueBridge | null = null;
  private plan: DmxPlan | null = null;
  private universe = new Uint8Array(512);
  private settings: Settings;
  private rig: Rig;
  private fpsCount = 0;
  private fpsWindow = Date.now();
  private fps = 0;
  private lastHueAt = 0;
  private engineStatus = { fps: 0, patternError: undefined as string | undefined, restarts: 0 };
  released = false;
  dmxSubscribers = 0;
  onDmx: ((universe: number, data: Uint8Array) => void) | null = null;

  constructor(private engine: Engine, settings: Settings, rig: Rig) {
    this.settings = settings;
    this.rig = rig;
    this.engine.on("frame", (f) => this.onFrame(f));
    this.engine.on("status", (s) => { this.engineStatus = { fps: s.fps, patternError: s.patternError, restarts: s.restarts }; });
    this.apply(settings, rig);
  }

  apply(settings: Settings, rig: Rig) {
    this.settings = settings;
    this.rig = rig;
    this.plan = planUniverse(rig, settings.artnet.universe);
    // Sender
    if (settings.artnet.enabled) {
      if (!this.sender || this.sender.opts.host !== settings.artnet.host || this.sender.opts.port !== settings.artnet.port) {
        this.sender?.close();
        this.sender = new ArtNetSender({ host: settings.artnet.host, port: settings.artnet.port });
      }
    } else { this.sender?.close(); this.sender = null; }
    // Upstream listener
    const up = settings.artnet.upstream;
    if (up.enabled) {
      if (!this.listener || this.listener.port !== up.listenPort) {
        this.listener?.stop();
        this.listener = new ArtNetListener(up.listenPort, up.allowFrom);
        this.listener.on("error", (e) => console.warn("[artnet] upstream listener:", e));
        this.listener.start();
      }
      this.listener.allowFrom = up.allowFrom;
    } else { this.listener?.stop(); this.listener = null; }
    // Hue
    if (settings.hue.enabled && settings.hue.bridgeIp) {
      if (!this.hue || this.hue.ip !== settings.hue.bridgeIp) { this.hue?.stop(); this.hue = new HueBridge(settings.hue.bridgeIp, settings.hue.username, settings.hue.rateHz); }
      this.hue.username = settings.hue.username;
      this.hue.rateHz = settings.hue.rateHz;
    } else if (!settings.hue.enabled) { this.hue?.stop(); this.hue = null; }
  }

  get planInfo() { return this.plan; }

  private onFrame(frame: EngineFrame) {
    const u = this.settings.artnet.universe;
    const upstream = this.listener?.fresh(u) ?? null;
    if (this.released) {
      // Hand-off: pass upstream through untouched, or stop transmitting entirely.
      if (upstream && this.sender) { this.sender.send(u, upstream); this.countFps(); this.onDmx?.(u, upstream); }
      return;
    }
    const buf = this.universe;
    if (upstream) buf.set(upstream); else buf.fill(0);
    if (this.plan) renderUniverse(this.rig, frame.fixtures, frame.values, u, this.plan, buf);
    // Belt and braces: protected channels come only from upstream (or stay 0).
    if (this.plan) for (let c = 0; c < 512; c++) if (this.plan.protectedMask[c]) buf[c] = upstream ? upstream[c] : 0;
    if (this.sender) { this.sender.send(u, buf); this.countFps(); }
    this.onDmx?.(u, buf);
    // Hue
    if (this.hue && this.settings.hue.enabled && this.settings.hue.username && Date.now() - this.lastHueAt > 100) {
      this.lastHueAt = Date.now();
      for (let i = 0; i < frame.fixtures.length; i++) {
        const f = frame.fixtures[i];
        if (!f.hueLightId) continue;
        const p = findProfile(f.profileId, this.rig.customProfiles);
        if (!p || p.transport !== "hue") continue;
        const o = i * OUT_STRIDE;
        const v = frame.values;
        const w = v[o + 3];
        this.hue.setColor(f.hueLightId, Math.min(1, v[o] + w), Math.min(1, v[o + 1] + w), Math.min(1, v[o + 2] + w), v[o + 6]);
      }
    }
  }

  private countFps() {
    this.fpsCount++;
    const now = Date.now();
    if (now - this.fpsWindow >= 1000) { this.fps = Math.round((this.fpsCount * 1000) / (now - this.fpsWindow)); this.fpsCount = 0; this.fpsWindow = now; }
  }

  /** Send a few all-zero frames so the rig goes dark on shutdown (only when we own the output). */
  async blackoutAndClose() {
    if (this.sender && !this.released) {
      const zeros = new Uint8Array(512);
      for (let i = 0; i < 3; i++) { this.sender.send(this.settings.artnet.universe, zeros); await new Promise((r) => setTimeout(r, 30)); }
    }
    this.sender?.close();
    this.listener?.stop();
    this.hue?.stop();
  }

  status(hasApiKey: boolean): OutputStatus {
    return {
      artnet: { sending: !!this.sender && !(this.released && !this.listener?.fresh(this.settings.artnet.universe)), fps: this.fps, lastSentAt: this.sender?.lastSentAt ?? 0, frames: this.sender?.frames ?? 0, error: this.sender?.error },
      upstream: { listening: !!this.listener, lastFrameAt: this.listener?.lastFrameAt ?? 0, from: this.listener?.lastFrom ?? "", frames: this.listener?.frames ?? 0 },
      hue: { connected: this.hue?.connected ?? false, lights: this.hue?.lightCount ?? 0, lastError: this.hue?.lastError },
      engine: { fps: this.engineStatus.fps, patternError: this.engineStatus.patternError, restarts: this.engineStatus.restarts },
      hasApiKey,
    };
  }
}
