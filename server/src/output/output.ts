import { findProfile, isLaserProfile, isHazeProfile, laserBytes, hazeBytes, type HazeState, type LasersState, type OutputStatus, type Rig, type Settings, type WashState } from "../../../shared/src/index.js";
import type { Engine, EngineFrame } from "../engine/engine.js";
import { OUT_STRIDE } from "../engine/sandbox.js";
import { ArtNetSender } from "./artnet.js";
import { planUniverse, renderUniverse, type DmxPlan } from "./dmx.js";
import { HueBridge } from "./hue.js";
import { OUTPUT_VETO, PREVIEW, OUTPUT_COMMISSIONED, HAZE_VETO, HAZE_DISABLED_REASON } from "./policy.js";

/** Converts engine frames to DMX/Hue and keeps the status block the UI shows. */
export class OutputManager {
  private sender: ArtNetSender | null = null;
  hue: HueBridge | null = null;
  private plan: DmxPlan | null = null;
  private universe = new Uint8Array(512);
  private settings: Settings;
  private rig: Rig;
  private fpsCount = 0;
  private fpsWindow = Date.now();
  private fps = 0;
  private lastHueAt = 0;
  private lastMuted = false;
  private generation: number | undefined;
  private outputError: string | undefined;
  private engineStatus = { fps: 0, patternError: undefined as string | undefined, restarts: 0 };
  get released() { return this.getLasers().released ?? false; }
  dmxSubscribers = 0;
  onDmx: ((universe: number, data: Uint8Array) => void) | null = null;

  constructor(private engine: Engine, settings: Settings, rig: Rig, private getLasers: () => { lasers: LasersState; haze?: HazeState; blackout: boolean; stopped?: boolean; released?: boolean; generation?: number; washes?: Record<string, WashState> }) {
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
    if (!OUTPUT_VETO && settings.artnet.enabled) {
      if (!this.sender || this.sender.opts.host !== settings.artnet.host || this.sender.opts.port !== settings.artnet.port) {
        this.sender?.close();
        this.sender = new ArtNetSender({ host: settings.artnet.host, port: settings.artnet.port });
      }
    } else { this.sender?.close(); this.sender = null; }
    // Legacy Art-Net senders are never listened to, merged or forwarded.
    // Hue
    if (!OUTPUT_VETO && settings.hue.enabled && settings.hue.bridgeIp) {
      if (!this.hue || this.hue.ip !== settings.hue.bridgeIp) { this.hue?.stop(); this.hue = new HueBridge(settings.hue.bridgeIp, settings.hue.username, settings.hue.rateHz); }
      this.hue.username = settings.hue.username;
      this.hue.rateHz = settings.hue.rateHz;
    } else { this.hue?.stop(); this.hue = null; }
  }

  get planInfo() { return this.plan; }

