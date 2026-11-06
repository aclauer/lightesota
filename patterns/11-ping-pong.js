export default {
  name: "Ping Pong",
  description: "A soft bar of light bounces from wall to wall in time with the music.",
  tags: ["beat", "movement"],
  params: {
    color: { type: "color", default: "#ff3cac", label: "Color" },
    background: { type: "color", default: "#1a0030", label: "Background" },
    beatsPerBounce: { type: "number", default: 2, min: 0.5, max: 8, step: 0.5, label: "Beats per crossing", group: "Timing" },
    width: { type: "number", default: 0.35, min: 0.05, max: 1, step: 0.01, label: "Bar width" },
    axis: { type: "select", default: "x", options: ["x", "y"], label: "Axis" },
    easing: { type: "select", default: "inOutQuad", options: ["linear", "inOutQuad", "inOutCubic", "outBounce"], label: "Motion" },
  },
  render(ctx) {
    const p = ctx.params;
    const ph = tri(ctx.beat / p.beatsPerBounce / 2);
    const pos = ease[p.easing](ph);
    for (const f of ctx.fixtures) {
      const x = p.axis === "x" ? f.nx : f.ny;
      const v = Math.max(0, 1 - Math.abs(x - pos) / p.width);
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: v * v });
      else ctx.set(f, mix(hex(p.background), hex(p.color), v));
    }
  },
};
