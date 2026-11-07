export default {
  name: "Sparkle Break",
  description: "A calm colored base, then every few bars the balcony strips and washes break into a short white-and-color sparkle before settling back.",
  tags: ["strip", "party", "beat", "ambient"],
  params: {
    palette: { type: "palette", default: ["#2b0f6a", "#4b1fd1", "#0b6cff"], label: "Base palette" },
    everyBars: { type: "number", default: 4, min: 1, max: 16, step: 1, label: "Sparkle every N bars", group: "Timing" },
    burstBeats: { type: "number", default: 4, min: 1, max: 16, step: 1, label: "Sparkle length (beats)", group: "Timing" },
    density: { type: "number", default: 0.6, min: 0.1, max: 1, step: 0.05, label: "Sparkle density" },
    sparkleColor: { type: "color", default: "#ffffff", label: "Sparkle color" },
    rate: { type: "number", default: 3, min: 1, max: 6, step: 1, label: "Twinkles per second (Hue is rate limited)" },
    baseLevel: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Base level" },
  },
  init(ctx) { ctx.state.seed = 0; ctx.state.lastSlot = -1; ctx.state.twinkle = []; },
  render(ctx) {
    const p = ctx.params, s = ctx.state;
    // The burst is the last `burstBeats` beats of every `everyBars` bars.
    const cycleBeats = p.everyBars * 4;
    const beatInCycle = ((ctx.beat % cycleBeats) + cycleBeats) % cycleBeats;
    const inBurst = beatInCycle >= cycleBeats - Math.min(cycleBeats, p.burstBeats);
    const base = paletteAt(p.palette, ctx.beat / 16);
    // Twinkle values change on a slow clock so the Hue bridge can keep up.
    const slot = Math.floor(ctx.t * p.rate);
    if (slot !== s.lastSlot) { s.lastSlot = slot; s.twinkle = ctx.fixtures.map(() => (ctx.random() < p.density ? ctx.random() : 0)); }
    for (const f of ctx.fixtures) {
      const tw = s.twinkle[f.index] ?? 0;
      if (inBurst && tw > 0) {
        const col = tw > 0.66 ? hex(p.sparkleColor) : hsv(ctx.random(), 0.6, 1);
        ctx.set(f, col, { dim: f.kind === "spot" ? tw : 1 });
      } else if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: 0.1 });
      else ctx.set(f, base, { dim: p.baseLevel });
    }
  },
};
