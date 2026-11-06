export default {
  name: "Rainbow Sweep",
  description: "A hue gradient slides across the room. Follows the BPM when synced.",
  tags: ["color", "flow"],
  params: {
    speed: { type: "number", default: 0.125, min: 0, max: 2, step: 0.005, unit: "cycles/beat", label: "Speed", group: "Timing" },
    beatSync: { type: "boolean", default: true, label: "Sync to BPM", group: "Timing" },
    spread: { type: "number", default: 0.6, min: 0, max: 3, step: 0.05, label: "Spread across room" },
    axis: { type: "select", default: "x", options: ["x", "y", "radial", "angle"], label: "Direction" },
    saturation: { type: "number", default: 1, min: 0, max: 1, step: 0.01, label: "Saturation", group: "Color" },
    spotPulse: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Pinspot pulse depth" },
  },
  render(ctx) {
    const p = ctx.params;
    const phase = p.beatSync ? ctx.beat * p.speed : ctx.t * p.speed * 2;
    for (const f of ctx.fixtures) {
      const pos = p.axis === "x" ? f.nx : p.axis === "y" ? f.ny : p.axis === "radial" ? f.dist : (f.angle / (Math.PI * 2) + 0.5);
      if (f.kind === "spot") {
        const v = 1 - p.spotPulse * (0.5 + 0.5 * Math.sin((phase + pos * p.spread) * Math.PI * 2));
        ctx.set(f, [1, 1, 1], { dim: v });
      } else ctx.set(f, hsv(phase + pos * p.spread, p.saturation, 1));
    }
  },
};
