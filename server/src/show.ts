import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import {
  defaultWashState, washFixtures, washSide, validateWashPatch, QUICK_LOOKS, COORDINATED_SHOWS, engineFixtures, isLaserFixture,
  type WashPatch, type WashState, type QuickLookId, type CoordinatedShowParams,
  defaultParams, sanitizeParams, defaultLasersState, defaultLaserState, sanitizeLaserState, laserFixtures, findLaserLook, LASER_LOOK_PATTERN,
  defaultHazeState, sanitizeHaze, validateHazePatch, hazeFixtures, hazeRunning, type HazePatch,
  type AudioFrame, type LaserState, type FixtureOverride, type ParamValues, type Rig, type Scene, type Settings, type ShowState, type Playlist,
} from "../../shared/src/index.js";
import { Engine } from "./engine/engine.js";
import type { Library } from "./library.js";
import { requireHazeOutput } from "./output/policy.js";
import { planUniverse } from "./output/dmx.js";
import { JsonFile } from "./store.js";

interface ShowEvents { show: [ShowState]; toast: [{ level: "info" | "success" | "warning" | "error"; text: string }]; }

/** Owns the ShowState, applies commands to the engine, runs playlists, persists the last show. */
export class ShowController extends EventEmitter<ShowEvents> {
  readonly engine = new Engine();
  state: ShowState;
  private file: JsonFile<Partial<ShowState>>;
  private taps: number[] = [];
  private playlistTimer: NodeJS.Timeout | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private audioTimer: NodeJS.Timeout;
  private lookTimer: NodeJS.Timeout;
  private hazeTimer: NodeJS.Timeout;
  private flashes = new Map<NodeJS.Timeout, string>();
  private runClock: { started: number; lastBeat: number; beats: number; lastLaserAt: number; laserPhrase: number } | null = null;

  constructor(private library: Library, private getRig: () => Rig, private getSettings: () => Settings) {
    super();
    this.file = new JsonFile<Partial<ShowState>>("show.json", () => ({}));
    const persisted = this.file.get();
    const saved = persisted && typeof persisted === "object" && !Array.isArray(persisted) ? persisted : {};
    const base: ShowState = {
      generation: Math.max(Date.now() * 1000, Number.isSafeInteger(saved.generation) ? saved.generation! + 1 : 0), controlledAt: Date.now(),
      stopped: true, washes: {}, coordinatedShow: null, history: [],
      patternId: null, params: {}, outgoingPatternId: null, crossfadeMs: 800, master: 1, blackout: false, speed: 1,
      transport: { bpm: 120, beatOrigin: Date.now(), running: true },
      overrides: {}, solo: [], activeSceneId: null, playlist: null, released: false,
      sleepAt: null, audio: { active: false, source: null, followBpm: false, level: 0, bpm: null },
      lasers: defaultLasersState(),
      haze: defaultHazeState(),
    };
    this.state = {
      ...base,
      ...saved,
      // Persisted libraries/history remain intact; all runtime emission is explicitly reset.
      generation: base.generation, controlledAt: base.controlledAt,
      master: finiteRange(saved.master, 0, 1, 1), speed: finiteRange(saved.speed, 0, 4, 1),
      crossfadeMs: finiteRange(saved.crossfadeMs, 0, 20000, 800),
      patternId: null, params: {}, overrides: {}, solo: [], released: false, activeSceneId: null,
      stopped: true, washes: {}, coordinatedShow: null,
      transport: { bpm: finiteRange(saved.transport?.bpm, 20, 300, 120), beatOrigin: Date.now(), running: true },
      playlist: null,
      blackout: false,
      outgoingPatternId: null,
      sleepAt: null,
      audio: { active: false, source: null, followBpm: saved.audio?.followBpm === true, level: 0, bpm: null },
      history: Array.isArray(saved.history) ? saved.history.filter((h) => h && typeof h.patternId === "string").slice(0, 12) : [],
      // Lasers and haze always come up disarmed and off, whatever was saved.
      lasers: defaultLasersState(),
      haze: defaultHazeState(),
    };
    this.hazeTimer = setInterval(() => this.hazeTick(), 1000); this.hazeTimer.unref();
    this.engine.washes = this.state.washes;
    for (const f of washFixtures(this.getRig())) this.state.washes[f.id] = defaultWashState();
    this.audioTimer = setInterval(() => this.audioTick(), 500); this.audioTimer.unref();
    this.lookTimer = setInterval(() => this.laserLookTick(), 100); this.lookTimer.unref();
    this.engine.on("beforeFrame", () => this.tickCoordinatedShow());
    this.engine.on("recovery", () => this.stopLighting());
    this.engine.on("patternLoaded", (loaded) => {
      if (loaded.id !== this.state.patternId || loaded.revision !== this.engine.patternRevision || loaded.generation !== this.engine.patternGeneration) return;
      this.state.params = loaded.params; this.state.outgoingPatternId = null;
      if (this.patternSource === this.library.getPattern(loaded.id)?.source) this.loadedLaserPattern = loaded;
      // Loading a source never authorizes it to take over armed lasers.
      this.changed();
    });
    this.engine.on("lasers", ({ states, id, revision, generation }) => {
      if (!this.hasPatternLaserOwnership() || id !== this.patternLaserOwner?.id || revision !== this.patternLaserOwner.revision || generation !== this.patternLaserOwner.generation) return;
      if (this.state.lasers.look !== LASER_LOOK_PATTERN) {
        // Named looks have no frame callback; an explicit empty reply signals a failed/empty source.
        if (states.length === 0) { this.invalidatePatternLasers(); this.changed(); }
        return;
      }
      laserFixtures(this.getRig()).forEach((f, i) => { this.state.lasers.fixtures[f.id] = states[i] ?? defaultLaserState(); });
      this.changed();
    });
    this.library.on("patterns", this.onLibraryPatterns);
    this.engine.on("patternError", ({ error }) => this.emit("toast", { level: "error", text: `Pattern failed to load: ${error}` }));
  }

