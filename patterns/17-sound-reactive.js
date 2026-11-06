export default {
  name: "Sound Reactive",
  description: "Follows a microphone: bass drives the washes, onsets flash the pinspots. Falls back to the beat clock when nobody streams audio.",
  tags: ["audio", "party", "beat"],
  params: {
    palette: { type: "palette", default: ["#ff2d55", "#ff9500", "#ffd60a", "#30d158", "#0a84ff", "#bf5af2"], label: "Palette" },
    gain: { type: "number", default: 1.5, min: 0.2, max: 5, step: 0.1, label: "Gain" },
    floor: { type: "number", default: 0.08, min: 0, max: 1, step: 0.01, label: "Floor level" },
    colorMode: { type: "select", default: "onset", options: ["onset", "level", "highs"], label: "Color changes with" },
    flashDecay: { type: "number", default: 8, min: 1, max: 20, step: 0.5, label: "Onset flash decay" },
    spotsFollow: { type: "select", default: "onsets", options: ["onsets", "highs", "level"], label: "Pinspots follow" },
  },
  init(ctx) { ctx.state.flash = 0; ctx.state.colorIdx = 0; ctx.state.levelSmooth = 0; },
  render(ctx) {
    const p = ctx.params, s = ctx.state, a = ctx.audio;
    const live = a.active;
    // Fallbacks keep the look alive without a microphone.
    const level = live ? clamp01(a.level * p.gain) : 0.3 + 0.3 * tri(ctx.beat / 2);
    const bass = live ? clamp01(a.bass * p.gain) : Math.exp(-ctx.beatPhase * 6);
    const high = live ? clamp01(a.high * p.gain) : 0.2 + 0.2 * noise(ctx.t * 3);
    const onset = live ? a.onset : ctx.onBeat;
    s.flash = Math.max(0, s.flash - s.flash * p.flashDecay * ctx.dt);
    if (onset) { s.flash = 1; if (p.colorMode === "onset") s.colorIdx++; }
    s.levelSmooth = lerp(s.levelSmooth, level, 1 - Math.exp(-ctx.dt * 12));
    const t = p.colorMode === "level" ? s.levelSmooth : p.colorMode === "highs" ? high : s.colorIdx / p.palette.length;
    for (const f of ctx.fixtures) {
      if (f.kind === "spot") {
        const v = p.spotsFollow === "onsets" ? s.flash : p.spotsFollow === "highs" ? high : s.levelSmooth;
        ctx.set(f, [1, 1, 1], { dim: v });
      } else {
        const col = paletteAt(p.palette, t + f.nx * 0.15);
        const dim = p.floor + (1 - p.floor) * clamp01(0.6 * bass + 0.4 * s.levelSmooth + 0.3 * s.flash);
        ctx.set(f, col, { dim });
      }
    }
  },
};
