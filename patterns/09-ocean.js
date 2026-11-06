export default {
  name: "Ocean",
  description: "Slow rolling waves of blue and teal across the room.",
  tags: ["ambient", "cool", "flow"],
  // Lasers: slow cyan and blue waves breathing in and out with the swell.
  lasers(ctx) {
    const swell = 0.5 + 0.5 * Math.sin(ctx.t * ctx.params.speed * 2);
    return [{ mode: "manual", pattern: "wave", color: "cyan", spread: swell }, { mode: "manual", pattern: "wave", color: "blue", spread: 1 - swell }];
  },
  params: {
    palette: { type: "palette", default: ["#00163a", "#0052a3", "#00a3c4", "#2ee6d6", "#0052a3"], label: "Palette" },
    speed: { type: "number", default: 0.15, min: 0, max: 1, step: 0.01, label: "Wave speed" },
    scale: { type: "number", default: 1.2, min: 0.2, max: 4, step: 0.1, label: "Wave size" },
    shimmer: { type: "number", default: 0.3, min: 0, max: 1, step: 0.01, label: "Shimmer" },
    spots: { type: "number", default: 0.3, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    for (const f of ctx.fixtures) {
      const w = 0.5 + 0.5 * noise3(f.nx * p.scale, f.ny * p.scale, ctx.t * p.speed);
      const s = 1 - p.shimmer * (0.5 + 0.5 * noise2(ctx.t * 2 + f.index * 3, 0.3));
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: w * p.spots });
      else ctx.set(f, paletteAt(p.palette, w), { dim: s });
    }
  },
};
