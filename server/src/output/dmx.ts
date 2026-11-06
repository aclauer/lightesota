import { findProfile, type Fixture, type ProtectedRange, type Rig, type WashState } from "../../../shared/src/index.js";
import { OUT_STRIDE } from "../engine/sandbox.js";

export interface DmxPlan {
  universe: number;
  /** channel index (0-based) -> true if some enabled fixture owns it */
  owned: Uint8Array;
  /** channel index -> true if protected (never written by us) */
  protectedMask: Uint8Array;
  /** Fixtures we skip because they overlap a protected range (reported to the UI). */
  blocked: { fixtureId: string; reason: string }[];
  conflicts: { a: string; b: string; channel: number }[];
}

export function planUniverse(rig: Rig, universe: number): DmxPlan {
  const owned = new Uint8Array(512);
  const protectedMask = new Uint8Array(512);
  const owner = new Array<string | null>(512).fill(null);
  const blocked: DmxPlan["blocked"] = [];
  const conflicts: DmxPlan["conflicts"] = [];
  protectedMask[50] = 1; protectedMask[51] = 1; // Haze commissioning gate is false in this release.
  for (const r of rig.protectedRanges) {
    if (r.universe !== universe) continue;
    for (let c = r.from; c <= r.to; c++) if (c >= 1 && c <= 512) protectedMask[c - 1] = 1;
  }
  for (const f of rig.fixtures) {
    if (!f.enabled) continue;
    const p = findProfile(f.profileId, rig.customProfiles);
    if (!p || p.transport !== "dmx" || (f.universe ?? 0) !== universe || !f.address) continue;
    const start = f.address - 1, end = start + p.channels.length;
    const laser = p.id === "chauvet-scorpion-dual-rgb-ils-10ch";
    if ((!laser && start < 52 && end > 30) || (laser && ![31, 41].includes(f.address))) {
      blocked.push({ fixtureId: f.id, reason: "reserved guarded laser / uncommissioned haze channels" }); continue;
    }
    let hitProtected: ProtectedRange | undefined;
    for (let c = start; c < end && c < 512; c++) {
      if (protectedMask[c]) hitProtected = rig.protectedRanges.find((r) => r.universe === universe && c + 1 >= r.from && c + 1 <= r.to);
    }
    if (hitProtected) { blocked.push({ fixtureId: f.id, reason: `overlaps protected channels ${hitProtected.from}-${hitProtected.to} (${hitProtected.reason})` }); continue; }
    for (let c = start; c < end && c < 512; c++) {
      if (owner[c] && owner[c] !== f.id) conflicts.push({ a: owner[c]!, b: f.id, channel: c + 1 });
      owner[c] = f.id;
      owned[c] = 1;
    }
  }
  return { universe, owned, protectedMask, blocked, conflicts };
}

/**
 * Write fixture values into a 512-byte universe buffer. Channels not owned by our fixtures
 * are left untouched (OutputManager initializes them to zero). Protected channels are never written.
 */
export function renderUniverse(
  rig: Rig, fixtures: Fixture[], values: Float32Array, universe: number, plan: DmxPlan, out: Uint8Array,
  washes: Record<string, WashState> = {},
) {
  const blocked = new Set(plan.blocked.map((b) => b.fixtureId));
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    if (!f.enabled || (f.universe ?? 0) !== universe || !f.address || blocked.has(f.id)) continue;
    const p = findProfile(f.profileId, rig.customProfiles);
    if (!p || p.transport !== "dmx" || p.kind === "laser") continue;
    const o = i * OUT_STRIDE;
    const r = values[o], g = values[o + 1], b = values[o + 2], w = values[o + 3], a = values[o + 4], uv = values[o + 5];
    const dim = values[o + 6], strobe = values[o + 7];
    const hasDimmer = p.channels.some((c) => c.fn === "dimmer");
    const k = hasDimmer ? 1 : dim; // without a dimmer channel, intensity scales the colors
    const isDimmerOnly = p.colorModel === "dimmer";
    // Intensity-only fixtures take the brightness of the color.
    const inten = isDimmerOnly ? Math.max(r, g, b, w) * dim : dim;
    for (let c = 0; c < p.channels.length; c++) {
      const ch = f.address - 1 + c;
      if (ch < 0 || ch >= 512 || plan.protectedMask[ch]) continue;
      const def = p.channels[c];
      let v = 0;
      switch (def.fn) {
        case "dimmer": v = inten; break;
        case "red": v = r * k; break;
        case "green": v = g * k; break;
        case "blue": v = b * k; break;
        case "white": v = w * k; break;
        case "amber": v = a * k; break;
        case "uv": v = uv * k; break;
        case "strobe": {
          if (strobe <= 0 || dim <= 0) { out[ch] = def.off ?? 0; continue; }
          const [lo, hi] = def.range ?? [11, 255];
          out[ch] = Math.round(lo + (hi - lo) * Math.min(1, strobe));
          continue;
        }
        case "fixed": out[ch] = def.value ?? 0; continue;
      }
      out[ch] = Math.round(Math.max(0, Math.min(1, v)) * 255);
    }
    const wash = washes[f.id];
    if (p.id === "chauvet-slimpar-pro-h-12ch" && wash && wash.owner !== "pattern") {
      const start = f.address - 1;
      if (wash.mode === "off" || dim <= 0) { out.fill(0, start, start + 12); continue; }
      // Control bytes are selected atomically after color fades; never interpolated or HTP merged.
      out[start + 7] = 0; out[start + 8] = 0;
      out[start + 9] = wash.mode === "music6" ? 224 : wash.mode === "music32" ? 250 : 0;
      out[start + 10] = wash.sensitivity; out[start + 11] = 52;
    }
  }
}
