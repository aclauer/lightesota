export default {
  name: "Lounge Drift",
  description: "Dim, slowly drifting warm tones for a relaxed room.",
  tags: ["ambient", "calm", "warm"],
  params: {
    palette: { type: "palette", default: ["#ff6a00", "#ff2d95", "#6a00ff", "#ff9a00"], label: "Palette" },
    speed: { type: "number", default: 0.03, min: 0, max: 0.3, step: 0.005, label: "Drift speed" },
    level: { type: "number", default: 0.45, min: 0, max: 1, step: 0.01, label: "Level" },
    variation: { type: "number", default: 0.4, min: 0, max: 1, step: 0.01, label: "Variation between fixtures" },
    spots: { type: "number", default: 0.15, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    for (const f of ctx.fixtures) {
      const t = ctx.t * p.speed + f.index * p.variation * 0.37 + 0.3 * noise2(ctx.t * p.speed * 2, f.index);
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, paletteAt(p.palette, t), { dim: p.level });
    }
  },
};
