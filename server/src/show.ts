import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import {
  defaultParams, sanitizeParams,
  type AudioFrame, type FixtureOverride, type ParamValues, type Rig, type Scene, type Settings, type ShowState, type Playlist,
} from "../../shared/src/index.js";
import { Engine } from "./engine/engine.js";
import type { Library } from "./library.js";
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

  constructor(private library: Library, private getRig: () => Rig, private getSettings: () => Settings) {
    super();
    this.file = new JsonFile<Partial<ShowState>>("show.json", () => ({}));
    const saved = this.file.get();
    const base: ShowState = {
      history: [],
      patternId: null, params: {}, outgoingPatternId: null, crossfadeMs: 800, master: 1, blackout: false, speed: 1,
      transport: { bpm: 120, beatOrigin: Date.now(), running: true },
      overrides: {}, solo: [], activeSceneId: null, playlist: null, released: false,
      sleepAt: null, audio: { active: false, source: null, followBpm: false, level: 0, bpm: null },
    };
    this.state = {
      ...base,
      ...saved,
      transport: { bpm: saved.transport?.bpm ?? 120, beatOrigin: Date.now(), running: true },
      playlist: null,
      blackout: false,
      outgoingPatternId: null,
      sleepAt: null,
      audio: { active: false, source: null, followBpm: saved.audio?.followBpm ?? false, level: 0, bpm: null },
      history: Array.isArray(saved.history) ? saved.history.filter((h) => h && typeof h.patternId === "string").slice(0, 12) : [],
    };
    setInterval(() => this.audioTick(), 500).unref();
    this.engine.on("patternLoaded", ({ id, params }) => {
      if (id === this.state.patternId) { this.state.params = params; this.state.outgoingPatternId = null; this.changed(); }
    });
    this.engine.on("patternError", ({ error }) => this.emit("toast", { level: "error", text: `Pattern failed to load: ${error}` }));
  }

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

  stop() { this.engine.stop(); this.stopPlaylist(); if (this.sleepTimer) clearTimeout(this.sleepTimer); this.file.flush(); }

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
    this.engine.setAudio(frame);
    const a = this.state.audio;
    const changed = !a.active || a.source !== clientName || Math.abs(a.level - frame.level) > 0.08 || a.bpm !== frame.bpm;
    this.state.audio = { ...a, active: true, source: clientName, level: frame.level, bpm: frame.bpm };
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
      this.stopPlaylist(false);
      this.setBlackout(true);
      this.emit("toast", { level: "info", text: "Sleep timer: lights off" });
    }, ms);
    this.changed();
  }

  rigChanged() { this.engine.setRig(this.getRig()); }
  settingsChanged() { this.engine.start(this.getSettings().artnet.fps); }

  private changed() {
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
    if (!p || p.error) return;
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

  setMaster(v: number) { this.state.master = clamp01(v); this.engine.master = this.state.master; this.changed(); }
  setBlackout(b: boolean) { this.state.blackout = b; this.engine.blackout = b; this.changed(); }
  setSpeed(v: number) { this.state.speed = Math.max(0, Math.min(4, v)); this.engine.speed = this.state.speed; this.changed(); }
  setCrossfade(ms: number) { this.state.crossfadeMs = Math.max(0, Math.min(20000, ms)); this.changed(); }
  setReleased(r: boolean) { this.state.released = r; this.changed(); }

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
    if (ov) this.state.overrides[fixtureId] = ov; else delete this.state.overrides[fixtureId];
    this.engine.overrides = this.state.overrides;
    this.changed();
  }
  clearOverrides() { this.state.overrides = {}; this.engine.overrides = {}; this.changed(); }
  setSolo(ids: string[]) { this.state.solo = ids; this.engine.solo = new Set(ids); this.changed(); }

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
    this.state.overrides = JSON.parse(JSON.stringify(s.overrides ?? {}));
    this.engine.overrides = this.state.overrides;
    this.state.master = s.master; this.engine.master = s.master;
    this.state.speed = s.speed ?? 1; this.engine.speed = this.state.speed;
    if (s.bpm) this.engine.setBpm(s.bpm);
    this.state.activeSceneId = s.id;
    this.setPattern(s.patternId, s.params, crossfadeMs, true, by);
    this.changed();
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
    const now = Date.now();
    let ms = step.unit === "bars" ? (step.duration * 4 * 60000) / this.engine.bpm : step.duration * 1000;
    ms = Math.max(250, ms);
    try { this.recallScene(step.sceneId, step.crossfadeMs ?? this.state.crossfadeMs); }
    catch (e) { this.emit("toast", { level: "warning", text: `Playlist step skipped: ${(e as Error).message}` }); }
    this.state.playlist = { playlistId: pl.id, stepIndex: idx, stepStartedAt: now, stepEndsAt: now + ms, playing: true };
    this.changed();
    this.playlistTimer = setTimeout(() => this.advance(1), ms);
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
