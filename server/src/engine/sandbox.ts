import vm from "node:vm";
import {
  clamp, clamp01, fract, hex, hsl, hsv, lerp, luminance, mix, paletteAt, PALETTES, scale, smoothstep, wrap,
  defaultParams, sanitizeParams, validateSchema,
  type ParamSchema, type ParamValues, type RGB,
} from "../../../shared/src/index.js";
import { noise, noise2, noise3 } from "./noise.js";
import { findLaserLook, laserStateFromPattern, nearestLaserColor, type LaserState } from "../../../shared/src/index.js";

/** Fixture description handed to patterns. */
export interface SandboxFixture {
  id: string; name: string; index: number;
  x: number; y: number; nx: number; ny: number; dist: number; angle: number; rotation: number;
  kind: "wash" | "spot" | "hue" | "other";
  tags: string[];
  isColor: boolean;
  /** Strip points only: 0..1 position along the whole balcony stretch (all strips end to end, left to right). */
  u?: number;
}

/** Per-fixture output: r g b w a uv dim strobe */
export const OUT_STRIDE = 8;

export interface CompiledPattern {
  name: string;
  description: string;
  tags: string[];
  params: ParamSchema;
  usesBeat: boolean;
  /** Set when the module exports `lasers` (a look id or a function). */
  usesLasers: boolean;
  laserLook?: string;
  laserFn?: (ctx: RenderCtx) => unknown;
  init?: (ctx: RenderCtx) => void;
  render: (ctx: RenderCtx) => void;
  /** Run a pattern function inside the vm with a hard timeout (protects against infinite loops). */
  invoke: (fn: (ctx: RenderCtx) => void, ctx: RenderCtx, timeoutMs: number) => void;
  /** Same, returning the function's result (used for lasers()). */
  invokeValue: (fn: (ctx: RenderCtx) => unknown, ctx: RenderCtx, timeoutMs: number) => unknown;
}

export interface AudioState { active: boolean; level: number; bass: number; mid: number; high: number; onset: boolean; bpm: number | null; }
export const SILENT_AUDIO: AudioState = { active: false, level: 0, bass: 0, mid: 0, high: 0, onset: false, bpm: null };

export interface RenderCtx {
  t: number; dt: number; frame: number; bpm: number; beat: number; beatPhase: number;
  bar: number; barPhase: number; onBeat: boolean;
  audio: AudioState;
  params: ParamValues; state: Record<string, unknown>;
  n: number; fixtures: SandboxFixture[];
  washes: SandboxFixture[]; spots: SandboxFixture[]; hue: SandboxFixture[];
  /** Strip points in order along the stretch; each has f.u (0 at one end, 1 at the other). */
  strips: SandboxFixture[];
  /** Number of enabled lasers (not in fixtures). */
  lasers: number;
  random: () => number;
  set: (f: SandboxFixture | number, color: RGB | string | number[], extras?: Extras) => void;
  fill: (color: RGB | string | number[], extras?: Extras) => void;
  get: (f: SandboxFixture | number) => { r: number; g: number; b: number; w: number; a: number; uv: number; dim: number; strobe: number };
  byTag: (tag: string) => SandboxFixture[];
  log: (...args: unknown[]) => void;
}
interface Extras { w?: number; a?: number; uv?: number; dim?: number; strobe?: number }

const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => t * (2 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  inCubic: (t: number) => t * t * t,
  outCubic: (t: number) => --t * t * t + 1,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1),
  outExpo: (t: number) => (t === 1 ? 1 : 1 - Math.pow(2, -10 * t)),
  outBack: (t: number) => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  outBounce: (t: number) => {
    const n1 = 7.5625, d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};
const tri = (p: number) => { p = fract(p); return p < 0.5 ? p * 2 : 2 - p * 2; };
const saw = (p: number) => fract(p);
const square = (p: number, duty = 0.5) => (fract(p) < duty ? 1 : 0);
const pulse = (p: number, width = 0.1) => { p = fract(p); return p < width ? 1 - p / width : 0; };

function makeGlobals(log: (...a: unknown[]) => void) {
  return {
    hsv, hsl, hex, mix, scale, paletteAt, PALETTES: Object.freeze({ ...PALETTES }), laserColor: nearestLaserColor,
    lerp, clamp, clamp01, smoothstep, fract, wrap, luminance,
    noise, noise2, noise3, tri, saw, square, pulse, ease: Object.freeze({ ...ease }),
    Math, Array, Object, JSON, Number, String, Boolean, Map, Set, isFinite, isNaN, parseInt, parseFloat,
    Infinity, NaN, undefined,
    console: { log, warn: log, error: log, info: log },
  };
}