  private onLibraryPatterns = () => {
    if (this.state.patternId && this.patternSource !== this.library.getPattern(this.state.patternId)?.source) {
      this.ownershipBarrier(); this.invalidatePatternLasers(); this.loadedLaserPattern = null; this.changed();
    }
  };

  start() {
    const s = this.getSettings();
    this.engine.setRig(this.getRig());
    this.engine.bpm = this.state.transport.bpm;
    this.engine.beatOrigin = this.state.transport.beatOrigin;
    this.engine.master = this.state.master;
    this.engine.speed = this.state.speed;
    this.engine.overrides = this.state.overrides;
    this.engine.solo = new Set(this.state.solo);
    this.engine.start(s.artnet.fps);
    if (this.state.patternId) {
      const p = this.library.getPattern(this.state.patternId);
      if (p && !p.error) this.engine.switchPattern(p.id, p.source, this.state.params, 0);
      else this.state.patternId = null;
    }
    this.changed();
  }

  stop() {
    this.stopLighting(); this.engine.stop();
    this.library.off("patterns", this.onLibraryPatterns);
    clearInterval(this.audioTimer); clearInterval(this.lookTimer); clearInterval(this.hazeTimer);
    if (this.emitTimer) clearTimeout(this.emitTimer); this.emitTimer = null;
    this.file.set(this.state); this.file.flush();
  }

  /** A single barrier covers browser/API queues, async agent apply and delayed restoration. */
  private ownershipBarrier() {
    this.state.generation++;
    this.state.controlledAt = Date.now();
    this.stopPlaylist(false);
    for (const [timer, id] of this.flashes) {
      clearTimeout(timer);
      // Interrupted identification flashes end dark; they never restore an older emitting intent.
      const wash = this.state.washes[id];
      if (wash) this.state.washes[id] = { ...wash, mode: "off", owner: "manual" };
      else this.state.overrides[id] = { r: 0, g: 0, b: 0, w: 0, a: 0, uv: 0, dim: 0, mix: 1 };
    }
    this.flashes.clear();
  }
  assertGeneration(generation: number) {
    if (generation !== this.state.generation) throw new Error("Stale control generation; refresh state and explicitly retry");
  }

  /** Strong Stop, distinct from the reversible wash blackout. It never restores a prior look. */
  stopLighting() {
    this.ownershipBarrier();
    this.stopPlaylist(false);
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null; this.state.sleepAt = null;
    this.invalidatePatternLasers(); this.loadedLaserPattern = null; this.patternSource = null;
    this.runClock = null; this.state.coordinatedShow = null;
    this.state.lasers = defaultLasersState();
    this.clearHaze();
    for (const f of washFixtures(this.getRig())) this.state.washes[f.id] = { ...(this.state.washes[f.id] ?? defaultWashState()), mode: "off", owner: "manual" };
    this.state.patternId = null; this.state.outgoingPatternId = null; this.state.params = {};
    this.state.overrides = {}; this.engine.overrides = {};
    this.state.solo = []; this.engine.solo.clear();
    this.state.released = false; this.state.activeSceneId = null; this.state.stopped = true;
    this.engine.washes = this.state.washes;
    // State/callbacks are already dark even if an output subscriber throws while publishing.
    try { this.engine.halt(); } finally { this.changed(); }
  }

