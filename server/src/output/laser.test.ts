import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rig } from "../../../shared/src/index.js";
import {
  defaultLaserState, laserBytes, sanitizeLaserState, engineFixtures, laserFixtures,
  LASER_PAN_MAX, LASER_PAN_MIN, LASER_TILT, LASER_ZOOM,
  laserStateFromPattern, nearestLaserColor,
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
  assert.deepEqual(m.rig.protectedRanges, [old.protectedRanges[2]], "haze protection is never cleared by migration");
  assert.equal(m.rig.fixtures.find((f) => f.id === "h1")!.enabled, false);
  assert.deepEqual(m.rig.fixtures.filter((f) => f.id === "h1").map((f) => f.address), [51]);
  assert.deepEqual(engineFixtures(m.rig).map((f) => f.id), ["w1"]);
  // Running it again is a no-op.
  assert.equal(migrateRig(m.rig).changed, false);
});

test("every look at every time and beat stays inside the approved vocabulary", async () => {
  const { LASER_LOOKS, sanitizeLaserState: san } = await import("../../../shared/src/index.js");
  for (const look of LASER_LOOKS) {
    for (let t = 0; t < 40; t += 0.37) for (let b = -2; b < 17; b += 1) for (let i = 0; i < 2; i++) {
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
  assert.equal(out[2].mode, "off"); assert.deepEqual(laserBytes(out[2], true, false), ZEROS);
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
    let emittingFrames = 0;
    for (let i = 0; i < 60; i++) {
      inst.render(0.1, 120, i * 0.3);
      for (const s of inst.lasers()!) { assert.deepEqual(s, sanitizeLaserState(s), `${file}: unapproved laser state`); const b = laserBytes(s, true, false); if (s.mode === "manual") { emittingFrames++; assert.equal(b[6], LASER_TILT); } }
      assert.equal(inst.laserError, null, `${file}: ${inst.laserError}`);
    }
    assert.ok(emittingFrames > 0, `${file}: valid built-in laser intents were lost`);
  }
  assert.ok(withLasers >= 8, `expected several built-ins with lasers, found ${withLasers}`);
});

test("haze bytes are zero unless armed and inside a run, and never exceed the run deadline", async () => {
  const { hazeBytes, defaultHazeState, sanitizeHaze } = await import("../../../shared/src/index.js");
  const now = 1_000_000;
  const h = { ...defaultHazeState(), fan: 0.6, output: 0.4 };
  assert.deepEqual(hazeBytes(h, false, now), [0, 0]);                                   // disarmed
  assert.deepEqual(hazeBytes({ ...h, armed: true }, false, now), [0, 0]);               // armed, no run
  assert.deepEqual(hazeBytes({ ...h, armed: true, runUntil: now + 5000 }, false, now), [153, 102]);
  assert.deepEqual(hazeBytes({ ...h, armed: true, runUntil: now + 5000 }, true, now), [0, 0]); // blackout
  assert.deepEqual(hazeBytes({ ...h, armed: true, runUntil: now - 1 }, false, now), [0, 0]);   // deadline passed
  const s = sanitizeHaze({ fan: 9, output: -2 }, h);
  assert.equal(s.fan, 1); assert.equal(s.output, 0);
});

test("malformed pattern laser entries fail closed without losing valid palettes and spread", () => {
  for (const raw of [true, 42, "nonsense", "#xxyyzz", {}, [], { spread: 0.5 }, { mode: "auto" }, { color: "white" }, { color: "#ff0000oops" }, { color: [1, 0] }, { color: [Infinity, 0, 0] }, { mode: "manual", pattern: "spiral" }, { musicColor: "rainbow" }, { color: "red", pan: NaN }, { color: "cyan", spread: null }, { mode: "manual", channels: [255] }, { mode: "manual", tilt: 64 }]) {
    assert.equal(laserStateFromPattern(raw).mode, "off", JSON.stringify(raw));
    assert.deepEqual(laserBytes(laserStateFromPattern(raw), true, false), ZEROS);
  }
  assert.equal(nearestLaserColor("nonsense"), "off");
  assert.equal(laserStateFromPattern({ color: "#f80", spread: -2 }).color, "yellow");
  assert.equal(laserStateFromPattern({ color: "#f80", spread: -2 }).pan, 48);
  assert.equal(laserStateFromPattern({ color: [0, 1, 1], spread: 5 }).pan, 80);
  assert.equal(laserStateFromPattern({ color: [0, 1, 1] }).color, "cyan");
  assert.equal(laserStateFromPattern({ mode: "sound", musicColor: "blue" }).mode, "music");
  assert.deepEqual(laserBytes({ ...defaultLaserState(), mode: "manual", pan: NaN }, true, false), ZEROS);
});

test("gradient strips expand into evenly spaced virtual fixtures and fold back to one strip", async () => {
  const rig: Rig = {
    room: { name: "t", width: 10, height: 8, gridStep: 0.5, shapes: [] }, customProfiles: [], protectedRanges: [],
    fixtures: [
      { id: "w1", name: "Wash 1", profileId: "chauvet-slimpar-pro-h-12ch", universe: 0, address: 101, x: 0, y: 0, rotation: 0, tags: [], enabled: true },
      { id: "hue1", name: "Strip 5", profileId: "hue-gradient-strip", hueLightId: "1", x: 5, y: 7.4, rotation: 0, tags: ["strip"], enabled: true },
    ],
  };
  const { engineIndexOf } = await import("../../../shared/src/index.js");
  const ef = engineFixtures(rig);
  assert.equal(ef.length, 6);
  const segs = ef.filter((f) => f.parentId === "hue1");
  assert.equal(segs.length, 5);
  assert.deepEqual(segs.map((f) => f.segment), [0, 1, 2, 3, 4]);
  assert.ok(segs[0].x < segs[4].x && Math.abs(segs[2].x - 5) < 1e-9, "points run along the bar, centered on the fixture");
  assert.ok(segs.every((f) => f.hueLightId === "1" && f.tags.includes("segment")));
  assert.equal(engineIndexOf(rig, "hue1"), 1);
  const { resample } = await import("./hue.js");
  assert.deepEqual(resample([[0, 0], [1, 1]], 3), [[0, 0], [0.5, 0.5], [1, 1]]);
  assert.equal(resample([[0, 0], [0.2, 0.2], [0.4, 0.4], [0.6, 0.6], [0.8, 0.8], [1, 1]], 5).length, 5);
});

test("strips on two walls form one ring: balcony left to right, then the Network wall right to left", async () => {
  const { stripsOf } = await import("../engine/sandbox.js");
  const { toSandboxFixtures } = await import("../engine/engine.js");
  const rig: Rig = {
    room: { name: "t", width: 10, height: 8, gridStep: 0.5, shapes: [] }, customProfiles: [], protectedRanges: [],
    fixtures: [
      { id: "b1", name: "B left", profileId: "hue-gradient-strip", hueLightId: "1", x: 1.67, y: 7.4, rotation: 0, tags: ["strip"], enabled: true },
      { id: "b2", name: "B right", profileId: "hue-gradient-strip", hueLightId: "2", x: 8.33, y: 7.4, rotation: 0, tags: ["strip"], enabled: true },
      { id: "n1", name: "N right", profileId: "hue-gradient-strip", hueLightId: "3", x: 8.33, y: 1.1, rotation: 180, tags: ["strip"], enabled: true },
      { id: "n2", name: "N mid", profileId: "hue-gradient-strip", hueLightId: "4", x: 5, y: 1.1, rotation: 0, tags: ["strip"], enabled: true },
    ],
  };
  const ef = engineFixtures(rig);
  const ring = stripsOf(toSandboxFixtures(ef, rig));
  const order = ring.map((f) => f.id.split("#")[0]).filter((id, i, a) => a.indexOf(id) === i);
  assert.deepEqual(order, ["b1", "b2", "n1", "n2"]);
  assert.equal(ring[0].u, 0); assert.equal(ring.at(-1)!.u, 1);
  // Within a strip the points run with the ring too (rotation 180 on the Network wall keeps its plug-end first).
  const n1 = ring.filter((f) => f.id.startsWith("n1#")).map((f) => f.id);
  assert.deepEqual(n1, ["n1#0", "n1#1", "n1#2", "n1#3", "n1#4"]);
});
