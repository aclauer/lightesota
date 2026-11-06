import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findProfile, type Fixture, type FixtureOverride, type FrameColor, type ParamValues, type Rig } from "@lightesota/shared";
import { OUT_STRIDE, type SandboxFixture } from "./sandbox.js";
import type { FromWorker, ToWorker } from "./worker.js";

export interface EngineFrame {
  /** Server time (ms) of the frame. */
  t: number;
  fixtures: Fixture[];
  /** Final per-fixture values after overrides/master/blackout: r g b w a uv dim strobe (0..1). */
  values: Float32Array;
  colors: FrameColor[];
}

export interface EngineStatus {
  fps: number;
  renderMs: number;
  patternError?: string;
  restarts: number;
}

interface EngineEvents {
  frame: [EngineFrame];
  status: [EngineStatus];
  log: [string];
  patternLoaded: [{ id: string; params: ParamValues }];
  patternError: [{ id: string; error: string }];
}

/**
 * Drives the render worker at a fixed rate, applies show-level processing
 * (crossfade, solo, overrides, master, blackout) and emits frames.
 */
export class Engine extends EventEmitter<EngineEvents> {
  private worker: Worker | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastTick = 0;
  private awaiting = false;
  private awaitingSince = 0;
  private fps = 40;
  private fixtures: Fixture[] = [];
  private sandboxFixtures: SandboxFixture[] = [];
  private lastRaw: Float32Array = new Float32Array(OUT_STRIDE);
  private restarts = 0;
  private frameCount = 0;
  private fpsWindowStart = 0;
  private measuredFps = 0;
  private renderMs = 0;
  private patternError: string | undefined;
  private seed = 1;

  // show-level inputs
  bpm = 120;
  beatOrigin = Date.now();
  speed = 1;
  master = 1;
  blackout = false;
  overrides: Record<string, FixtureOverride> = {};
  solo = new Set<string>();

  // crossfade
  private currentId: string | null = null;
  private fadeStart = 0;
  private fadeMs = 0;
  private fading = false;

  // pending load (so we can finish the handshake)
  private pendingLoad: { id: string; source: string; params?: ParamValues; crossfadeMs: number } | null = null;

  start(fps: number) {
    this.fps = Math.max(5, Math.min(60, fps));
    this.ensureWorker();
    if (this.timer) clearInterval(this.timer);
    this.lastTick = Date.now();
    this.fpsWindowStart = this.lastTick;
    this.timer = setInterval(() => this.tick(), 1000 / this.fps);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.worker?.terminate();
    this.worker = null;
  }

  setRig(rig: Rig) {
    this.fixtures = rig.fixtures.filter((f) => f.enabled);
    this.sandboxFixtures = toSandboxFixtures(this.fixtures, rig);
    this.post({ type: "fixtures", fixtures: this.sandboxFixtures });
  }

  get beat(): number { return this.beatAt(Date.now()); }
  beatAt(now: number) { return ((now - this.beatOrigin) / 60000) * this.bpm; }

  setBpm(bpm: number) {
    bpm = Math.max(20, Math.min(300, bpm));
    const now = Date.now();
    const beat = this.beatAt(now);
    this.bpm = bpm;
    this.beatOrigin = now - (beat * 60000) / bpm;
  }
  resync() { this.beatOrigin = Date.now(); }
  nudge(ms: number) { this.beatOrigin += ms; }

  /** Load a pattern into slot A, moving the current one to slot B for a crossfade. */
  loadPattern(id: string, source: string, params: ParamValues | undefined, crossfadeMs: number) {
    this.ensureWorker();
    this.pendingLoad = { id, source, params, crossfadeMs };
    this.post({ type: "load", slot: "a", id, source, params, seed: this.seed++ });
  }

  clearPattern(crossfadeMs: number) {
    this.ensureWorker();
    if (this.currentId !== null) {
      this.post({ type: "move", from: "a", to: "b" });
      this.beginFade(crossfadeMs);
    }
    this.currentId = null;
    this.pendingLoad = null;
    this.patternError = undefined;
  }

  setParams(params: ParamValues) { this.post({ type: "params", slot: "a", params }); }

  private beginFade(ms: number) {
    this.fadeStart = Date.now();
    this.fadeMs = Math.max(0, ms);
    this.fading = this.fadeMs > 0;
    if (!this.fading) this.post({ type: "unload", slot: "b" });
  }