/** Rewrite `export default X` to `module.exports = X` so patterns can be written as ES modules. */
export function normalizeSource(src: string): string {
  return src.replace(/^\s*export\s+default\s+/m, "module.exports = ");
}

export interface CompileOptions {
  /** Max ms the top-level code may run. */
  timeoutMs?: number;
  log?: (...a: unknown[]) => void;
}

export function compilePattern(source: string, opts: CompileOptions = {}): CompiledPattern {
  const log = opts.log ?? (() => {});
  const wrapped = `(function (module, exports) {\n${normalizeSource(source)}\n})`;
  const context = vm.createContext(makeGlobals(log), { codeGeneration: { strings: false, wasm: false } });
  let factory: unknown;
  try {
    factory = new vm.Script(wrapped, { filename: "pattern.js" }).runInContext(context, { timeout: opts.timeoutMs ?? 1000 });
  } catch (e) {
    throw new Error(`Syntax error: ${(e as Error).message}`);
  }
  const module = { exports: {} as Record<string, unknown> };
  try {
    (factory as (m: typeof module, e: unknown) => void)(module, module.exports);
  } catch (e) {
    throw new Error(`Error while loading: ${(e as Error).message}`);
  }
  const def = (module.exports && typeof module.exports === "object" && "default" in module.exports
    ? (module.exports as { default: unknown }).default : module.exports) as Record<string, unknown>;
  if (!def || typeof def !== "object") throw new Error("Pattern must export an object (export default { ... })");
  if (typeof def.render !== "function") throw new Error("Pattern must define render(ctx)");
  const params = validateSchema(def.params);
  const srcForBeat = source;
  let laserLook: string | undefined, laserFn: ((ctx: RenderCtx) => unknown) | undefined;
  if (typeof def.lasers === "string") {
    if (!findLaserLook(def.lasers)) throw new Error(`lasers: unknown look "${def.lasers}"`);
    laserLook = def.lasers;
  } else if (typeof def.lasers === "function") laserFn = def.lasers as (ctx: RenderCtx) => unknown;
  else if (def.lasers !== undefined && def.lasers !== null) throw new Error("lasers must be a look name or a function");
  const usesLasers = !!(laserLook || laserFn);
  const invokeScript = new vm.Script("__invoke_fn(__invoke_arg)", { filename: "invoke.js" });
  const invokeValueScript = new vm.Script("__invoke_out = __invoke_fn(__invoke_arg)", { filename: "invoke.js" });
  const ctxAny = context as Record<string, unknown>;
  const invoke = (fn: (ctx: RenderCtx) => void, ctx: RenderCtx, timeoutMs: number) => {
    ctxAny.__invoke_fn = fn;
    ctxAny.__invoke_arg = ctx;
    try {
      invokeScript.runInContext(context, { timeout: timeoutMs });
    } finally {
      ctxAny.__invoke_fn = undefined;
      ctxAny.__invoke_arg = undefined;
    }
  };
  const invokeValue = (fn: (ctx: RenderCtx) => unknown, ctx: RenderCtx, timeoutMs: number) => {
    ctxAny.__invoke_fn = fn;
    ctxAny.__invoke_arg = ctx;
    ctxAny.__invoke_out = undefined;
    try {
      invokeValueScript.runInContext(context, { timeout: timeoutMs });
      // Copy out of the vm realm as plain data.
      return JSON.parse(JSON.stringify(ctxAny.__invoke_out ?? null));
    } finally {
      ctxAny.__invoke_fn = undefined;
      ctxAny.__invoke_arg = undefined;
      ctxAny.__invoke_out = undefined;
    }
  };
  return {
    invoke, invokeValue,
    name: typeof def.name === "string" && def.name.trim() ? def.name.trim().slice(0, 60) : "Untitled",
    description: typeof def.description === "string" ? def.description.slice(0, 400) : "",
    tags: [...new Set([...(Array.isArray(def.tags) ? def.tags.filter((t) => typeof t === "string").map((t) => String(t).toLowerCase().slice(0, 24)).slice(0, 10) : []), ...(usesLasers ? ["laser"] : [])])],
    params,
    usesBeat: /\b(beat|beatPhase|bar|barPhase|onBeat|bpm)\b/.test(srcForBeat),
    usesLasers, laserLook, laserFn,
    init: typeof def.init === "function" ? (def.init as (ctx: RenderCtx) => void) : undefined,
    render: def.render as (ctx: RenderCtx) => void,
  };
}

