import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTurnToolRunner, runTool, TOOL_DEFS, type AgentHost, type ToolCaller } from "./tools.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { config } from "../config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const editor: ToolCaller = { role: "editor", by: "Test editor" };
const admin: ToolCaller = { role: "admin", by: "Test operator" };

function makeHost(t: TestContext): AgentHost {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-test-"));
  fs.mkdirSync(path.join(config.dataDir, "patterns"), { recursive: true });
  const library = new Library();
  library.load();
  const rig = defaultRig();
  const settings = defaultSettings();
  const show = new ShowController(library, () => rig, () => settings);
  // Agent tests exercise the controller with in-memory worker communication only.
  const engine = show.engine as unknown as { ensureWorker(): void; post(message: unknown): void };
  t.mock.method(engine, "ensureWorker", () => {});
  t.mock.method(engine, "post", () => {});
  show.engine.setRig(rig);
  t.after(() => show.stop());
  return { library, show, getRig: () => rig, getSettings: () => settings, onPatternSaved: () => {} };
}

test("tool definitions are strict, named uniquely, and never use additionalProperties: true", () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of TOOL_DEFS) assert.equal(t.strict, true);
  assert.ok(!JSON.stringify(TOOL_DEFS).includes('"additionalProperties":true'));
});

test("write_pattern compiles, saves and reports params; apply_pattern activates it", (t) => {
  const host = makeHost(t);
  const src = `export default { name: "Test Glow", params: { level: { type: "number", default: 0.5, min: 0, max: 1 } }, render(ctx) { ctx.fill("#00ff00", { dim: ctx.params.level }); } };`;
  const res = JSON.parse(runTool(host, "write_pattern", { id: null, source: src }, editor));
  assert.equal(res.ok, true);
  assert.equal(res.name, "Test Glow");
  assert.deepEqual(Object.keys(res.params), ["level"]);
  const applied = JSON.parse(runTool(host, "apply_pattern", { id: res.id, params: JSON.stringify({ level: 0.9 }), crossfadeMs: 0 }, editor));
  assert.equal(applied.ok, true);
  assert.equal(host.show.state.patternId, res.id);
  assert.equal(host.show.state.params.level, 0.9);
  host.show.engine.stop();
});

test("write_pattern surfaces compile errors as thrown errors", (t) => {
  const host = makeHost(t);
  assert.throws(() => runTool(host, "write_pattern", { id: null, source: "export default { render(ctx) { nope( } }" }, editor), /Syntax error/);
  assert.throws(() => runTool(host, "read_pattern", { id: "missing" }), /No pattern/);
  assert.throws(() => runTool(host, "set_bpm", { bpm: "fast" }, editor), /must be a number/);
  host.show.engine.stop();
});

test("get_rig hides nothing about lasers but exposes only enabled fixtures", (t) => {
  const host = makeHost(t);
  const r = JSON.parse(runTool(host, "get_rig", {}));
  // Pinspots start disabled (not wired yet), so only the four washes are visible to the agent.
  assert.equal(r.fixtures.length, 4);
  assert.ok(r.fixtures.every((f: { kind: string }) => f.kind === "wash"));
  host.show.engine.stop();
});


test("laser tools require an identified admin and an already armed running show without lifting gates", (t) => {
  const host = makeHost(t);
  const command = { look: "tight", lasers: null };
  for (const caller of [undefined, { role: "viewer", by: "Viewer" }, { role: "guest", by: "Guest" }, editor] as (ToolCaller | undefined)[]) {
    const before = structuredClone(host.show.state);
    assert.throws(() => runTool(host, "set_lasers", command, caller), /control role|admin/);
    assert.deepEqual(host.show.state, before);
  }
  assert.throws(() => runTool(host, "apply_pattern", { id: "missing" }), /control role/);
  assert.throws(() => runTool(host, "lasers_off", {}), /control role/);
  assert.equal(JSON.parse(runTool(host, "get_lasers", {})).callerMayControl, false);
  const unchanged = (expected: RegExp) => {
    const before = structuredClone(host.show.state);
    assert.throws(() => runTool(host, "set_lasers", command, admin), expected);
    assert.deepEqual(host.show.state, before);
  };
  unchanged(/explicitly arm/);
  host.show.armLasers(true, "Operator");
  unchanged(/stopped/);
  host.show.quickLook("calm-blue", ["w1"]);
  host.show.state.blackout = true;
  unchanged(/Blackout/);
  assert.equal(JSON.parse(runTool(host, "get_lasers", {}, admin)).canApplyNow, false);
  host.show.state.blackout = false;
  host.show.state.released = true;
  unchanged(/released/);
  host.show.state.released = false;
  host.getSettings().agent.allowApply = false;
  unchanged(/disabled/);
  host.getSettings().agent.allowApply = true;
  const result = JSON.parse(runTool(host, "set_lasers", command, admin));
  assert.equal(result.armed, true);
  assert.equal(result.look, "tight");
  assert.equal(result.canApplyNow, true);
  assert.ok(result.lasers.every((laser: { on: boolean; pan: number; color: string }) => laser.on && laser.pan === 48 && laser.color === "cyan"));
});

