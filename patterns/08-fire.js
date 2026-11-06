export default {
  name: "Fireplace",
  description: "Warm flicker driven by smooth noise, with amber and a hint of UV.",
  tags: ["ambient", "warm"],
  // Lasers: red and yellow waves that drift open and closed with the flicker.
  lasers(ctx) {
    const s = 0.3 + 0.4 * noise(ctx.t * 0.2);
    return [{ mode: "manual", pattern: "wave", color: "red", spread: s }, { mode: "manual", pattern: "wave", color: "yellow", spread: 0.8 - s }];
  },
  params: {
    speed: { type: "number", default: 1.2, min: 0.1, max: 5, step: 0.1, label: "Flicker speed" },
    heat: { type: "number", default: 0.6, min: 0, max: 1, step: 0.01, label: "Heat (yellow vs red)" },
    amber: { type: "number", default: 0.7, min: 0, max: 1, step: 0.01, label: "Amber channel" },
    depth: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Flicker depth" },
    spots: { type: "number", default: 0.25, min: 0, max: 1, step: 0.01, label: "Pinspot glow" },
  },
  render(ctx) {
    const p = ctx.params;
    for (const f of ctx.fixtures) {
      const n = 0.5 + 0.5 * noise2(ctx.t * p.speed + f.index * 7.3, f.nx * 3);
      const n2 = 0.5 + 0.5 * noise2(ctx.t * p.speed * 2.3 + 40 + f.index, f.ny * 3);
      const level = 1 - p.depth * (0.6 * n + 0.4 * n2);
      const col = mix([1, 0.08, 0], [1, 0.55, 0.05], p.heat * n);
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: level * p.spots });
      else ctx.set(f, col, { a: p.amber * level, dim: level });
    }
  },
};