  private ensureWorker() {
    if (this.worker) return;
    const now = Date.now();
    if (now - this.lastWorkerStart < 2000) return; // backoff: a crashing worker is retried at most every 2 s
    this.lastWorkerStart = now;
    const isTs = import.meta.url.endsWith(".ts");
    const file = fileURLToPath(new URL(isTs ? "./worker.ts" : "./worker.js", import.meta.url));
    // In dev (tsx) the worker registers tsx's hooks itself so .ts imports resolve inside the thread.
    const w = isTs
      ? new Worker(`import { register } from "tsx/esm/api"; register(); await import(${JSON.stringify(pathToFileURL(file).href)});`, { eval: true })
      : new Worker(file);
    w.on("message", (m: FromWorker) => this.onWorkerMessage(m));
    w.on("error", (e) => { this.emit("log", `worker error: ${e.message}`); this.restartWorker(); });
    w.on("exit", (code) => { if (this.worker === w) { this.emit("log", `worker exited (${code})`); this.worker = null; } });
    this.worker = w;
    w.postMessage({ type: "fixtures", fixtures: this.sandboxFixtures } satisfies ToWorker);
  }

  private restartWorker() {
    this.restarts++;
    const old = this.worker;
    this.worker = null;
    old?.terminate().catch(() => {});
    this.awaiting = false;
    this.ensureWorker();
    // Reload the current pattern, if any, without a crossfade.
    const p = this.lastLoaded;
    if (p) this.post({ type: "load", slot: "a", id: p.id, source: p.source, params: p.params, seed: this.seed++ });
    this.emitStatus();
  }
  private lastLoaded: { id: string; source: string; params?: ParamValues } | null = null;
  private lastWorkerStart = 0;

  private post(msg: ToWorker) { this.worker?.postMessage(msg); }

  private onWorkerMessage(m: FromWorker) {
    switch (m.type) {
      case "loaded": {
        if (m.slot !== "a") return;
        const pending = this.pendingLoad;
        if (!pending || pending.id !== m.id) {
          // A restart reload or stale load: no fade.
          this.currentId = m.id;
          this.emit("patternLoaded", { id: m.id, params: m.params });
          return;
        }
        // The worker has already replaced slot A with the new instance; the previous
        // instance was moved to B just before the load (see loadPattern path below).
        this.currentId = m.id;
        this.lastLoaded = { id: m.id, source: pending.source, params: m.params };
        this.pendingLoad = null;
        this.patternError = undefined;
        this.emit("patternLoaded", { id: m.id, params: m.params });
        this.emitStatus();
        break;
      }
      case "loadError":
        this.pendingLoad = null;
        this.patternError = m.error;
        this.emit("patternError", { id: m.id, error: m.error });
        this.emitStatus();
        break;
      case "frame": {
        this.awaiting = false;
        this.renderMs = this.renderMs * 0.9 + m.renderMs * 0.1;
        for (const l of m.logs) this.emit("log", l);
        const err = m.errorA ?? undefined;
        if (err !== this.patternError) { this.patternError = err; this.emitStatus(); }
        this.lastRaw = m.buf;
        this.publishFrame(m.buf);
        break;
      }
    }
  }

  /** Hook used by loadPattern: move current to B *before* the new load so the fade starts cleanly. */
  private prepareFadeForLoad(crossfadeMs: number) {
    if (this.currentId !== null || this.fading) {
      this.post({ type: "move", from: "a", to: "b" });
      this.beginFade(crossfadeMs);
    }
  }

  private tick() {
    const now = Date.now();
    if (!this.worker) this.ensureWorker();
    // Watchdog: a pattern that hangs the worker gets killed.
    if (this.awaiting) {
      if (now - this.awaitingSince > 750) {
        this.emit("log", "render timed out; restarting worker");
        this.patternError = "render() took too long (infinite loop?) - pattern reloaded";
        this.restartWorker();
      } else {
        // Keep output alive with the last frame while we wait.
        this.publishFrame(this.lastRaw);
      }
      return;
    }
    const dt = Math.min(0.25, (now - this.lastTick) / 1000) * this.speed;
    this.lastTick = now;
    let mix = 1;
    if (this.fading) {
      const p = Math.min(1, (now - this.fadeStart) / this.fadeMs);
      mix = p * p * (3 - 2 * p);
      if (p >= 1) { this.fading = false; this.post({ type: "unload", slot: "b" }); }
    }
    this.awaiting = true;
    this.awaitingSince = now;
    this.post({ type: "render", dt, bpm: this.bpm, beat: this.beatAt(now), mix });
    this.frameCount++;
    if (now - this.fpsWindowStart >= 1000) {
      this.measuredFps = (this.frameCount * 1000) / (now - this.fpsWindowStart);
      this.frameCount = 0;
      this.fpsWindowStart = now;
      this.emitStatus();
    }
  }