test("set_lasers validates the entire command before any fixture or ownership mutation", (t) => {
  const host = makeHost(t);
  host.show.quickLook("calm-blue", ["w1"]);
  host.show.armLasers(true, "Operator");
  const invalid: unknown[] = [
    null, {}, [], { look: "tight", lasers: "[]" }, { look: "missing", lasers: null },
    { look: "pattern", lasers: null }, { look: "", lasers: null }, { look: "tight", channels: [255] },
    { look: null, lasers: "{" }, { look: null, lasers: "[]" }, { look: null, lasers: "{}" },
    ...[
      { id: "missing", mode: "manual" }, { id: "w1", mode: "manual" },
      { id: "l2", mode: "manual", pan: 81 }, { id: "l2", pan: 60.5 },
      { id: "l2", pan: NaN }, { id: "l2", color: "purple" },
      { id: "l2", mode: "sound" }, { id: "l2", pattern: "circle" },
      { id: "l2", musicColor: null }, { id: "l2", tilt: 1 },
      { id: "l1", mode: "manual" }, "l2", null,
    ].map((bad) => ({ look: null, lasers: [{ id: "l1", mode: "manual", color: "cyan" }, bad] })),
  ];
  for (const command of invalid) {
    const before = structuredClone(host.show.state);
    assert.throws(() => runTool(host, "set_lasers", command, admin));
    assert.deepEqual(host.show.state, before, `invalid command mutated show: ${JSON.stringify(command)}`);
  }
  const result = JSON.parse(runTool(host, "set_lasers", {
    look: null,
    lasers: JSON.stringify([{ id: "l1", mode: "manual", pattern: "fan", color: "cyan", pan: 48 }, { id: "l2", mode: "manual", pattern: "wave", color: "magenta", pan: 80 }]),
  }, admin));
  assert.equal(result.lasers[0].color, "cyan");
  assert.equal(result.lasers[1].color, "magenta");
  assert.equal(result.lasers[1].pattern, "wave");
});

test("one agent turn retains its initial generation across tools and can save but never revive after Stop", (t) => {
  const host = makeHost(t);
  host.show.quickLook("calm-blue", ["w1"]);
  host.show.armLasers(true, "Operator");
  const run = createTurnToolRunner(host, admin);
  run("set_lasers", { look: "wide", lasers: null });
  // Even the turn's own ownership change cannot renew authority for the remaining tools.
  assert.throws(() => run("set_master", { level: 0.7 }), /Stale/);
  host.show.stopLighting();
  assert.throws(() => run("set_lasers", { look: "wide", lasers: null }), /Stale/);
  const notifications: boolean[] = [];
  host.onPatternSaved = (_id, applyLive) => { notifications.push(applyLive !== false); };
  const saved = JSON.parse(run("write_pattern", { id: null, source: 'export default { name: "Late saved work", render(ctx) { ctx.fill("#fff"); } };' }));
  assert.ok(host.library.getPattern(saved.id));
  assert.deepEqual(notifications, [false]);
  assert.equal(host.show.state.stopped, true);
  assert.equal(host.show.state.lasers.armed, false);
});

test("late AI tools cannot reclaim manual output, while stale lasers_off remains available to every control role", (t) => {
  const host = makeHost(t);
  host.show.quickLook("calm-blue", ["w1"]);
  host.show.armLasers(true, "Operator");
  const run = createTurnToolRunner(host, admin);
  host.show.setLaserLook("tight");
  const before = structuredClone(host.show.state);
  assert.throws(() => run("set_lasers", { look: "wide", lasers: null }), /Stale/);
  assert.deepEqual(host.show.state, before);
  host.show.state.blackout = true;
  assert.ok(JSON.parse(runTool(host, "get_lasers", {}, admin)).lasers.every((laser: { on: boolean }) => !laser.on));
  host.show.state.blackout = false;
  for (const role of ["guest", "editor", "admin"] as const) {
    host.show.armLasers(true, "Operator");
    const staleGeneration = host.show.state.generation - 1;
    assert.equal(JSON.parse(runTool(host, "lasers_off", {}, { role, by: role }, staleGeneration)).armed, false);
    assert.equal(host.show.state.lasers.armed, false);
    assert.ok(Object.values(host.show.state.lasers.fixtures).every((laser) => laser.mode === "off"));
  }
});


test("fresh AI source edits reload once, while disabled apply only saves and all edits revoke Follow", (t) => {
  const host = makeHost(t);
  const source = 'export default { name: "Editable", render(ctx) { ctx.fill("#00f"); } };';
  const pattern = host.library.savePattern({ source });
  host.show.setPattern(pattern.id, {}, 0);
  const notifications: boolean[] = [];
  host.onPatternSaved = (id, applyLive) => {
    notifications.push(applyLive === true);
    if (applyLive) host.show.patternUpdated(id);
  };
  const run = createTurnToolRunner(host, editor);
  run("write_pattern", { id: pattern.id, source: source.replace("#00f", "#f00") });
  assert.deepEqual(notifications, [true]);
  assert.throws(() => run("set_master", { level: 0.7 }), /Stale/);
  host.getSettings().agent.allowApply = false;
  runTool(host, "write_pattern", { id: pattern.id, source: source.replace("#00f", "#0f0") }, editor);
  assert.deepEqual(notifications, [true, false]);
  assert.ok(host.library.getPattern(pattern.id)?.source.includes("#0f0"));
  assert.equal(host.show.state.lasers.patternFollowing, false);
});
