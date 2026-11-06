import { test } from "node:test";
import assert from "node:assert/strict";
import { runTool, TOOL_DEFS, type AgentHost } from "./tools.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { config } from "../config.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function makeHost(): AgentHost {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-test-"));
  fs.mkdirSync(path.join(config.dataDir, "patterns"), { recursive: true });
  const library = new Library();
  library.load();
  const rig = defaultRig();
  const settings = defaultSettings();
  const show = new ShowController(library, () => rig, () => settings);
  return { library, show, getRig: () => rig, getSettings: () => settings, onPatternSaved: () => {} };
}

test("tool definitions are strict and named uniquely", () => {
  const names = TOOL_DEFS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const t of TOOL_DEFS) assert.equal(t.strict, true);
});

test("write_pattern compiles, saves and reports params; apply_pattern activates it", () => {
  const host = makeHost();
  const src = `export default { name: "Test Glow", params: { level: { type: "number", default: 0.5, min: 0, max: 1 } }, render(ctx) { ctx.fill("#00ff00", { dim: ctx.params.level }); } };`;
  const res = JSON.parse(runTool(host, "write_pattern", { id: null, source: src }));
  assert.equal(res.ok, true);
  assert.equal(res.name, "Test Glow");
  assert.deepEqual(Object.keys(res.params), ["level"]);
  const applied = JSON.parse(runTool(host, "apply_pattern", { id: res.id, params: { level: 0.9 }, crossfadeMs: 0 }));
  assert.equal(applied.ok, true);
  assert.equal(host.show.state.patternId, res.id);
  assert.equal(host.show.state.params.level, 0.9);
  host.show.engine.stop();
});

test("write_pattern surfaces compile errors as thrown errors", () => {
  const host = makeHost();
  assert.throws(() => runTool(host, "write_pattern", { id: null, source: "export default { render(ctx) { nope( } }" }), /Syntax error/);
  assert.throws(() => runTool(host, "read_pattern", { id: "missing" }), /No pattern/);
  assert.throws(() => runTool(host, "set_bpm", { bpm: "fast" }), /must be a number/);
  host.show.engine.stop();
});

test("get_rig hides nothing about lasers but exposes only enabled fixtures", () => {
  const host = makeHost();
  const r = JSON.parse(runTool(host, "get_rig", {}));
  // Pinspots start disabled (not wired yet), so only the four washes are visible to the agent.
  assert.equal(r.fixtures.length, 4);
  assert.ok(r.fixtures.every((f: { kind: string }) => f.kind === "wash"));
  host.show.engine.stop();
});
