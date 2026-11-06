import type { Rig, Settings } from "../../shared/src/index.js";

/** The office rig as wired on 2026-11-05 (washes in 12CH at 101/113/125/137). */
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
  return {
    room: {
      name: "Office",
      width: 10,
      height: 8,
      gridStep: 0.5,
      shapes: [
        { id: "network", kind: "rect", x: 3.5, y: 0.3, w: 3, h: 1.2, text: "Network", color: "#8884" },
        { id: "balcony", kind: "rect", x: 0, y: 7.55, w: 10, h: 0.45, text: "Balcony", color: "#8883" },
      ],
    },
    fixtures: [
      wash(1, 101, 1.0, 1.0, ["left", "front"]),
      wash(2, 113, 9.0, 1.0, ["right", "front"]),
      wash(3, 125, 1.0, 7.0, ["left", "back"]),
      wash(4, 137, 9.0, 7.0, ["right", "back"]),
      spot(1, 29, 4.0, 4.0, ["left", "center"]),
      spot(2, 30, 6.0, 4.0, ["right", "center"]),
    ],
    customProfiles: [],
    protectedRanges: [
      { universe: 0, from: 31, to: 40, reason: "Laser 1 (operator only)" },
      { universe: 0, from: 41, to: 50, reason: "Laser 2 (operator only)" },
      { universe: 0, from: 51, to: 52, reason: "Hazer (no software control)" },
    ],
  };
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
    agent: { model: "claude-opus-5-5", effort: "medium", allowApply: true },
    sharing: { guestPermission: "control", publicUrl: "", venueName: "Office" },
    previewFps: 20,
  };
}
