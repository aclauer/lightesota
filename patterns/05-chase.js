export default {
  name: "Chase",
  description: "One fixture lights at a time in room order, with a fading trail.",
  tags: ["beat", "movement"],
  // Lasers: the chase continues onto the lasers, one lit per step in the pattern color.
  lasers(ctx) {
    const step = Math.floor(ctx.beat * ctx.params.perBeat);
    return [0, 1].map((i) => (step % 2 === i ? { mode: "manual", pattern: "fan", color: ctx.params.color, spread: 0.4 } : null));
  },
  params: {
    color: { type: "color", default: "#00e5ff", label: "Color" },
    perBeat: { type: "number", default: 1, min: 0.25, max: 4, step: 0.25, label: "Steps per beat", group: "Timing" },
    order: { type: "select", default: "x", options: ["x", "y", "clockwise", "rig order"], label: "Order" },
    trail: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Trail length" },
    bounce: { type: "boolean", default: false, label: "Bounce back and forth" },
    includeSpots: { type: "boolean", default: true, label: "Include pinspots" },
    background: { type: "color", default: "#000000", label: "Background color" },
  },
  init(ctx) { ctx.state.order = null; },
  render(ctx) {
    const p = ctx.params;
    const list = ctx.fixtures.filter((f) => p.includeSpots || f.kind !== "spot");
    const key = (f) => p.order === "x" ? f.nx * 100 + f.ny : p.order === "y" ? f.ny * 100 + f.nx : p.order === "clockwise" ? f.angle : f.index;
    const sorted = [...list].sort((a, b) => key(a) - key(b));
    const n = sorted.length;
    if (n === 0) return;
    let pos = ctx.beat * p.perBeat;
    const cycle = p.bounce ? Math.max(1, (n - 1) * 2) : n;
    pos = pos % cycle;
    if (p.bounce && pos > n - 1) pos = cycle - pos;
    const bg = hex(p.background);
    sorted.forEach((f, i) => {
      let d = Math.abs(i - pos);
      if (!p.bounce) d = Math.min(d, n - d);
      const v = Math.max(0, 1 - d / (0.5 + p.trail * n * 0.5));
      const level = Math.pow(v, 2);
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: level });
      else ctx.set(f, mix(bg, hex(p.color), level), { dim: Math.max(level, luminance(bg) > 0 ? 1 : 0) });
    });
    for (const f of ctx.fixtures) if (!list.includes(f)) ctx.set(f, bg, { dim: 0 });
  },
};
