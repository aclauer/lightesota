export default {
  name: "Two-Tone Gradient",
  description: "A gradient between two colors across the room that slowly rotates.",
  tags: ["static", "color", "calm"],
  params: {
    colorA: { type: "color", default: "#ff6a00", label: "Color A" },
    colorB: { type: "color", default: "#0066ff", label: "Color B" },
    rotation: { type: "number", default: 0, min: 0, max: 360, step: 1, unit: "deg", label: "Angle" },
    spin: { type: "number", default: 0.02, min: 0, max: 0.5, step: 0.005, label: "Spin speed", group: "Timing" },
    contrast: { type: "number", default: 1, min: 0.2, max: 3, step: 0.05, label: "Contrast" },
    spots: { type: "number", default: 0.4, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    const ang = (p.rotation / 360 + ctx.t * p.spin) * Math.PI * 2;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    for (const f of ctx.fixtures) {
      const proj = (f.nx - 0.5) * dx + (f.ny - 0.5) * dy;
      const t = clamp01(0.5 + proj * p.contrast);
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, mix(hex(p.colorA), hex(p.colorB), t));
    }
  },
};
