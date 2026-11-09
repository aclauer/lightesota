export default {
  name: "Party Mode",
  description: "Palette hits on every beat; an optional strobe burst on bar 4 is off by default.",
  tags: ["party", "beat"],
  // Lasers: fans snapping to the palette color of the beat, spread flipping tight/wide every bar.
  lasers(ctx) {
    const p = ctx.params;
    const beatIdx = Math.floor(ctx.beat);
    const wide = Math.floor(ctx.bar) % 2 === 0;
    return [0, 1].map((i) => ({ mode: "manual", pattern: "fan", color: p.palette[(beatIdx + i) % p.palette.length], spread: wide ? 1 : 0.2 }));
  },
  params: {
    palette: { type: "palette", default: PALETTES.neon, label: "Palette" },
    decay: { type: "number", default: 5, min: 1, max: 20, step: 0.5, label: "Hit decay", group: "Timing" },
    movement: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Movement across room" },
    burst: { type: "boolean", default: false, label: "Strobe burst on every 4th bar (opt in)" },
    floor: { type: "number", default: 0.1, min: 0, max: 1, step: 0.01, label: "Floor level" },
  },
  render(ctx) {
    const p = ctx.params;
    const beatIdx = Math.floor(ctx.beat);
    const env = Math.exp(-ctx.beatPhase * p.decay);
    const burst = p.burst && Math.floor(ctx.bar) % 4 === 3 && ctx.beat % 4 >= 3;
    // Strips: the palette slides along the stretch one color per beat, with the strobe burst running white.
    for (const f of ctx.strips) {
      const col = burst ? [1, 1, 1] : paletteAt(p.palette, (beatIdx + f.u * p.movement * 3) / p.palette.length);
      ctx.set(f, col, { dim: burst ? 1 : p.floor + (1 - p.floor) * env });
    }
    for (const f of ctx.fixtures) {
      if (f.u !== undefined) continue;
      const shift = Math.floor(f.nx * 3 * p.movement);
      const col = hex(p.palette[(beatIdx + shift) % p.palette.length]);
      if (f.kind === "spot") {
        const off = Math.exp(-((ctx.beat + 0.5) % 1) * p.decay);
        const mine = (beatIdx + (f.nx < 0.5 ? 0 : 1)) % 2 === 0;
        ctx.set(f, [1, 1, 1], { dim: mine ? off : 0 });
      } else ctx.set(f, burst ? [1, 1, 1] : col, { dim: burst ? 1 : p.floor + (1 - p.floor) * env, strobe: burst ? 0.8 : 0 });
    }
  },
};
