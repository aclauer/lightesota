export default {
  name: "Ring Runner",
  description: "A dot one strip long runs around the room on the strips, locked to the BPM, with the washes lighting as it passes them.",
  tags: ["strip", "beat", "movement"],
  params: {
    color: { type: "color", default: "#00e5ff", label: "Dot color" },
    background: { type: "color", default: "#000820", label: "Strip background" },
    lapBeats: { type: "number", default: 8, min: 1, max: 64, step: 1, label: "Beats per lap", group: "Timing" },
    length: { type: "number", default: 5, min: 1, max: 25, step: 1, unit: "px", label: "Dot length (5 = one strip)" },
    edge: { type: "number", default: 1, min: 0.2, max: 4, step: 0.1, label: "Edge softness (pixels)" },
    dots: { type: "number", default: 1, min: 1, max: 4, step: 1, label: "Dots around the ring" },
    reverse: { type: "boolean", default: false, label: "Run the other way" },
    washFollow: { type: "number", default: 0.7, min: 0, max: 1, step: 0.01, label: "Washes light as it passes" },
    washColor: { type: "color", default: "#00e5ff", label: "Wash color" },
    washFloor: { type: "number", default: 0.08, min: 0, max: 1, step: 0.01, label: "Wash floor" },
  },
  render(ctx) {
    const p = ctx.params;
    const n = ctx.strips.length;
    const lap = fract(ctx.beat / p.lapBeats) * (p.reverse ? -1 : 1);
    stripFill(ctx, p.background);
    for (let d = 0; d < p.dots; d++) stripDot(ctx, ((lap + d / p.dots) % 1 + 1) % 1 * n, p.length, p.color, null, p.edge);
    // Washes: brightness by how close the dot is (by angle around the room) to each wash.
    const head = ctx.strips[Math.round((((lap % 1) + 1) % 1) * (n - 1))];
    for (const f of ctx.fixtures) {
      if (f.u !== undefined) continue;
      if (f.kind === "spot") { ctx.set(f, [1, 1, 1], { dim: p.washFloor }); continue; }
      let near = 0;
      if (head) { let da = Math.abs(f.angle - head.angle); da = Math.min(da, Math.PI * 2 - da); near = Math.max(0, 1 - da / 1.2); }
      ctx.set(f, hex(p.washColor), { dim: p.washFloor + (1 - p.washFloor) * near * p.washFollow });
    }
  },
};
