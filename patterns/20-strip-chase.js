export default {
  name: "Strip Chase",
  description: "The balcony strips light one after another along the stretch on each beat, trailing off behind, while the washes answer with a soft pulse.",
  tags: ["strip", "beat", "movement"],
  params: {
    color: { type: "color", default: "#00e5ff", label: "Chase color" },
    background: { type: "color", default: "#0a0030", label: "Strip background" },
    stepsPerBeat: { type: "number", default: 1, min: 0.25, max: 4, step: 0.25, label: "Steps per beat", group: "Timing" },
    bounce: { type: "boolean", default: true, label: "Bounce back and forth" },
    trail: { type: "number", default: 0.5, min: 0, max: 1, step: 0.05, label: "Trail" },
    washPulse: { type: "number", default: 0.5, min: 0, max: 1, step: 0.01, label: "Wash pulse amount" },
    washColor: { type: "color", default: "#1a2bff", label: "Wash color" },
  },
  render(ctx) {
    const p = ctx.params;
    const strips = ctx.byTag("strip").sort((a, b) => a.x - b.x);
    const n = Math.max(1, strips.length);
    const stepF = ctx.beat * p.stepsPerBeat;
    const cycle = p.bounce ? Math.max(1, 2 * n - 2) : n;
    const raw = Math.floor(stepF) % cycle;
    const head = p.bounce && raw >= n ? cycle - raw : raw;
    const phase = fract(stepF);
    strips.forEach((f, i) => {
      const dist = Math.abs(i - head);
      const k = dist === 0 ? 1 - phase * (1 - p.trail) : dist === 1 ? p.trail * (1 - phase) : 0;
      ctx.set(f, mix(hex(p.background), hex(p.color), k));
    });
    const pulse = Math.exp(-ctx.beatPhase * 5) * p.washPulse;
    for (const f of ctx.fixtures) {
      if (f.tags.includes("strip")) continue;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: pulse * 0.6 });
      else ctx.set(f, hex(p.washColor), { dim: 0.25 + pulse });
    }
  },
};
