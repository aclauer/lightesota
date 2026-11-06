export default {
  name: "Solid Color",
  description: "One color on every fixture, with optional white and amber blend.",
  tags: ["static", "basic"],
  params: {
    color: { type: "color", default: "#ff7a1a", label: "Color" },
    white: { type: "number", default: 0, min: 0, max: 1, step: 0.01, label: "White blend", group: "Color" },
    amber: { type: "number", default: 0, min: 0, max: 1, step: 0.01, label: "Amber blend", group: "Color" },
    intensity: { type: "number", default: 1, min: 0, max: 1, step: 0.01, label: "Intensity" },
    spots: { type: "number", default: 0.6, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const { color, white, amber, intensity, spots } = ctx.params;
    for (const f of ctx.fixtures) {
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: spots * intensity });
      else ctx.set(f, color, { w: white, a: amber, dim: intensity });
    }
  },
};
