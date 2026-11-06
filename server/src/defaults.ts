import type { Rig, Settings } from "../../shared/src/index.js";

/** The office rig as wired on 2026-11-05 (washes in 12CH at 101/113/125/137, lasers at 31/41). */
export function defaultRig(): Rig {
  const wash = (n: number, address: number, x: number, y: number, tags: string[]) => ({
    id: `w${n}`, name: `Wash ${n}`, profileId: "chauvet-slimpar-pro-h-12ch",
    universe: 0, address, x, y, rotation: 0, tags: ["wash", ...tags], enabled: true,
  });
  // The pinspots are addressed (29/30) but not yet on the DMX chain, so they start disabled.
  const spot = (n: number, address: number, x: number, y: number, tags: string[]) => ({
    id: `s${n}`, name: `Spot ${n}`, profileId: "chauvet-saber-spot-ww-1ch",
    universe: 0, address, x, y, rotation: 0, tags: ["spot", ...tags], enabled: false,
  });
  // Scorpion Dual lasers on the Port 1 chain. Enabled means "addressable"; they emit nothing
  // until an admin arms them on the Live tab (see shared/src/laser.ts).
  const laser = (n: number, address: number, x: number, y: number, tags: string[]) => ({
    id: `l${n}`, name: `Laser ${n}`, profileId: "chauvet-scorpion-dual-rgb-ils-10ch",
    universe: 0, address, x, y, rotation: 0, tags: ["laser", ...tags], enabled: true,
  });
  return {
    room: {
      name: "Office",
      width: 10,
      height: 8,
      gridStep: 0.5,
      shapes: [
        { id: "network", kind: "rect", x: 4.25, y: 0.3, w: 1.5, h: 0.6, text: "Network", color: "#8884" },
        { id: "balcony", kind: "rect", x: 0, y: 7.55, w: 10, h: 0.45, text: "Balcony", color: "#8883" },
      ],
    },
    fixtures: [
      wash(1, 101, 1.0, 1.0, ["left", "front"]),
      wash(2, 113, 1.0, 7.0, ["left", "back"]),
      wash(3, 125, 9.0, 1.0, ["right", "front"]),
      wash(4, 137, 9.0, 7.0, ["right", "back"]),
      spot(1, 29, 4.0, 4.0, ["left", "center"]),
      spot(2, 30, 6.0, 4.0, ["right", "center"]),
      laser(1, 31, 3.5, 0.6, ["left", "front"]),
      laser(2, 41, 6.5, 0.6, ["right", "front"]),
      { id: "h1", name: "Hazer", profileId: "chauvet-hurricane-haze-4d-2ch", universe: 0, address: 51, x: 9.2, y: 4.0, rotation: 0, tags: ["haze"], enabled: false },
    ],
    customProfiles: [],
    protectedRanges: [{ universe: 0, from: 51, to: 52, reason: "Hazer uncommissioned" }],
  };
}

/**
 * One-time migration for rigs saved before the lasers were commissioned: the two laser ranges
 * were protected and there were no laser fixtures. Turns each range into a laser fixture.
 */
export function migrateRig(input: Rig): { rig: Rig; changed: boolean } {
  let rig = input, changed = false;
  // Add the fixed haze profile as disabled future capability; retain every saved protection.
  const hazeRange = rig.protectedRanges.find((r) => /haze/i.test(r.reason) && r.from === 51 && r.to === 52);
  if (hazeRange && !rig.fixtures.some((f) => f.id === "h1" || f.profileId === "chauvet-hurricane-haze-4d-2ch")) {
    rig = {
      ...rig,
      fixtures: [...rig.fixtures, { id: "h1", name: "Hazer", profileId: "chauvet-hurricane-haze-4d-2ch", universe: hazeRange.universe, address: hazeRange.from, x: 9.2, y: 4.0, rotation: 0, tags: ["haze"], enabled: false }],
    };
    changed = true;
  }
  // Only unmistakable original metadata; saved positions and custom tags remain untouched.
  rig = { ...rig, fixtures: rig.fixtures.map((f) => {
    const old = f.id === "w2" && f.address === 113 ? ["wash", "right", "front"] : f.id === "w3" && f.address === 125 ? ["wash", "left", "back"] : null;
    if (f.profileId !== "chauvet-slimpar-pro-h-12ch" || !old || JSON.stringify(f.tags) !== JSON.stringify(old)) return f;
    changed = true;
    return { ...f, tags: f.tags.map((tag) => tag === "left" || tag === "right" ? (f.id === "w2" ? "left" : "right") : tag) };
  }) };
  const hasLaser = rig.fixtures.some((f) => f.profileId === "chauvet-scorpion-dual-rgb-ils-10ch");
  const laserRanges = rig.protectedRanges.filter((r) => /laser/i.test(r.reason) && r.to - r.from === 9);
  if (hasLaser || laserRanges.length === 0) return { rig, changed: changed };
  const def = defaultRig();
  const fixtures = [...rig.fixtures];
  for (const [i, r] of laserRanges.entries()) {
    const n = i + 1;
    const d = def.fixtures.find((f) => f.id === `l${n}`);
    fixtures.push({
      id: `l${n}`, name: `Laser ${n}`, profileId: "chauvet-scorpion-dual-rgb-ils-10ch",
      universe: r.universe, address: r.from, x: d?.x ?? 3 * n, y: d?.y ?? 0.6, rotation: 0, tags: ["laser"], enabled: true,
    });
  }
  return { rig: { ...rig, fixtures, protectedRanges: rig.protectedRanges.filter((r) => !laserRanges.includes(r)) }, changed: true };
}

export function defaultSettings(): Settings {
  return {
    artnet: {
      enabled: true,
      host: "10.10.0.204",
      port: 6454,
      universe: 0,
      fps: 40,
      upstream: { enabled: false, listenPort: 6454, allowFrom: "" },
    },
    hue: { enabled: false, bridgeIp: "10.10.0.103", username: "", rateHz: 8 },
    agent: { model: "claude-sonnet-5-5", effort: "medium", allowApply: true, guestAccess: true, guestIntervalSec: 30, guestTotalPerHour: 60 },
    sharing: { guestPermission: "control", publicUrl: "", venueName: "Office" },
    previewFps: 20,
  };
}
