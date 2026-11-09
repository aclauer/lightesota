export default {
  name: "Warm to White Sweep",
  description: "The strips turn from warm to white one pixel at a time, running around the room, then sweep back. The washes hold the warm glow.",
  tags: ["strip", "warm", "calm", "flow"],
  params: {
    warm: { type: "color", default: "#ff9a3c", label: "Warm color" },
    white: { type: "color", default: "#ffffff", label: "Sweep color" },
    passSec: { type: "number", default: 25, min: 5, max: 120, step: 1, unit: "s", label: "Seconds per pass (all strips)", group: "Timing" },
    mode: { type: "select", default: "back and forth", options: ["back and forth", "restart"], label: "At the end", group: "Timing" },
    edge: { type: "number", default: 1, min: 0.2, max: 4, step: 0.1, label: "Edge softness (pixels)" },
    washLevel: { type: "number", default: 0.8, min: 0, max: 1, step: 0.01, label: "Wash level" },
    spots: { type: "number", default: 0.3, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    const warm = hex(p.warm), white = hex(p.white);
    const n = Math.max(1, ctx.strips.length);
    // Front position in pixels along the ring: 0 -> n over one pass.
    const t = ctx.t / p.passSec;
    let front, toWhite = true;
    if (p.mode === "restart") front = fract(t) * (n + p.edge);
    else { const u = fract(t / 2) * 2; toWhite = u < 1; front = (toWhite ? u : 2 - u) * (n + p.edge) - (toWhite ? 0 : p.edge); }
    for (const f of ctx.strips) {
      const i = f.u * (n - 1);
      const k = clamp01((front - i) / p.edge);        // 1 behind the front, 0 ahead of it
      ctx.set(f, mix(warm, white, k));
    }
    for (const f of ctx.fixtures) {
      if (f.u !== undefined) continue;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, warm, { dim: p.washLevel });
    }
  },
};
