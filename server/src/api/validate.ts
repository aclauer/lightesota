import { findProfile, type Fixture, type Rig } from "../../../shared/src/index.js";

/** Shape-check a rig coming from a client. Keeps protected ranges from being removed silently. */
export function validateRig(input: Rig): Rig {
  if (!input || typeof input !== "object") throw new Error("rig must be an object");
  const room = input.room ?? ({} as Rig["room"]);
  const rig: Rig = {
    room: {
      name: String(room.name ?? "Room").slice(0, 40),
      width: clampNum(room.width, 1, 200, 10),
      height: clampNum(room.height, 1, 200, 8),
      gridStep: clampNum(room.gridStep, 0.1, 10, 0.5),
      shapes: Array.isArray(room.shapes) ? room.shapes.slice(0, 200) : [],
    },
    fixtures: [],
    customProfiles: Array.isArray(input.customProfiles) ? input.customProfiles : [],
    protectedRanges: Array.isArray(input.protectedRanges) ? input.protectedRanges.map((r) => ({
      universe: clampNum(r.universe, 0, 32767, 0), from: clampNum(r.from, 1, 512, 1), to: clampNum(r.to, 1, 512, 1), reason: String(r.reason ?? "").slice(0, 80),
    })) : [],
  };
  const ids = new Set<string>();
  for (const f of Array.isArray(input.fixtures) ? input.fixtures : []) {
    if (!f || typeof f.id !== "string" || !f.id) continue;
    if (ids.has(f.id)) throw new Error(`Duplicate fixture id ${f.id}`);
    ids.add(f.id);
    const profile = findProfile(f.profileId, rig.customProfiles);
    if (!profile) throw new Error(`Fixture ${f.name ?? f.id}: unknown profile ${f.profileId}`);
    const fx: Fixture = {
      id: f.id.slice(0, 32),
      name: String(f.name ?? f.id).slice(0, 40),
      profileId: f.profileId,
      universe: profile.transport === "dmx" ? clampNum(f.universe, 0, 32767, 0) : undefined,
      address: profile.transport === "dmx" ? clampNum(f.address, 1, 512, 1) : undefined,
      hueLightId: profile.transport === "hue" ? (f.hueLightId ? String(f.hueLightId) : undefined) : undefined,
      x: clampNum(f.x, -1000, 1000, 0), y: clampNum(f.y, -1000, 1000, 0), rotation: clampNum(f.rotation, -360, 360, 0),
      tags: Array.isArray(f.tags) ? f.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 12) : [],
      enabled: f.enabled !== false,
      trim: f.trim === undefined ? undefined : clampNum(f.trim, 0, 1, 1),
    };
    if (fx.address && fx.address + profile.channels.length - 1 > 512) throw new Error(`Fixture ${fx.name}: address ${fx.address} does not fit in the universe`);
    rig.fixtures.push(fx);
  }
  return rig;
}

function clampNum(v: unknown, lo: number, hi: number, dflt: number) {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}
