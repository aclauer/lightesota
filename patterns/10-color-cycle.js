export default {
  name: "Color Cycle",
  description: "All fixtures step or glide through a palette together, once per N beats.",
  tags: ["color", "beat"],
  params: {
    palette: { type: "palette", default: PALETTES.candy, label: "Palette" },
    beatsPerColor: { type: "number", default: 2, min: 0.25, max: 16, step: 0.25, label: "Beats per color", group: "Timing" },
    glide: { type: "boolean", default: true, label: "Glide between colors" },
    offset: { type: "number", default: 0, min: 0, max: 1, step: 0.01, label: "Offset by position" },
    spots: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Pinspot level" },
  },
  render(ctx) {
    const p = ctx.params;
    const base = ctx.beat / p.beatsPerColor / p.palette.length;
    for (const f of ctx.fixtures) {
      let t = base + f.nx * p.offset;
      if (!p.glide) t = Math.floor(t * p.palette.length) / p.palette.length;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots });
      else ctx.set(f, paletteAt(p.palette, t));
    }
  },
};