  private selectedWashes(ids: string[]) {
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 128 || new Set(ids).size !== ids.length) throw new Error("Choose unique wash fixture IDs");
    const fixtures = washFixtures(this.getRig());
    return ids.map((id) => {
      const f = fixtures.find((item) => item.id === id);
      if (!f) throw new Error(`Not an enabled 12CH wash: ${id}`);
      return f;
    });
  }
  /** Hold current selected output and stop writers that can replace that scope. */
  takeManualControl(ids?: string[]) {
    const fixtures = engineFixtures(this.getRig());
    const selected = ids ?? fixtures.map((f) => f.id);
    if (!Array.isArray(selected) || selected.some((id) => !fixtures.some((f) => f.id === id))) throw new Error("Invalid manual fixture selection");
    this.ownershipBarrier(); this.invalidatePatternLasers(); this.stopPlaylist(false);
    this.detachShowWashes(selected);
    const frame = this.engine.lastFrame;
    for (const id of selected) {
      const f = fixtures.find((item) => item.id === id)!;
      const i = frame?.fixtures.findIndex((item) => item.id === id) ?? -1;
      const offset = i * 8;
      const existing = this.state.washes[id];
      if (existing && existing.owner !== "pattern") { existing.owner = "manual"; continue; }
      const values = frame?.values;
      const rgbw = i >= 0 && values ? [values[offset], values[offset + 1], values[offset + 2], values[offset + 3]] : [0, 0, 0, 0];
      const scale = this.state.master * (f.trim ?? 1);
      const dim = i >= 0 && values && scale > 0 ? clamp01(values[offset + 6] / scale) : 0;
      if (existing) {
        this.state.washes[id] = { ...existing, owner: "manual", mode: dim > 0 ? "normal" : "off", brightness: Math.round(dim * 255), rgbw: rgbw.map((v) => Math.round(v * 255)) as WashState["rgbw"] };
      } else {
        this.state.overrides[id] = { r: rgbw[0], g: rgbw[1], b: rgbw[2], w: rgbw[3], a: 0, uv: 0, dim, mix: 1 };
      }
    }
    if (!ids) {
      this.state.patternId = null; this.state.outgoingPatternId = null; this.state.params = {};
      this.lasersOff("manual takeover");
      this.engine.halt();
    }
    this.engine.overrides = this.state.overrides; this.engine.washes = this.state.washes;
    this.engine.refresh(); this.changed();
  }
  setWash(ids: string[], raw: WashPatch) {
    this.selectedWashes(ids);
    const patch = validateWashPatch(raw);
    this.takeManualControl(ids);
    for (const id of ids) {
      const prev = this.state.washes[id] ?? defaultWashState();
      this.state.washes[id] = { ...prev, ...patch, owner: "manual" };
      delete this.state.overrides[id];
      if (this.state.washes[id].mode !== "off") this.state.stopped = false;
    }
    this.engine.washes = this.state.washes; this.engine.refresh(); this.changed();
  }
  releaseWashes(ids: string[]) {
    this.selectedWashes(ids);
    this.ownershipBarrier(); this.detachShowWashes(ids);
    for (const id of ids) {
      this.state.washes[id] = { ...(this.state.washes[id] ?? defaultWashState()), owner: "pattern", mode: "normal" };
      delete this.state.overrides[id];
    }
    this.state.stopped = false;
    this.engine.washes = this.state.washes; this.engine.refresh(); this.changed();
  }
  quickLook(id: QuickLookId, ids = washFixtures(this.getRig()).map((f) => f.id)) {
    if (!QUICK_LOOKS.some((look) => look.id === id)) throw new Error("Unknown quick look");
    if (id === "laser-duo") {
      this.requireLaserStart();
      if (!this.state.lasers.armed) throw new Error("Arm lasers, then explicitly Start the duo");
      this.ownershipBarrier(); this.invalidatePatternLasers(); this.cancelShowLasers();
      this.state.lasers.look = null;
      laserFixtures(this.getRig()).forEach((f, i) => {
        this.state.lasers.fixtures[f.id] = { ...defaultLaserState(), mode: "manual", color: i % 2 ? "magenta" : "cyan", pattern: i % 2 ? "wave" : "fan", pan: 64 };
      });
      this.state.stopped = false; this.changed(); return;
    }
    const fixtures = this.selectedWashes(ids);
    this.takeManualControl(ids);
    for (const f of fixtures) {
      const prev = this.state.washes[f.id] ?? defaultWashState();
      const rgbw: WashState["rgbw"] = id === "warm-arrival" ? [255, 120, 32, 64] : id === "cyan-magenta" ? (washSide(f) === "a" ? [0, 255, 255, 0] : [255, 0, 255, 0]) : [0, 0, 255, 0];
      this.state.washes[f.id] = { ...prev, rgbw, mode: id === "music6" || id === "music32" ? id : "normal", brightness: id === "warm-arrival" ? 32 : id === "calm-blue" ? 25 : 38, owner: "manual" };
      delete this.state.overrides[f.id];
    }
    this.state.stopped = false; this.engine.refresh(); this.changed();
  }

  startCoordinatedShow(params: CoordinatedShowParams) {
    if (!params || !COORDINATED_SHOWS.some((item) => item.id === params.id)) throw new Error("Unknown coordinated show");
    this.selectedWashes(params.fixtureIds);
    const durationSec = params.durationSec ?? 180, ceiling = params.ceiling ?? 25;
    if (!Number.isFinite(durationSec) || durationSec < 10 || durationSec > 900) throw new Error("Duration must be 10..900 seconds");
    if (!Number.isInteger(ceiling) || ceiling < 1 || ceiling > 102) throw new Error("Wash ceiling must be 1..102 / 255");
    if (params.includeLasers !== undefined && typeof params.includeLasers !== "boolean") throw new Error("includeLasers must be boolean");
    if (params.includeLasers) this.requireLaserStart();
    if (params.includeLasers && !this.state.lasers.armed) throw new Error("Arm lasers before explicitly including them in a show");
    const armed = { armed: this.state.lasers.armed, armedAt: this.state.lasers.armedAt, armedBy: this.state.lasers.armedBy };
    this.ownershipBarrier(); this.stopPlaylist(false); this.cancelCoordinatedShow(true);
    if (params.includeLasers) { this.invalidatePatternLasers(); Object.assign(this.state.lasers, armed); }
    this.state.coordinatedShow = { id: params.id, fixtureIds: [...params.fixtureIds], durationSec, ceiling, includeLasers: params.includeLasers ?? false, startedAt: Date.now(), elapsedSec: 0, source: "shared-bpm", phrase: 0 };
    const now = performance.now();
    this.runClock = { started: now, lastBeat: this.engine.beat, beats: 0, lastLaserAt: -Infinity, laserPhrase: -1 };
    if (params.includeLasers) this.state.lasers.look = null;
    this.state.stopped = false;
    this.tickCoordinatedShow(now); this.engine.refresh(); this.changed();
  }
  /** Evaluated on the existing engine clock. No cue queue and no catch-up bursts. */
  tickCoordinatedShow(now = performance.now()) {
    const run = this.state.coordinatedShow, clock = this.runClock;
    if (!run || !clock) return;
    const elapsed = Math.max(0, (now - clock.started) / 1000);
    if (elapsed >= run.durationSec) {
      this.ownershipBarrier(); this.cancelCoordinatedShow(true); this.changed(); return;
    }
    const beat = this.engine.beat;
    // A resync may move beat backwards; preserve phrase progress and start from the new grid.
    clock.beats += Math.max(0, beat - clock.lastBeat); clock.lastBeat = beat;
    const phrase = Math.floor(clock.beats / 16), progress = (clock.beats % 16) / 16;
    const statusChanged = phrase !== run.phrase || Math.floor(elapsed) !== Math.floor(run.elapsedSec);
    run.phrase = phrase; run.elapsedSec = elapsed;
    const swap = phrase % 2;
    for (const f of this.selectedWashes(run.fixtureIds)) {
      const side = washSide(f) === "a" ? 0 : 1;
      const lead = (side + swap) % 2 === 0;
      const factor = run.id === "call-response" ? (lead ? 1 : 0.4) : run.id === "build-release" ? 0.35 + 0.65 * progress : 1;
      const cyan = run.id === "call-response" ? side === 0 : lead;
      this.state.washes[f.id] = { ...(this.state.washes[f.id] ?? defaultWashState()), owner: "show", mode: "normal", brightness: Math.round(run.ceiling * factor), rgbw: cyan ? [0, 255, 255, 0] : [255, 0, 255, 0] };
    }
    if (run.includeLasers && this.state.lasers.armed && clock.laserPhrase !== phrase) {
      clock.laserPhrase = phrase;
      const phraseAgeMs = (clock.beats % 16) * 60000 / this.engine.bpm;
      // Late phrases are consumed without a cue; never catch up partway through a phrase.
      if (phraseAgeMs <= 100 && now - clock.lastLaserAt >= 4000) {
        laserFixtures(this.getRig()).forEach((f, i) => {
          const lead = (i + swap) % 2 === 0;
          this.state.lasers.fixtures[f.id] = { ...defaultLaserState(), mode: "manual", pattern: lead ? "fan" : "wave", color: lead ? "cyan" : "magenta", pan: 64 };
        });
        clock.lastLaserAt = now;
      }
    }
    if (statusChanged) this.changed();
  }
  private cancelShowLasers() {
    const run = this.state.coordinatedShow;
    if (!run?.includeLasers) return;
    run.includeLasers = false;
    for (const id of Object.keys(this.state.lasers.fixtures)) this.state.lasers.fixtures[id] = { ...this.state.lasers.fixtures[id], mode: "off" };
  }
  private detachShowWashes(ids: string[]) {
    const run = this.state.coordinatedShow;
    if (!run || !run.fixtureIds.some((id) => ids.includes(id))) return;
    this.cancelShowLasers();
    run.fixtureIds = run.fixtureIds.filter((id) => !ids.includes(id));
    if (!run.fixtureIds.length) { this.state.coordinatedShow = null; this.runClock = null; }
  }
  private cancelCoordinatedShow(clear: boolean) {
    const run = this.state.coordinatedShow;
    if (!run) return;
    for (const id of run.fixtureIds) {
      const wash = this.state.washes[id];
      if (wash?.owner === "show") this.state.washes[id] = { ...wash, owner: "manual", ...(clear ? { mode: "off" as const } : {}) };
    }
    if (run.includeLasers) {
      this.cancelShowLasers();
      this.state.lasers = defaultLasersState();
      this.clearHaze();
    }
    this.state.coordinatedShow = null; this.runClock = null;
    this.engine.refresh();
  }
  /** A flash may restore only inside the same ownership generation that started it. */
  testFixture(id: string, seconds = 2) {
    const f = engineFixtures(this.getRig()).find((item) => item.id === id);
    if (!f || isLaserFixture(f, this.getRig())) throw new Error("Only ordinary fixtures can be flashed");
    const oldWash = this.state.washes[id] ? { ...this.state.washes[id], rgbw: [...this.state.washes[id].rgbw] as WashState["rgbw"] } : undefined;
    const oldOverride = this.state.overrides[id];
    const oldStopped = this.state.stopped;
    this.setOverride(id, { r: 1, g: 1, b: 1, w: 0, dim: 0.15 });
    const generation = this.state.generation;
    const timer = setTimeout(() => {
      this.flashes.delete(timer);
      if (generation !== this.state.generation) return;
      if (oldWash) this.state.washes[id] = { ...oldWash, owner: oldWash.owner === "show" && !this.state.coordinatedShow?.fixtureIds.includes(id) ? "manual" : oldWash.owner };
      if (oldOverride) this.state.overrides[id] = oldOverride; else delete this.state.overrides[id];
      this.state.stopped = oldStopped;
      this.engine.refresh(); this.changed();
    }, Math.max(0.05, Math.min(10, Number.isFinite(seconds) ? seconds : 2)) * 1000);
    timer.unref(); this.flashes.set(timer, id);
  }

  // ---- audio ----
  private audioSourceId: string | null = null;
  private lastBpmFollow = 0;
  setAudio(clientId: string, clientName: string, frame: AudioFrame | null) {
    if (frame === null) {
      if (this.audioSourceId === clientId) { this.audioSourceId = null; this.engine.setAudio(null); this.state.audio = { ...this.state.audio, active: false, source: null, level: 0, bpm: null }; this.changed(); }
      return;
    }
    // First come, first served: one microphone drives the show until it stops.
    if (this.audioSourceId && this.audioSourceId !== clientId && this.engine.audioActive) return;
    this.audioSourceId = clientId;
    if (frame.level <= 0.005) frame = { ...frame, bpm: null, onset: false };
    this.engine.setAudio(frame);
    const a = this.state.audio;
    const changed = !a.active || a.source !== clientName || Math.abs(a.level - frame.level) > 0.08 || a.bpm !== frame.bpm;
    this.state.audio = { ...a, active: frame.level > 0.005, source: frame.level > 0.005 ? clientName : null, level: frame.level, bpm: frame.bpm };
    if (a.followBpm && frame.bpm && frame.onset && Date.now() - this.lastBpmFollow > 2000 && Math.abs(frame.bpm - this.engine.bpm) >= 1) {
      this.lastBpmFollow = Date.now();
      this.engine.setBpm(frame.bpm);
      this.engine.beatOrigin = Date.now();
    }
    if (changed) this.changed();
  }
  setFollowMicBpm(on: boolean) { this.state.audio = { ...this.state.audio, followBpm: on }; this.changed(); }
  private audioTick() {
    if (this.state.audio.active && !this.engine.audioActive) {
      this.audioSourceId = null;
      this.state.audio = { ...this.state.audio, active: false, source: null, level: 0, bpm: null };
      this.changed();
    }
  }

  // ---- sleep timer ----
  private sleepTimer: NodeJS.Timeout | null = null;
  setSleep(minutes: number | null) {
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    this.sleepTimer = null;
    if (minutes === null || !(minutes > 0)) { this.state.sleepAt = null; this.changed(); return; }
    const ms = Math.min(24 * 3600, minutes * 60) * 1000;
    this.state.sleepAt = Date.now() + ms;
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null;
      this.state.sleepAt = null;
      this.stopLighting();
      this.emit("toast", { level: "info", text: "Sleep timer: lights off" });
    }, ms);
    this.changed();
  }

  rigChanged() {
    this.stopLighting();
    this.state.washes = Object.fromEntries(washFixtures(this.getRig()).map((f) => [f.id, defaultWashState()]));
    this.engine.washes = this.state.washes;
    this.engine.setRig(this.getRig());
  }
  settingsChanged() { this.engine.start(this.getSettings().artnet.fps); }

  private changed() {
    const loaded = this.loadedLaserPattern?.revision === this.engine.patternRevision && this.loadedLaserPattern?.generation === this.engine.patternGeneration ? this.loadedLaserPattern : null;
    this.state.lasers.patternId = loaded?.id ?? null;
    this.state.lasers.patternRevision = loaded?.revision ?? null;
    this.state.lasers.patternFollowing = this.patternLaserOwner !== null;
    this.state.transport = { bpm: this.engine.bpm, beatOrigin: this.engine.beatOrigin, running: true };
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      this.emit("show", this.state);
      const { playlist: _p, ...persist } = this.state;
      this.file.set(persist);
    }, 15);
  }

  // ---- patterns ----
  setPattern(patternId: string | null, params?: ParamValues, crossfadeMs?: number, keepScene = false, by?: string) {
    // An explicit pattern Start reclaims the room only after a global Stop/boot.
    const requested = patternId === null ? null : this.library.getPattern(patternId);
    if (patternId !== null && !requested) throw new Error("Pattern not found");
    if (requested?.error) throw new Error(`Pattern has an error: ${requested.error}`);
    const wasStopped = this.state.stopped;
    this.ownershipBarrier(); this.invalidatePatternLasers(); this.loadedLaserPattern = null; this.patternSource = requested?.source ?? null;
    this.stopPlaylist(false);
    const showOwned = this.state.coordinatedShow?.fixtureIds ?? [];
    this.cancelCoordinatedShow(false);
    for (const id of showOwned) {
      const wash = this.state.washes[id];
      if (wash) this.state.washes[id] = { ...wash, owner: "pattern", mode: "normal" };
    }
    const fade = crossfadeMs ?? this.state.crossfadeMs;
    if (!keepScene) this.state.activeSceneId = null;
    if (patternId === null) {
      this.engine.clearPattern(fade);
      this.state.outgoingPatternId = this.state.patternId;
      this.state.patternId = null;
      this.state.params = {};
      this.changed();
      return;
    }
    const p = this.library.getPattern(patternId);
    if (!p) throw new Error("Pattern not found");
    if (p.error) throw new Error(`Pattern has an error: ${p.error}`);
    const clean = sanitizeParams(p.params, params ?? (patternId === this.state.patternId ? this.state.params : undefined));
    if (wasStopped) for (const f of washFixtures(this.getRig())) this.state.washes[f.id] = { ...defaultWashState(), owner: "pattern", mode: "normal" };
    this.state.stopped = false;
    this.state.outgoingPatternId = this.state.patternId;
    this.state.patternId = patternId;
    this.state.params = clean;
    this.engine.switchPattern(p.id, p.source, clean, fade);
    this.pushHistory(patternId, clean, keepScene ? this.state.activeSceneId : null, by);
    this.changed();
  }

  /** Recent list: newest first, one entry per pattern, capped. */
  private pushHistory(patternId: string, params: ParamValues, sceneId: string | null, by?: string) {
    const rest = this.state.history.filter((h) => h.patternId !== patternId);
    this.state.history = [{ patternId, params: { ...params }, sceneId, at: Date.now(), by }, ...rest].slice(0, 12);
  }

  forgetPattern(patternId: string) {
    this.state.history = this.state.history.filter((h) => h.patternId !== patternId);
    this.changed();
  }

  /** Called when a pattern's source changed: reload if it is live, keeping params. */
  patternUpdated(patternId: string) {
    if (this.state.patternId !== patternId) return;
    const p = this.library.getPattern(patternId);
    this.ownershipBarrier(); this.invalidatePatternLasers(); this.loadedLaserPattern = null;
    this.patternSource = p?.source ?? null;
    if (!p || p.error) { this.changed(); return; }
    const clean = sanitizeParams(p.params, this.state.params);
    this.state.params = clean;
    this.engine.switchPattern(p.id, p.source, clean, 150);
    this.changed();
  }

  setParams(params: ParamValues, merge = true) {
    if (!this.state.patternId) return;
    const p = this.library.getPattern(this.state.patternId);
    if (!p) return;
    const next = merge ? { ...this.state.params, ...params } : params;
    this.ownershipBarrier();
    this.invalidatePatternLasers();
    this.state.params = sanitizeParams(p.params, next);
    this.engine.setParams(this.state.params);
    this.changed();
  }

  resetParams() {
    if (!this.state.patternId) return;
    const p = this.library.getPattern(this.state.patternId);
    if (!p) return;
    this.setParams(defaultParams(p.params), false);
  }

  setMaster(v: number) { if (!Number.isFinite(v)) throw new Error("Master must be finite"); this.ownershipBarrier(); this.state.master = clamp01(v); this.engine.master = this.state.master; this.engine.refresh(); this.changed(); }
  setBlackout(b: boolean) {
    this.ownershipBarrier();
    // Both edges discard effects staged under a gate; only wash mute is reversible.
    if (b || this.state.blackout) this.lasersOff("temporary mute/release");
    this.state.blackout = b; this.engine.blackout = b; this.engine.refresh(); this.changed();
  }
  setSpeed(v: number) { if (!Number.isFinite(v)) throw new Error("Speed must be finite"); this.ownershipBarrier(); this.state.speed = Math.max(0, Math.min(4, v)); this.engine.speed = this.state.speed; this.changed(); }
  setCrossfade(ms: number) { this.state.crossfadeMs = Math.max(0, Math.min(20000, ms)); this.changed(); }
  setReleased(r: boolean) {
    this.stopLighting();
    this.state.released = r;
    this.engine.refresh(); this.changed();
  }

  // ---- haze (operator-only, timed runs; see shared/src/haze.ts) ----
  setHaze(raw: HazePatch, by: string) {
    const msg = validateHazePatch(raw), H = this.state.haze;
    if (msg.armed === false) { this.hazeOff(by); return; }
    const start = msg.runSec !== undefined && msg.runSec > 0;
    if (msg.armed === true || start || hazeRunning(H)) {
      requireHazeOutput();
      if (this.state.blackout || this.state.released) throw new Error("Clear temporary mute/release before a fresh haze arm/Start");
      const rig = this.getRig(), universe = this.getSettings().artnet.universe;
      const blocked = new Set(planUniverse(rig, universe).blocked.map(f => f.fixtureId));
      if (!hazeFixtures(rig).some(f => f.address === 51 && (f.universe ?? 0) === universe && !blocked.has(f.id))) throw new Error("No enabled, unprotected hazer in the output universe");
      if (start && !H.armed && msg.armed !== true) throw new Error("Arm the hazer first");
    }
    this.ownershipBarrier();
    Object.assign(H, sanitizeHaze(msg, H));
    if (msg.armed === true && !H.armed) {
      H.armed = true; H.armedBy = by || "admin";
      H.runUntil = null; // Arm alone never restores a run.
      this.emit("toast", { level: "warning", text: `Haze armed by ${H.armedBy}` });
    }
    if (msg.runSec !== undefined) H.runUntil = start ? Date.now() + msg.runSec * 1000 : null;
    if (start) this.state.stopped = false;
    this.engine.refresh(); this.changed();
  }
  private clearHaze() {
    const H = this.state.haze;
    H.runUntil = null; H.armed = false; H.armedBy = null;
  }
  hazeOff(by: string) {
    const was = hazeRunning(this.state.haze) || this.state.haze.armed;
    this.ownershipBarrier(); this.clearHaze();
    if (was) this.emit("toast", { level: "info", text: `Haze off (${by || "control"})` });
    this.engine.refresh(); this.changed();
  }
  private hazeTick() {
    const H = this.state.haze;
    if (H.runUntil !== null && H.runUntil <= Date.now()) {
      this.ownershipBarrier(); this.clearHaze();
      this.emit("toast", { level: "info", text: "Haze run finished" });
      this.engine.refresh(); this.changed();
    }
  }

  // ---- lasers (operator-approved presets only; see shared/src/laser.ts) ----
  armLasers(armed: boolean, by: string) {
    const L = this.state.lasers;
    if (armed && !L.armed) {
      if (laserFixtures(this.getRig()).length === 0) throw new Error("No enabled laser fixtures in the rig");
      this.ownershipBarrier(); this.invalidatePatternLasers();
      // Staging while disarmed never records an emitting intent. Arm itself remains dark.
      for (const id of Object.keys(L.fixtures)) L.fixtures[id] = { ...L.fixtures[id], mode: "off" };
      L.look = null;
      L.armed = true; L.armedAt = Date.now(); L.armedBy = by || "admin";
      this.emit("toast", { level: "warning", text: `Lasers armed by ${L.armedBy}` });
    } else if (!armed) {
      this.lasersOff(by);
    }
    this.changed();
  }
  private requireLaserStart() {
    if (this.state.blackout || this.state.released) throw new Error("Clear temporary mute/release, then make a fresh operator Start");
  }
  setLaser(fixtureId: string, patch: Partial<LaserState>) {
    if (!laserFixtures(this.getRig()).some((f) => f.id === fixtureId)) throw new Error("Not an enabled laser fixture");
    const prev = this.state.lasers.fixtures[fixtureId] ?? defaultLaserState();
    const next = sanitizeLaserState({ ...prev, ...patch }, prev);
    if (next.mode !== "off") this.requireLaserStart();
    this.ownershipBarrier(); this.invalidatePatternLasers();
    this.cancelShowLasers();
    this.state.lasers.fixtures[fixtureId] = next;
    if (!this.state.lasers.armed) this.state.lasers.fixtures[fixtureId].mode = "off";
    if (this.state.lasers.fixtures[fixtureId].mode !== "off") this.state.stopped = false;
    this.state.lasers.look = null; // a hand edit takes over from any look
    this.changed();
  }
  private patternSource: string | null = null;
  private loadedLaserPattern: { id: string; revision: number; generation: number; usesLasers: boolean; laserLook: string | null } | null = null;
  private patternLaserOwner: { id: string; revision: number; generation: number; source: string } | null = null;

  /** An operator explicitly delegates the laser layer to exactly the currently loaded source. */
  followPatternLasers(patternId: string, revision: number) {
    const loaded = this.loadedLaserPattern;
    if (!this.state.lasers.armed) throw new Error("Arm lasers before selecting Follow");
    if (this.state.blackout || this.state.released || this.state.stopped) throw new Error("Start lighting and clear temporary mute/release before selecting Follow");
    if (!loaded || !loaded.usesLasers || loaded.id !== patternId || this.state.patternId !== patternId || loaded.revision !== revision || revision !== this.engine.patternRevision || loaded.generation !== this.engine.patternGeneration || this.patternSource !== this.library.getPattern(patternId)?.source) throw new Error("Select the current loaded pattern revision with a lasers section");
    this.ownershipBarrier(); this.invalidatePatternLasers(); this.cancelShowLasers();
    this.patternLaserOwner = { id: patternId, revision, generation: loaded.generation, source: this.patternSource! };
    // Erase held manual output while waiting for the first newly authorized typed frame.
    for (const f of laserFixtures(this.getRig())) this.state.lasers.fixtures[f.id] = defaultLaserState();
    this.state.lasers.look = loaded.laserLook ?? LASER_LOOK_PATTERN;
    if (loaded.laserLook) this.applyLook(true);
    this.changed();
  }
  private hasPatternLaserOwnership() {
    const owner = this.patternLaserOwner;
    if (!owner) return false;
    const valid = this.state.lasers.armed && !this.state.blackout && !this.state.released && !this.state.stopped && owner.id === this.state.patternId && owner.revision === this.engine.patternRevision && owner.generation === this.engine.patternGeneration && owner.source === this.library.getPattern(owner.id)?.source;
    if (!valid) { this.invalidatePatternLasers(); this.changed(); }
    return valid;
  }
  private invalidatePatternLasers() {
    if (this.patternLaserOwner || this.state.lasers.look === LASER_LOOK_PATTERN) {
      for (const id of Object.keys(this.state.lasers.fixtures)) this.state.lasers.fixtures[id] = { ...this.state.lasers.fixtures[id], mode: "off" };
      this.state.lasers.look = null;
    }
    this.patternLaserOwner = null;
  }
  /** Apply a look: static ones are written once, animated ones are re-evaluated by laserLookTick. */
  setLaserLook(lookId: string | null) {
    if (lookId === LASER_LOOK_PATTERN) {
      this.followPatternLasers(this.state.patternId ?? "", this.engine.patternRevision); return;
    }
    if (lookId === null) { this.ownershipBarrier(); this.invalidatePatternLasers(); this.cancelShowLasers(); this.state.lasers.look = null; this.changed(); return; }
    const look = findLaserLook(lookId);
    this.requireLaserStart();
    if (!this.state.lasers.armed) throw new Error("Arm lasers, then explicitly Start a preset or look");
    if (!look) throw new Error(`Unknown laser look ${lookId}`);
    this.ownershipBarrier(); this.invalidatePatternLasers();
    this.cancelShowLasers();
    this.state.stopped = false;
    this.state.lasers.look = look.id;
    this.applyLook(true);
    this.changed();
  }
  private lookStart = Date.now();
  private applyLook(reset = false) {
    const look = findLaserLook(this.state.lasers.look);
    if (!look) return;
    if (reset) this.lookStart = Date.now();
    const lasers = laserFixtures(this.getRig());
    const t = (Date.now() - this.lookStart) / 1000;
    const beat = this.engine.beat;
    let changed = false;
    lasers.forEach((f, i) => {
      const next = sanitizeLaserState(look.at(t, beat, i, lasers.length));
      const prev = this.state.lasers.fixtures[f.id];
      if (!prev || prev.mode !== next.mode || prev.pattern !== next.pattern || prev.color !== next.color || prev.pan !== next.pan || prev.musicColor !== next.musicColor) {
        this.state.lasers.fixtures[f.id] = next; changed = true;
      }
    });
    return changed;
  }
  private laserLookTick() {
    if (this.patternLaserOwner && !this.hasPatternLaserOwnership()) return;
    const look = findLaserLook(this.state.lasers.look);
    if (!look || !look.animated || !this.state.lasers.armed || this.state.blackout || this.state.released || this.state.stopped) return;
    if (this.applyLook()) this.changed();
  }
  /** Every laser to its dark state and the arm dropped. */
  lasersOff(by: string) {
    this.clearHaze();
    this.ownershipBarrier(); this.invalidatePatternLasers();
    this.cancelShowLasers();
    const L = this.state.lasers;
    const wasArmed = L.armed;
    for (const id of Object.keys(L.fixtures)) L.fixtures[id] = { ...L.fixtures[id], mode: "off" };
    L.armed = false; L.armedAt = null; L.armedBy = null; L.look = null;
    if (wasArmed) this.emit("toast", { level: "info", text: `Lasers off (${by || "control"})` });
    this.changed();
  }

  // ---- transport ----
  setBpm(bpm: number) { this.engine.setBpm(bpm); this.changed(); }
  tap() {
    const now = Date.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2500) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length >= 2) {
      const intervals = this.taps.slice(1).map((t, i) => t - this.taps[i]);
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      this.engine.bpm = Math.max(20, Math.min(300, 60000 / avg));
    }
    // Align the beat grid to the tap.
    this.engine.beatOrigin = now;
    this.changed();
  }
  resync() { this.engine.resync(); this.changed(); }
  nudge(ms: number) { this.engine.nudge(ms); this.changed(); }

  // ---- overrides / solo ----
  setOverride(fixtureId: string, ov: FixtureOverride | null) {
    if (!engineFixtures(this.getRig()).some((f) => f.id === fixtureId)) throw new Error("Not an enabled ordinary fixture");
    if (ov && (Object.values(ov).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1))) throw new Error("Override values must be finite 0..1");
    if (washFixtures(this.getRig()).some((f) => f.id === fixtureId)) {
      if (!ov) { this.releaseWashes([fixtureId]); return; }
      const prev = this.state.washes[fixtureId] ?? defaultWashState();
      const patch: WashPatch = {};
      if ([ov.r, ov.g, ov.b, ov.w].some((v) => v !== undefined)) patch.rgbw = [ov.r, ov.g, ov.b, ov.w].map((v, i) => v === undefined ? prev.rgbw[i] : Math.round(v * 255)) as WashState["rgbw"];
      if (ov.dim !== undefined) patch.brightness = Math.round(ov.dim * 255);
      this.setWash([fixtureId], patch);
      return;
    }
    this.takeManualControl([fixtureId]);
    if (ov) { this.state.overrides[fixtureId] = ov; this.state.stopped = false; } else delete this.state.overrides[fixtureId];
    this.engine.overrides = this.state.overrides;
    this.engine.refresh(); this.changed();
  }

  clearOverrides() { this.ownershipBarrier(); this.state.overrides = {}; this.engine.overrides = {}; this.changed(); }
  setSolo(ids: string[]) { this.ownershipBarrier(); this.state.solo = ids; this.engine.solo = new Set(ids); this.changed(); }

  // ---- scenes ----
  captureScene(name: string, sceneId?: string): Scene {
    const existing = sceneId ? this.library.scenes.find((s) => s.id === sceneId) : undefined;
    const p = this.state.patternId ? this.library.getPattern(this.state.patternId) : undefined;
    const now = Date.now();
    const scene: Scene = {
      id: existing?.id ?? nanoid(8),
      name: name.trim() || existing?.name || p?.name || "Scene",
      patternId: this.state.patternId,
      params: { ...this.state.params },
      master: this.state.master,
      bpm: p?.usesBeat ? this.engine.bpm : null,
      speed: this.state.speed,
      overrides: JSON.parse(JSON.stringify(this.state.overrides)),
      washes: JSON.parse(JSON.stringify(this.state.washes)),
      favorite: existing?.favorite ?? false,
      hotkey: existing?.hotkey ?? null,
      swatch: p?.swatch ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.library.upsertScene(scene);
    this.state.activeSceneId = scene.id;
    this.changed();
    return scene;
  }

  recallScene(sceneId: string, crossfadeMs?: number, by?: string) {
    const s = this.library.scenes.find((x) => x.id === sceneId);
    if (!s) throw new Error("Scene not found");
    if (s.patternId && !this.library.getPattern(s.patternId)) throw new Error("The scene's pattern no longer exists");
    const patternError = s.patternId ? this.library.getPattern(s.patternId)?.error : undefined;
    if (patternError) throw new Error(`The scene's pattern has an error: ${patternError}`);
    this.state.overrides = JSON.parse(JSON.stringify(s.overrides ?? {}));
    this.engine.overrides = this.state.overrides;
    this.state.master = s.master; this.engine.master = s.master;
    this.state.speed = s.speed ?? 1; this.engine.speed = this.state.speed;
    if (s.bpm) this.engine.setBpm(s.bpm);
    this.state.activeSceneId = s.id;
    this.setPattern(s.patternId, s.params, crossfadeMs, true, by);
    // Legacy scenes own their declared ordinary output; do not inherit manual holds from a prior scene.
    if (!s.washes) for (const f of washFixtures(this.getRig())) this.state.washes[f.id] = { ...defaultWashState(), owner: "pattern", mode: "normal" };
    if (s.washes) {
      for (const f of washFixtures(this.getRig())) {
        const savedWash = s.washes[f.id];
        if (savedWash) this.state.washes[f.id] = { ...savedWash, owner: savedWash.owner === "pattern" ? "pattern" : "manual" };
      }
    }
    // Legacy scene overrides remain usable, even when they contain no pattern.
    for (const f of washFixtures(this.getRig())) {
      const ov = this.state.overrides[f.id];
      if (ov && !s.washes?.[f.id]) this.state.washes[f.id] = { ...(this.state.washes[f.id] ?? defaultWashState()), owner: "pattern", mode: "normal" };
    }
    if (s.patternId || Object.keys(s.overrides ?? {}).length || Object.values(this.state.washes).some((w) => w.owner !== "pattern" && w.mode !== "off")) this.state.stopped = false;
    this.engine.refresh(); this.changed();
  }

  // ---- playlists ----
  playPlaylist(playlistId: string, stepIndex = 0) {
    const pl = this.library.playlists.find((p) => p.id === playlistId);
    if (!pl || pl.steps.length === 0) throw new Error("Playlist is empty");
    this.stopPlaylist(false);
    this.runStep(pl, Math.max(0, Math.min(pl.steps.length - 1, stepIndex)));
  }

  private runStep(pl: Playlist, idx: number) {
    const step = pl.steps[idx];
    try { this.recallScene(step.sceneId, step.crossfadeMs ?? this.state.crossfadeMs); }
    catch (e) { this.emit("toast", { level: "warning", text: `Playlist step skipped: ${(e as Error).message}` }); }
    const now = Date.now();
    // A scene may supply a new BPM; its bars start on that scene's tempo.
    const ms = Math.max(250, step.unit === "bars" ? (step.duration * 4 * 60000) / this.engine.bpm : step.duration * 1000);
    this.state.playlist = { playlistId: pl.id, stepIndex: idx, stepStartedAt: now, stepEndsAt: now + ms, playing: true };
    this.changed();
    const generation = this.state.generation;
    this.playlistTimer = setTimeout(() => { if (generation === this.state.generation) this.advance(1); }, ms);
  }

  private advance(dir: 1 | -1) {
    const pb = this.state.playlist;
    if (!pb) return;
    const pl = this.library.playlists.find((p) => p.id === pb.playlistId);
    if (!pl || pl.steps.length === 0) { this.stopPlaylist(); return; }
    let next = pb.stepIndex + dir;
    if (pl.shuffle && pl.steps.length > 1 && dir === 1) {
      do next = Math.floor(Math.random() * pl.steps.length); while (next === pb.stepIndex);
    }
    if (next >= pl.steps.length) { if (pl.loop) next = 0; else { this.stopPlaylist(); return; } }
    if (next < 0) next = pl.loop ? pl.steps.length - 1 : 0;
    if (this.playlistTimer) clearTimeout(this.playlistTimer);
    this.runStep(pl, next);
  }
  playlistNext() { this.advance(1); }
  playlistPrev() { this.advance(-1); }

  stopPlaylist(emit = true) {
    if (this.playlistTimer) clearTimeout(this.playlistTimer);
    this.playlistTimer = null;
    this.state.playlist = null;
    if (emit) this.changed();
  }
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

const finiteRange = (v: unknown, min: number, max: number, fallback: number): number => typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
