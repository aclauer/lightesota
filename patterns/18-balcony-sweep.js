export default {
  name: "Balcony Sweep",
  description: "A band of color travels along the balcony strips end to end, as if they were one long bar, while the washes drift through the same palette.",
  tags: ["strip", "flow", "color", "beat"],
  params: {
    palette: { type: "palette", default: ["#1a2bff", "#00d4ff", "#ff2bd6", "#ff8a00"], label: "Palette" },
    beatsPerSweep: { type: "number", default: 8, min: 1, max: 32, step: 1, label: "Beats per sweep", group: "Timing" },
    bandWidth: { type: "number", default: 0.45, min: 0.1, max: 1, step: 0.05, label: "Band width (share of the stretch)" },
    highlight: { type: "color", default: "#ffffff", label: "Band color (travelling)" },
    highlightMix: { type: "number", default: 0.7, min: 0, max: 1, step: 0.05, label: "Band strength" },
    washLevel: { type: "number", default: 0.6, min: 0, max: 1, step: 0.01, label: "Wash level" },
    spots: { type: "number", default: 0.2, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    const strips = ctx.byTag("strip").sort((a, b) => a.x - b.x);
    const n = Math.max(1, strips.length);
    const t = ctx.beat / p.beatsPerSweep;              // sweeps per beat window
    const base = paletteAt(p.palette, t * 0.25);        // slow drift through the palette
    // Band center runs 0..1 along the stretch, with a little overshoot so it fully exits.
    const center = (fract(t) * (1 + p.bandWidth)) - p.bandWidth / 2;
    strips.forEach((f, i) => {
      const pos = n === 1 ? 0.5 : i / (n - 1);
      const d = Math.abs(pos - center) / (p.bandWidth / 2);
      const k = Math.max(0, 1 - d) * p.highlightMix;
      ctx.set(f, mix(base, hex(p.highlight), k));
    });
    for (const f of ctx.fixtures) {
      if (f.tags.includes("strip")) continue;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, paletteAt(p.palette, t * 0.25 + f.nx * 0.15), { dim: p.washLevel });
    }
  },
};