/** Strip points (tag "strip") sorted along their line; u is assigned by rank so it survives any placement. */
function stripsOf(fixtures: SandboxFixture[]): SandboxFixture[] {
  const s = fixtures.filter((f) => f.tags.includes("strip") || f.tags.includes("segment"));
  if (s.length === 0) return s;
  // Sort along the dominant axis of the stretch.
  const xs = s.map((f) => f.x), ys = s.map((f) => f.y);
  const horizontal = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
  s.sort((a, b) => (horizontal ? a.x - b.x : a.y - b.y));
  s.forEach((f, i) => { f.u = s.length === 1 ? 0.5 : i / (s.length - 1); });
  return s;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toRGB(c: RGB | string | number[]): RGB {
  if (typeof c === "string") return hex(c);
  if (Array.isArray(c)) return [Number(c[0]) || 0, Number(c[1]) || 0, Number(c[2]) || 0];
  return [0, 0, 0];
}

/** A running instance of a compiled pattern. Owns its output buffer. */
export class PatternInstance {
  readonly out: Float32Array;
  readonly ctx: RenderCtx;
  private frame = 0;
  private lastBeatInt = -1;
  t = 0;
  params: ParamValues;
  error: string | null = null;
  /** Set after a render timeout; the pattern stays dark until it is edited and reloaded. */
  disabled = false;
  /** Per-frame budget for render(). */
  timeoutMs = 100;

  constructor(public readonly compiled: CompiledPattern, public fixtures: SandboxFixture[], params: ParamValues | undefined, seed: number, private log: (...a: unknown[]) => void = () => {}) {
    this.params = sanitizeParams(compiled.params, params);
    this.out = new Float32Array(Math.max(1, fixtures.length) * OUT_STRIDE);
    const self = this;
    const idx = (f: SandboxFixture | number) => (typeof f === "number" ? f : f.index);
    const ctx: RenderCtx = {
      t: 0, dt: 0, frame: 0, bpm: 120, beat: 0, beatPhase: 0, bar: 0, barPhase: 0, onBeat: false,
      audio: { ...SILENT_AUDIO },
      params: this.params, state: {},
      n: fixtures.length, fixtures, lasers: 0,
      washes: fixtures.filter((f) => f.kind === "wash"),
      spots: fixtures.filter((f) => f.kind === "spot"),
      hue: fixtures.filter((f) => f.kind === "hue"),
      strips: stripsOf(fixtures),
      random: mulberry32(seed),
      set(f, color, extras) {
        const i = idx(f);
        if (i < 0 || i >= self.fixtures.length) return;
        const [r, g, b] = toRGB(color);
        const o = i * OUT_STRIDE, out = self.out;
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = extras?.w ?? 0; out[o + 4] = extras?.a ?? 0; out[o + 5] = extras?.uv ?? 0;
        out[o + 6] = extras?.dim ?? 1; out[o + 7] = extras?.strobe ?? 0;
      },
      fill(color, extras) { for (let i = 0; i < self.fixtures.length; i++) ctx.set(i, color, extras); },
      get(f) {
        const o = idx(f) * OUT_STRIDE, out = self.out;
        return { r: out[o], g: out[o + 1], b: out[o + 2], w: out[o + 3], a: out[o + 4], uv: out[o + 5], dim: out[o + 6], strobe: out[o + 7] };
      },
      byTag: (tag) => fixtures.filter((f) => f.tags.includes(tag)),
      log: (...a) => this.log(...a),
    };
    this.ctx = ctx;
    if (compiled.init) {
      try { compiled.invoke(compiled.init, ctx, 500); } catch (e) { this.error = `init(): ${(e as Error).message}`; }
    }
  }

  setParams(p: ParamValues) {
    this.params = sanitizeParams(this.compiled.params, p);
    this.ctx.params = this.params;
  }
  setLaserCount(n: number) { this.ctx.lasers = n; }

  laserError: string | null = null;
  /** Evaluate the pattern's lasers() for the current ctx. Every entry is forced into the approved vocabulary. */
  lasers(): LaserState[] | null {
    const fn = this.compiled.laserFn;
    if (!fn || this.disabled) return null;
    let raw: unknown;
    try {
      raw = this.compiled.invokeValue(fn, this.ctx, 50);
      this.laserError = null;
    } catch (e) {
      this.laserError = `lasers(): ${(e as Error).message}`;
      return [];
    }
    const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
    return list.slice(0, 8).map((x) => laserStateFromPattern(x));
  }

  setFixtures(fixtures: SandboxFixture[]) {
    this.fixtures = fixtures;
    this.ctx.fixtures = fixtures;
    this.ctx.n = fixtures.length;
    this.ctx.washes = fixtures.filter((f) => f.kind === "wash");
    this.ctx.spots = fixtures.filter((f) => f.kind === "spot");
    this.ctx.hue = fixtures.filter((f) => f.kind === "hue");
    this.ctx.strips = stripsOf(fixtures);
    (this as { out: Float32Array }).out = new Float32Array(Math.max(1, fixtures.length) * OUT_STRIDE);
  }

  render(dt: number, bpm: number, beat: number, audio: AudioState = SILENT_AUDIO) {
    const c = this.ctx;
    c.audio = audio;
    this.t += dt;
    c.t = this.t; c.dt = dt; c.frame = this.frame++;
    c.bpm = bpm; c.beat = beat; c.beatPhase = fract(beat);
    c.bar = beat / 4; c.barPhase = fract(beat / 4);
    const bi = Math.floor(beat);
    c.onBeat = bi !== this.lastBeatInt;
    this.lastBeatInt = bi;
    this.out.fill(0);
    if (this.disabled) return;
    try {
      this.compiled.invoke(this.compiled.render, c, this.timeoutMs);
      this.error = null;
    } catch (e) {
      const msg = (e as Error).message;
      if (/timed out/i.test(msg)) {
        this.disabled = true;
        this.error = `render() took longer than ${this.timeoutMs} ms (infinite loop?). Pattern disabled until edited.`;
      } else this.error = `render(): ${msg}`;
    }
    // Sanitize NaNs so a bad pattern cannot poison the output.
    const out = this.out;
    for (let i = 0; i < out.length; i++) {
      const v = out[i];
      out[i] = v !== v ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
    }
  }
}

/** Compile, instantiate and render a few frames with a synthetic rig to validate a pattern. */
export function testPattern(source: string, fixtures?: SandboxFixture[]) {
  const logs: string[] = [];
  const compiled = compilePattern(source, { timeoutMs: 1000, log: (...a) => { if (logs.length < 20) logs.push(a.map(String).join(" ")); } });
  const fx = fixtures ?? syntheticFixtures();
  const inst = new PatternInstance(compiled, fx, defaultParams(compiled.params), 1, () => {});
  inst.timeoutMs = 250;
  inst.setLaserCount(2);
  if (inst.error) throw new Error(inst.error);
  const t0 = performance.now();
  for (let i = 0; i < 30; i++) {
    inst.render(1 / 40, 120, i * 0.05 * 2);
    if (inst.error) throw new Error(inst.error);
    if (compiled.laserFn && i % 10 === 0) { inst.lasers(); if (inst.laserError) throw new Error(inst.laserError); }
  }
  const perFrameMs = (performance.now() - t0) / 30;
  // Swatch: colors of up to 5 fixtures on the final frame.
  const swatch: string[] = [];
  for (let i = 0; i < Math.min(fx.length, 6); i++) {
    const o = i * OUT_STRIDE;
    const d = inst.out[o + 6];
    const r = inst.out[o] * d, g = inst.out[o + 1] * d, b = inst.out[o + 2] * d;
    const w = inst.out[o + 3] * d;
    swatch.push(rgbHex(Math.min(1, r + w), Math.min(1, g + w), Math.min(1, b + w)));
  }
  let lit = 0;
  for (let i = 0; i < fx.length; i++) {
    const o = i * OUT_STRIDE;
    if (Math.max(inst.out[o], inst.out[o + 1], inst.out[o + 2], inst.out[o + 3]) * inst.out[o + 6] > 0.02) lit++;
  }
  return { compiled, perFrameMs, swatch, logs, litFixtures: lit, fixtureCount: fx.length };
}

function rgbHex(r: number, g: number, b: number) {
  const c = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function syntheticFixtures(): SandboxFixture[] {
  const pts: [number, number, SandboxFixture["kind"]][] = [[0.1, 0.1, "wash"], [0.9, 0.1, "wash"], [0.1, 0.9, "wash"], [0.9, 0.9, "wash"], [0.4, 0.5, "spot"], [0.6, 0.5, "spot"]];
  return pts.map(([nx, ny, kind], i) => ({
    id: `f${i}`, name: `${kind} ${i}`, index: i, x: nx * 10, y: ny * 8, nx, ny,
    dist: Math.min(1, Math.hypot(nx - 0.5, ny - 0.5) / 0.7071), angle: Math.atan2(ny - 0.5, nx - 0.5), rotation: 0,
    kind, tags: [kind], isColor: kind !== "spot",
  }));
}
