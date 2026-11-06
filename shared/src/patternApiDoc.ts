/** Documentation of the pattern scripting API. Shown in the editor and given to the agent. */
export const PATTERN_API_DOC = String.raw`
A pattern is a JavaScript module that exports an object with metadata, a params schema and a render function.
It runs on the server about 40 times per second. Each call paints every fixture for the current frame.

  export default {
    name: "Rainbow Sweep",
    description: "Hue gradient that slides across the room.",
    tags: ["color", "calm"],
    params: {
      speed:   { type: "number", default: 0.25, min: 0, max: 2, step: 0.01, unit: "cycles/beat", label: "Speed" },
      spread:  { type: "number", default: 1, min: 0, max: 3, step: 0.05, label: "Spread" },
      sat:     { type: "number", default: 1, min: 0, max: 1, step: 0.01, label: "Saturation", group: "Color" },
      beatSync:{ type: "boolean", default: true, label: "Sync to BPM" },
      axis:    { type: "select", default: "x", options: ["x", "y", "radial"] },
      base:    { type: "color", default: "#ff6a00" },
      colors:  { type: "palette", default: ["#ff0040", "#00c0ff"] },
    },
    init(ctx) { ctx.state.particles = []; },   // optional, runs once per activation
    render(ctx) {
      const { speed, spread, sat, beatSync, axis } = ctx.params;
      const phase = beatSync ? ctx.beat * speed : ctx.t * speed;
      for (const f of ctx.fixtures) {
        const pos = axis === "x" ? f.nx : axis === "y" ? f.ny : f.dist;
        ctx.set(f, hsv(phase + pos * spread, sat, 1));
      }
    },
  };

Param types: number (min, max, default, step?, unit?, log?), color ("#rrggbb"), boolean, select (options[]),
palette (array of "#rrggbb"). Optional label, description, group. Params are editable live in the UI, so
anything a user might want to tweak (timing, colors, counts, widths) should be a param, not a constant.

ctx fields, read-only unless noted:
  ctx.t          seconds since the pattern started (scaled by the global speed control)
  ctx.dt         seconds since the previous frame
  ctx.frame      frame counter
  ctx.bpm        current BPM
  ctx.beat       beats elapsed as a float (4.25 = a quarter past beat 4). Use fract(ctx.beat) for the beat phase.
  ctx.beatPhase  fract(ctx.beat)
  ctx.bar        bars elapsed as a float (4 beats per bar)
  ctx.barPhase   fract(ctx.bar)
  ctx.onBeat     true on the first frame of each beat
  ctx.params     current param values (already defaulted and clamped)
  ctx.state      a plain object that persists between frames for this activation (writable)
  ctx.n          fixture count
  ctx.fixtures   array of fixtures in rig order:
                   { id, name, index, x, y, nx, ny, dist, angle, rotation, kind, tags, isColor }
                 nx/ny are 0..1 across the room bounding box; dist is 0..1 from the room center;
                 angle is radians from the room center; kind is "wash" | "spot" | "hue" | "other";
                 isColor is false for intensity-only fixtures (they take the brightness of the color).
  ctx.audio      microphone analysis when someone has the mic on: { active, level, bass, mid, high, onset, bpm }
                 (0..1 values; onset is true on the frame a beat was detected; active is false when nobody
                 streams audio, so always fall back to ctx.beat or ctx.t in that case)
  ctx.random()   deterministic PRNG for this activation
  ctx.set(fixtureOrIndex, color, extras?)  paint a fixture. color is [r,g,b] 0..1 or a "#rrggbb" string.
                 extras: { w, a, uv, dim, strobe } each 0..1. dim defaults to 1; strobe > 0 enables the
                 fixture's strobe channel if it has one. Fixtures not set in a frame stay black.
  ctx.fill(color, extras?)  paint every fixture.
  ctx.get(fixtureOrIndex)   read what has been set so far this frame ({ r, g, b, w, a, uv, dim, strobe }).
  ctx.byTag(tag)            fixtures with a tag, e.g. ctx.byTag("wash").
  ctx.washes / ctx.spots / ctx.hue   shortcuts for kind === "wash" / "spot" / "hue".

Helpers available as globals:
  hsv(h, s, v), hsl(h, s, l), hex("#ff0000"), mix(a, b, t), scale(c, k), paletteAt(colorsArray, t),
  PALETTES.rainbow / sunset / ocean / forest / candy / fire / ice / neon / warm,
  lerp, clamp, clamp01, smoothstep, fract, wrap, luminance,
  noise(x), noise2(x, y), noise3(x, y, z) (smooth value noise in -1..1),
  tri(phase), saw(phase), square(phase, duty), pulse(phase, width) (0..1 waveforms over a 0..1 phase),
  ease.inQuad/outQuad/inOutQuad/inCubic/outCubic/inOutCubic/outExpo/outBack/outBounce,
  Math and the usual JS built-ins. No network, filesystem, timers or DOM.

Guidelines: keep render cheap (a few microseconds per fixture). Prefer ctx.beat for anything rhythmic so the
pattern follows the BPM. Decay effects should use ctx.dt so they are frame-rate independent. Intensity-only
fixtures (pinspots) only show brightness, so give them something meaningful.
`;
