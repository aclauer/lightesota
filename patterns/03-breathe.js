export default {
  name: "Breathe",
  description: "Slow rise and fall of one color across the room, one breath per N bars.",
  tags: ["calm", "ambient"],
  params: {
    color: { type: "color", default: "#2f6bff", label: "Color" },
    color2: { type: "color", default: "#b03cff", label: "Second color (at the top)" },
    bars: { type: "number", default: 2, min: 0.25, max: 16, step: 0.25, label: "Bars per breath", group: "Timing" },
    floor: { type: "number", default: 0.08, min: 0, max: 1, step: 0.01, label: "Minimum level" },
    stagger: { type: "number", default: 0.15, min: 0, max: 1, step: 0.01, label: "Stagger by position" },
    spots: { type: "number", default: 0.4, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    for (const f of ctx.fixtures) {
      const ph = ctx.bar / p.bars + f.nx * p.stagger;
      const v = 0.5 - 0.5 * Math.cos(ph * Math.PI * 2);
      const level = p.floor + (1 - p.floor) * ease.inOutQuad(v);
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: level * p.spots });
      else ctx.set(f, mix(hex(p.color), hex(p.color2), v), { dim: level });
    }
  },
};
