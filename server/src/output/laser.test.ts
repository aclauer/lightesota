import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rig } from "../../../shared/src/index.js";
import {
  defaultLaserState, laserBytes, sanitizeLaserState, engineFixtures, laserFixtures,
  LASER_PAN_MAX, LASER_PAN_MIN, LASER_TILT, LASER_ZOOM,
} from "../../../shared/src/index.js";
import { migrateRig } from "../defaults.js";

const ZEROS = new Array(10).fill(0);

test("disarmed, blacked out or off lasers encode as all zeros", () => {
  const on = { ...defaultLaserState(), mode: "manual" as const };
  assert.deepEqual(laserBytes(on, false, false), ZEROS);
  assert.deepEqual(laserBytes(on, true, true), ZEROS);
  assert.deepEqual(laserBytes({ ...on, mode: "off" }, true, false), ZEROS);
  assert.deepEqual(laserBytes(undefined, true, false), ZEROS);
});

test("manual presets use only approved bytes: tilt pinned, zoom fixed, no strobe or rolling", () => {
  const s = { ...defaultLaserState(), mode: "manual" as const, pattern: "wave" as const, color: "cyan" as const, pan: 70 };
  const b = laserBytes(s, true, false);
  assert.deepEqual(b, [0, 123, 118, 0, LASER_ZOOM, 70, LASER_TILT, 0, 0, 0]);
  assert.equal(LASER_TILT, 64);
});

test("pan is clamped to the approved window even if a client sends more", () => {
  const lo = sanitizeLaserState({ pan: -500 });
  const hi = sanitizeLaserState({ pan: 999 });
  assert.equal(lo.pan, LASER_PAN_MIN);
  assert.equal(hi.pan, LASER_PAN_MAX);
  assert.equal(laserBytes({ ...lo, mode: "manual" }, true, false)[5], 48);
  assert.equal(laserBytes({ ...hi, mode: "manual" }, true, false)[5], 80);
});

test("unknown modes, colors and patterns fall back instead of reaching the laser", () => {
  const s = sanitizeLaserState({ mode: "strobe", color: "white", pattern: "spiral", musicColor: "rainbow" });
  assert.equal(s.mode, "off");
  assert.equal(s.color, "green");
  assert.equal(s.pattern, "fan");
  assert.equal(s.musicColor, "multicolor");
});

test("music mode sets only channel 1", () => {
  const b = laserBytes({ ...defaultLaserState(), mode: "music", musicColor: "red" }, true, false);
  assert.deepEqual(b, [154, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
});

test("lasers are excluded from the pattern engine and old protected ranges migrate to fixtures", () => {
  const old: Rig = {
    room: { name: "t", width: 10, height: 8, gridStep: 0.5, shapes: [] },
    customProfiles: [],
    protectedRanges: [
      { universe: 0, from: 31, to: 40, reason: "Laser 1 (operator only)" },
      { universe: 0, from: 41, to: 50, reason: "Laser 2 (operator only)" },
      { universe: 0, from: 51, to: 52, reason: "Hazer (no software control)" },
    ],
    fixtures: [{ id: "w1", name: "Wash 1", profileId: "chauvet-slimpar-pro-h-12ch", universe: 0, address: 101, x: 0, y: 0, rotation: 0, tags: [], enabled: true }],
  };
  const m = migrateRig(old);
  assert.equal(m.changed, true);
  assert.deepEqual(laserFixtures(m.rig).map((f) => [f.id, f.address]), [["l1", 31], ["l2", 41]]);
  assert.deepEqual(m.rig.protectedRanges.map((r) => r.from), [51]);
  assert.deepEqual(engineFixtures(m.rig).map((f) => f.id), ["w1"]);
  // Running it again is a no-op.
  assert.equal(migrateRig(m.rig).changed, false);
});
