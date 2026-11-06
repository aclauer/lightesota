export default {
  name: "Work Light",
  description: "Even warm white for working, pinspots on the desks.",
  tags: ["static", "utility"],
  params: {
    warmth: { type: "number", default: 0.35, min: 0, max: 1, step: 0.01, label: "Warmth" },
    level: { type: "number", default: 0.8, min: 0, max: 1, step: 0.01, label: "Wash level" },
    spots: { type: "number", default: 0.7, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    const col = mix([1, 1, 1], [1, 0.75, 0.45], p.warmth);
    for (const f of ctx.fixtures) {
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, col, { w: 1 - p.warmth * 0.5, a: p.warmth * 0.6, dim: p.level });
    }
  },
};
