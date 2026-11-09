export default {
  name: "Color Cycle",
  description: "All fixtures step or glide through a palette together, once per N beats.",
  tags: ["color", "beat"],
  // Lasers: the nearest approved color to the palette entry the washes are on, as a wave.
  lasers(ctx) {
    const p = ctx.params;
    const idx = Math.floor(ctx.beat / p.beatsPerColor);
    return [0, 1].map((i) => ({ mode: "manual", pattern: "wave", color: p.palette[(idx + i * Math.round(p.offset * 2)) % p.palette.length], spread: 0.5 }));
  },
  params: {
    palette: { type: "palette", default: PALETTES.candy, label: "Palette" },
    beatsPerColor: { type: "number", default: 2, min: 0.25, max: 16, step: 0.25, label: "Beats per color", group: "Timing" },
    glide: { type: "boolean", default: true, label: "Glide between colors" },
    offset: { type: "number", default: 0, min: 0, max: 1, step: 0.01, label: "Offset by position" },
    spots: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
    stripSpan: { type: "number", default: 1, min: 0, max: 3, step: 0.1, label: "Colors across the strips" },
  },
  render(ctx) {
    const p = ctx.params;
    const base = ctx.beat / p.beatsPerColor / p.palette.length;
    for (const f of ctx.fixtures) {
      if (f.u !== undefined) continue; // strips are painted below
      let t = base + f.nx * p.offset;
      if (!p.glide) t = Math.floor(t * p.palette.length) / p.palette.length;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, paletteAt(p.palette, t));
    }
    // Strips: the current color ramps into the next one across the whole stretch, so the bar
    // visibly changes color end to end as the cycle advances.
    for (const f of ctx.strips) {
      const t = base + (f.u * p.stripSpan) / p.palette.length;
      ctx.set(f, paletteAt(p.palette, p.glide ? t : Math.floor(t * p.palette.length) / p.palette.length));
    }
  },
};
