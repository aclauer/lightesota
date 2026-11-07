export default {
  name: "Color Wipe",
  description: "Every bar the whole balcony stretch wipes to the next palette color from one end to the other; the washes follow a beat later.",
  tags: ["strip", "color", "beat"],
  params: {
    palette: { type: "palette", default: ["#ff0040", "#ff8a00", "#ffee00", "#00e676", "#00b0ff", "#d500f9"], label: "Palette" },
    barsPerColor: { type: "number", default: 1, min: 0.5, max: 8, step: 0.5, label: "Bars per color", group: "Timing" },
    wipeBeats: { type: "number", default: 2, min: 0.5, max: 4, step: 0.5, label: "Wipe duration (beats)", group: "Timing" },
    direction: { type: "select", default: "alternate", options: ["left to right", "right to left", "alternate"], label: "Direction" },
    washDelayBeats: { type: "number", default: 1, min: 0, max: 4, step: 0.5, label: "Wash delay (beats)" },
    washLevel: { type: "number", default: 0.7, min: 0, max: 1, step: 0.01, label: "Wash level" },
  },
  render(ctx) {
    const p = ctx.params;
    const strips = ctx.byTag("strip").sort((a, b) => a.x - b.x);
    const n = Math.max(1, strips.length);
    const period = p.barsPerColor * 4;             // beats per color
    const idx = Math.floor(ctx.beat / period);
    const into = ctx.beat - idx * period;          // beats into this color
    const cur = hex(p.palette[idx % p.palette.length]);
    const prev = hex(p.palette[(idx + p.palette.length - 1) % p.palette.length]);
    const ltr = p.direction === "left to right" || (p.direction === "alternate" && idx % 2 === 0);
    strips.forEach((f, i) => {
      const pos = n === 1 ? 0 : (ltr ? i : n - 1 - i) / (n - 1);
      const edge = (into / p.wipeBeats) * (1 + 0.5) - pos;  // wipe front sweeps past each strip in turn
      const k = clamp01(edge * 2);
      ctx.set(f, mix(prev, cur, k));
    });
    const washK = clamp01((into - p.washDelayBeats) / Math.max(0.1, p.wipeBeats));
    for (const f of ctx.fixtures) {
      if (f.tags.includes("strip")) continue;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: 0.15 });
      else ctx.set(f, mix(prev, cur, washK), { dim: p.washLevel });
    }
  },
};