  private onFrame(frame: EngineFrame) {
    const u = this.settings.artnet.universe;
    const control = this.getLasers();
    const barrier = control.generation !== this.generation;
    this.generation = control.generation;
    if (barrier && this.hue) {
      try { this.hue.cancelPending(); } catch (e) { this.hue.lastError = (e as Error).message; }
    }
    if (this.released) {
      // Release stops sending. Legacy senders are never merged or passed through.
      return;
    }
    const buf = this.universe;
    buf.fill(0);
    if (this.plan) renderUniverse(this.rig, frame.fixtures, frame.values, u, this.plan, buf, control.washes);
    if (this.plan) this.writeLasers(u, buf);
    // Protected channels, including the uncommissioned hazer, always remain zero.
    if (this.plan) for (let c = 0; c < 512; c++) if (this.plan.protectedMask[c]) buf[c] = 0;
    if (control.blackout || control.stopped) buf.fill(0);
    if (this.sender) {
      try { this.sender.send(u, buf); this.countFps(); this.outputError = undefined; }
      catch (e) { this.outputError = `Art-Net output failed: ${(e as Error).message}`; }
    }
    try { this.onDmx?.(u, buf); } catch { /* A disconnected preview subscriber cannot block other outputs. */ }
    // Hue
    const muted = !!(control.blackout || control.stopped);
    if (this.hue && this.settings.hue.enabled && this.settings.hue.username && (barrier || muted !== this.lastMuted || Date.now() - this.lastHueAt > 100)) {
      this.lastHueAt = Date.now();
      if (muted && !this.lastMuted) {
        try { this.hue.cancelPending(); } catch (e) { this.hue.lastError = (e as Error).message; }
      }
      for (let i = 0; i < frame.fixtures.length; i++) {
        const f = frame.fixtures[i];
        if (!f.hueLightId) continue;
        const p = findProfile(f.profileId, this.rig.customProfiles);
        if (!p || p.transport !== "hue") continue;
        const o = i * OUT_STRIDE;
        const v = frame.values;
        const w = v[o + 3];
        try {
          this.hue.setColor(f.hueLightId, Math.min(1, v[o] + w), Math.min(1, v[o + 1] + w), Math.min(1, v[o + 2] + w), muted ? 0 : v[o + 6]);
        } catch (e) { this.hue.lastError = `Hue output failed: ${(e as Error).message}`; }
      }
    }
    this.lastMuted = muted;
  }

  /**
   * Lasers never go through the pattern engine. Their ten channels are built from the approved
   * preset tables and the software arm; disarmed, blacked out or off encodes as all zeros.
   */
  private writeLasers(universe: number, buf: Uint8Array) {
    const { lasers, haze, blackout } = this.getLasers();
    const blocked = new Set(this.plan!.blocked.map((b) => b.fixtureId));
    for (const f of this.rig.fixtures) {
      if (!f.enabled || (f.universe ?? 0) !== universe || !f.address || blocked.has(f.id)) continue;
      const p = findProfile(f.profileId, this.rig.customProfiles);
      let bytes: number[];
      if (isLaserProfile(p) && p?.id === "chauvet-scorpion-dual-rgb-ils-10ch" && [31, 41].includes(f.address)) bytes = laserBytes(lasers.fixtures[f.id], lasers.armed, blackout);
      else if (!HAZE_VETO && isHazeProfile(p) && p?.id === "chauvet-hurricane-haze-4d-2ch" && f.address === 51) bytes = hazeBytes(haze, blackout);
      else continue;
      for (let c = 0; c < bytes.length; c++) {
        const ch = f.address - 1 + c;
        if (ch >= 0 && ch < 512 && !this.plan!.protectedMask[ch]) buf[ch] = bytes[c];
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
      for (let i = 0; i < 3; i++) {
        try { this.sender.send(this.settings.artnet.universe, zeros); } catch { /* Still close all other transports. */ }
        await new Promise((r) => setTimeout(r, 30));
      }
    }
    try { this.sender?.close(); } finally { this.hue?.stop(); }
  }

  status(hasApiKey: boolean): OutputStatus {
    return {
      artnet: { sending: !!this.sender && !this.released, fps: this.fps, lastSentAt: this.sender?.lastSentAt ?? 0, frames: this.sender?.frames ?? 0, error: this.outputError ?? this.sender?.error },
      upstream: { listening: false, lastFrameAt: 0, from: "", frames: 0 },
      hue: { connected: this.hue?.connected ?? false, lights: this.hue?.lightCount ?? 0, lastError: this.hue?.lastError },
      engine: { fps: this.engineStatus.fps, patternError: this.engineStatus.patternError, restarts: this.engineStatus.restarts },
      hasApiKey,
      control: { preview: PREVIEW, commissioned: OUTPUT_COMMISSIONED && !PREVIEW, hazeCommissioned: !HAZE_VETO, hazeDisabledReason: HAZE_DISABLED_REASON, physicalState: "unverified", authority: "lightesota" },
    };
  }
}
