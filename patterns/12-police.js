export default {
  name: "Red / Blue",
  description: "Two colors alternate between the left and right halves of the room.",
  tags: ["beat", "intense"],
  // Lasers: color A on one laser, color B on the other, swapping with the washes.
  lasers(ctx) {
    const p = ctx.params;
    const swap = Math.floor(ctx.beat * p.perBeat) % 2 === 0;
    return [{ mode: "manual", pattern: "fan", color: swap ? p.colorA : p.colorB, spread: 0.7 }, { mode: "manual", pattern: "fan", color: swap ? p.colorB : p.colorA, spread: 0.7 }];
  },
  params: {
    colorA: { type: "color", default: "#ff1a1a", label: "Color A" },
    colorB: { type: "color", default: "#1a4dff", label: "Color B" },
    perBeat: { type: "number", default: 2, min: 0.5, max: 8, step: 0.5, label: "Swaps per beat", group: "Timing" },
    split: { type: "select", default: "left/right", options: ["left/right", "front/back", "alternate"], label: "Split" },
    flashDuty: { type: "number", default: 0.6, min: 0.1, max: 1, step: 0.05, label: "Flash length" },
  },
  render(ctx) {
    const p = ctx.params;
    const phase = ctx.beat * p.perBeat;
    const sideA = Math.floor(phase) % 2 === 0;
    const on = fract(phase) < p.flashDuty;
    for (const f of ctx.fixtures) {
      const group = p.split === "left/right" ? f.nx < 0.5 : p.split === "front/back" ? f.ny < 0.5 : f.index % 2 === 0;
      const lit = on && group === sideA;
      if (f.kind === "spot") ctx.set(f, [1, 1, 1], { dim: lit ? 1 : 0 });
      else ctx.set(f, group ? p.colorA : p.colorB, { dim: lit ? 1 : 0 });
    }
  },
};
