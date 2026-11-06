export default {
  name: "Beat Pulse",
  description: "Flash on every beat with an exponential decay; color steps through a palette.",
  tags: ["beat", "party"],
  // Lasers: same palette as the washes, one color per pulse, waves opening with the decay.
  lasers(ctx) {
    const p = ctx.params;
    const n = Number(p.every);
    const idx = Math.floor(ctx.beat / n);
    return [0, 1].map((i) => ({ mode: "manual", pattern: "fan", color: p.palette[(idx + i) % p.palette.length], spread: 0.5 }));
  },
  params: {
    palette: { type: "palette", default: ["#ff0040", "#ff8a00", "#ffee00", "#00e676", "#00b0ff", "#d500f9"], label: "Colors (one per beat)" },
    decay: { type: "number", default: 6, min: 1, max: 20, step: 0.5, label: "Decay speed", group: "Timing" },
    every: { type: "select", default: "1", options: ["1", "2", "4", "0.5"], label: "Pulse every N beats", group: "Timing" },
    floor: { type: "number", default: 0.05, min: 0, max: 1, step: 0.01, label: "Floor level" },
    spotsOffbeat: { type: "boolean", default: true, label: "Pinspots hit on the off-beat" },
    strobeOnBeat: { type: "number", default: 0, min: 0, max: 1, step: 0.05, label: "Strobe amount on hit" },
  },
  render(ctx) {
    const p = ctx.params;
    const n = Number(p.every);
    const b = ctx.beat / n;
    const idx = Math.floor(b);
    const phase = b - idx;
    const env = Math.exp(-phase * p.decay / Math.max(0.25, n));
    const col = hex(p.palette[idx % p.palette.length]);
    const offPhase = (b + 0.5) % 1;
    const offEnv = Math.exp(-offPhase * p.decay);
    for (const f of ctx.fixtures) {
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spotsOffbeat ? offEnv : env });
      else ctx.set(f, col, { dim: p.floor + (1 - p.floor) * env, strobe: phase < 0.15 ? p.strobeOnBeat : 0 });
    }
  },
};
