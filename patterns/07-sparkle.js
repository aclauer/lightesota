export default {
  name: "Sparkle",
  description: "Random twinkles over a dim base color, like a starfield.",
  tags: ["ambient", "random"],
  params: {
    base: { type: "color", default: "#120a2e", label: "Base color" },
    sparkle: { type: "color", default: "#ffffff", label: "Sparkle color" },
    density: { type: "number", default: 1.5, min: 0, max: 10, step: 0.1, unit: "/s", label: "Sparkles per second" },
    decay: { type: "number", default: 4, min: 0.5, max: 20, step: 0.5, label: "Decay speed" },
    beatBoost: { type: "number", default: 0.5, min: 0, max: 1, step: 0.05, label: "Extra sparkles on the beat" },
  },
  init(ctx) { ctx.state.levels = []; },
  render(ctx) {
    const p = ctx.params;
    const L = ctx.state.levels;
    while (L.length < ctx.n) L.push(0);
    const rate = p.density + (ctx.onBeat ? p.beatBoost * 20 : 0);
    if (ctx.random() < rate * ctx.dt) L[Math.floor(ctx.random() * ctx.n)] = 1;
    for (let i = 0; i < ctx.n; i++) {
      L[i] = Math.max(0, L[i] - L[i] * p.decay * ctx.dt);
      const f = ctx.fixtures[i];
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: L[i] });
      else ctx.set(f, mix(hex(p.base), hex(p.sparkle), L[i]), { dim: 1 });
    }
  },
};