  get fadeProgress(): number | null {
    if (!this.fading) return null;
    return Math.min(1, (Date.now() - this.fadeStart) / this.fadeMs);
  }

  private emitStatus() {
    this.emit("status", { fps: Math.round(this.measuredFps), renderMs: this.renderMs, patternError: this.patternError, restarts: this.restarts });
  }

  private publishFrame(raw: Float32Array) {
    const n = this.fixtures.length;
    const values = new Float32Array(Math.max(1, n) * OUT_STRIDE);
    const colors: FrameColor[] = new Array(n);
    const soloing = this.solo.size > 0;
    for (let i = 0; i < n; i++) {
      const f = this.fixtures[i];
      const o = i * OUT_STRIDE;
      let r = raw[o] ?? 0, g = raw[o + 1] ?? 0, b = raw[o + 2] ?? 0, w = raw[o + 3] ?? 0, a = raw[o + 4] ?? 0, uv = raw[o + 5] ?? 0;
      let dim = raw[o + 6] ?? 0, strobe = raw[o + 7] ?? 0;
      const ov = this.overrides[f.id];
      if (ov) {
        const k = ov.mix ?? 1;
        if (ov.r !== undefined) r = r + (ov.r - r) * k;
        if (ov.g !== undefined) g = g + (ov.g - g) * k;
        if (ov.b !== undefined) b = b + (ov.b - b) * k;
        if (ov.w !== undefined) w = w + (ov.w - w) * k;
        if (ov.a !== undefined) a = a + (ov.a - a) * k;
        if (ov.uv !== undefined) uv = uv + (ov.uv - uv) * k;
        if (ov.dim !== undefined) dim = dim + (ov.dim - dim) * k;
        if (ov.r !== undefined || ov.g !== undefined || ov.b !== undefined) strobe = 0;
      }
      if (soloing && !this.solo.has(f.id)) dim = 0;
      dim *= this.master * (f.trim ?? 1);
      if (this.blackout) dim = 0;
      values[o] = r; values[o + 1] = g; values[o + 2] = b; values[o + 3] = w; values[o + 4] = a; values[o + 5] = uv;
      values[o + 6] = dim; values[o + 7] = strobe;
      colors[i] = { r: round3(r), g: round3(g), b: round3(b), w: round3(w), dim: round3(dim) };
    }
    this.emit("frame", { t: Date.now(), fixtures: this.fixtures, values, colors });
  }

  // Public wrapper that handles fade bookkeeping around a load.
  switchPattern(id: string, source: string, params: ParamValues | undefined, crossfadeMs: number) {
    this.ensureWorker();
    this.prepareFadeForLoad(crossfadeMs);
    this.loadPattern(id, source, params, crossfadeMs);
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

export function toSandboxFixtures(fixtures: Fixture[], rig: Rig): SandboxFixture[] {
  const xs = fixtures.map((f) => f.x), ys = fixtures.map((f) => f.y);
  const minX = Math.min(0, ...xs), maxX = Math.max(rig.room.width, ...xs);
  const minY = Math.min(0, ...ys), maxY = Math.max(rig.room.height, ...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const maxR = Math.hypot(maxX - cx, maxY - cy) || 1;
  return fixtures.map((f, index) => {
    const profile = findProfile(f.profileId, rig.customProfiles);
    const kind: SandboxFixture["kind"] = !profile ? "other" : profile.transport === "hue" ? "hue" : profile.colorModel === "dimmer" ? "spot" : "wash";
    return {
      id: f.id, name: f.name, index, x: f.x, y: f.y,
      nx: maxX === minX ? 0.5 : (f.x - minX) / (maxX - minX),
      ny: maxY === minY ? 0.5 : (f.y - minY) / (maxY - minY),
      dist: Math.min(1, Math.hypot(f.x - cx, f.y - cy) / maxR),
      angle: Math.atan2(f.y - cy, f.x - cx),
      rotation: f.rotation, kind, tags: [...f.tags, kind], isColor: kind !== "spot",
    };
  });
}
