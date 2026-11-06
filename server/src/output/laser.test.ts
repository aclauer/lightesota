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

test("every look at every time and beat stays inside the approved vocabulary", async () => {
  const { LASER_LOOKS, sanitizeLaserState: san } = await import("../../../shared/src/index.js");
  for (const look of LASER_LOOKS) {
    for (let t = 0; t < 40; t += 0.37) for (let b = 0; b < 17; b += 1) for (let i = 0; i < 2; i++) {
      const s = look.at(t, b, i, 2);
      assert.deepEqual(s, san(s), `${look.id} at t=${t} beat=${b} laser ${i} produced an unapproved state`);
      const bytes = laserBytes(s, true, false);
      if (s.mode === "manual") { assert.equal(bytes[6], LASER_TILT); assert.equal(bytes[4], LASER_ZOOM); assert.equal(bytes[3], 0); assert.ok(bytes[5] >= LASER_PAN_MIN && bytes[5] <= LASER_PAN_MAX); }
    }
  }
});

test("a pattern's lasers section is compiled, tagged, and forced into the vocabulary", async () => {
  const { testPattern, compilePattern } = await import("../engine/sandbox.js");
  const src = `export default {
    name: "L", params: { c: { type: "color", default: "#ff8800" } },
    lasers(ctx) { return [{ mode: "manual", pattern: "fan", color: ctx.params.c, spread: 7 }, { mode: "sound", musicColor: "cyan" }, "nonsense"]; },
    render(ctx) { ctx.fill("#fff"); },
  };`;
  const t = testPattern(src);
  assert.equal(t.compiled.usesLasers, true);
  assert.ok(t.compiled.tags.includes("laser"));
  const { PatternInstance } = await import("../engine/sandbox.js");
  const inst = new PatternInstance(compilePattern(src), [], undefined, 1);
  inst.setLaserCount(2);
  inst.render(0.025, 120, 0);
  const out = inst.lasers()!;
  assert.equal(out[0].color, "yellow");          // #ff8800 snaps to the nearest approved color
  assert.equal(out[0].pan, LASER_PAN_MAX);       // spread 7 clamps to the top of the window
  assert.equal(out[1].mode, "music"); assert.equal(out[1].musicColor, "cyan");
  assert.equal(out[2].mode, "manual"); assert.equal(out[2].color, "green"); // a junk entry falls back to defaults
  assert.throws(() => compilePattern(`export default { name: "x", lasers: "no-such-look", render() {} };`), /unknown look/);
  const plain = testPattern(`export default { name: "p", render(ctx) { ctx.fill("#fff"); } };`);
  assert.equal(plain.compiled.usesLasers, false);
  assert.ok(!plain.compiled.tags.includes("laser"));
});

test("every built-in pattern with a lasers section compiles and its lasers() stays approved over time", async () => {
  const fs = await import("node:fs"); const path = await import("node:path");
  const { compilePattern, PatternInstance, syntheticFixtures } = await import("../engine/sandbox.js");
  const dir = path.resolve(import.meta.dirname, "../../../patterns");
  let withLasers = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
    const compiled = compilePattern(fs.readFileSync(path.join(dir, file), "utf8"));
    if (!compiled.usesLasers) continue;
    withLasers++;
    if (!compiled.laserFn) continue;
    const inst = new PatternInstance(compiled, syntheticFixtures(), undefined, 1); inst.setLaserCount(2);
    for (let i = 0; i < 60; i++) {
      inst.render(0.1, 120, i * 0.3);
      for (const s of inst.lasers()!) { assert.deepEqual(s, sanitizeLaserState(s), `${file}: unapproved laser state`); const b = laserBytes(s, true, false); if (s.mode === "manual") assert.equal(b[6], LASER_TILT); }
      assert.equal(inst.laserError, null, `${file}: ${inst.laserError}`);
    }
  }
  assert.ok(withLasers >= 8, `expected several built-ins with lasers, found ${withLasers}`);
});
