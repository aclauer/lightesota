export default {
  name: "Strobe",
  description: "Beat-locked strobe using the fixtures' own strobe channel where available, or hard on/off.",
  tags: ["party", "beat", "intense"],
  params: {
    color: { type: "color", default: "#ffffff", label: "Color" },
    rate: { type: "number", default: 0.6, min: 0.05, max: 1, step: 0.01, label: "Strobe speed (fixture strobe channel)" },
    useChannel: { type: "boolean", default: true, label: "Use fixture strobe channel" },
    flashesPerBeat: { type: "select", default: "4", options: ["1", "2", "4", "8"], label: "Flashes per beat (software strobe)", group: "Timing" },
    duty: { type: "number", default: 0.3, min: 0.05, max: 0.9, step: 0.01, label: "Flash length", group: "Timing" },
    gate: { type: "select", default: "always", options: ["always", "beats 1-2 only", "every other bar"], label: "Gate" },
    spots: { type: "boolean", default: true, label: "Pinspots too" },
  },
  render(ctx) {
    const p = ctx.params;
    const beatInBar = ctx.beat % 4;
    const barIdx = Math.floor(ctx.bar);
    const open = p.gate === "always" || (p.gate === "beats 1-2 only" && beatInBar < 2) || (p.gate === "every other bar" && barIdx % 2 === 0);
    const sw = square(ctx.beat * Number(p.flashesPerBeat), p.duty);
    for (const f of ctx.fixtures) {
      if (!open) { ctx.set(f, [0, 0, 0], { dim: 0 }); continue; }
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: p.spots ? sw : 0 });
      else if (p.useChannel) ctx.set(f, p.color, { dim: 1, strobe: p.rate });
      else ctx.set(f, p.color, { dim: sw });
    }
  },
};
