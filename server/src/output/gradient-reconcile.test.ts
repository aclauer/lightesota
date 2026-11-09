import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultLasersState, defaultWashState, engineFixtures } from "../../../shared/src/index.js";
import { config } from "../config.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { Engine, toSandboxFixtures, type EngineFrame } from "../engine/engine.js";
import { compilePattern, PatternInstance } from "../engine/sandbox.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { HueBridge } from "./hue.js";
import { OutputManager } from "./output.js";

function gradientRig() {
  const rig = defaultRig();
  rig.fixtures.push({ id: "strip", name: "Test gradient", profileId: "hue-gradient-strip", hueLightId: "fake-strip", x: 5, y: 7, rotation: 0, tags: ["strip"], enabled: true });
  return rig;
}

test("gradient queue obeys the same process-wide physical veto as ordinary Hue colors", (t) => {
  const hue = new HueBridge("invalid.example", "fake-test-only", 8);
  t.after(() => hue.stop());
  assert.throws(() => hue.setGradient("1", [[1, 0, 0], [0, 0, 1]], 1), /vetoed/);
});

test("parent strip overrides and solo coexist with manual wash ownership and blackout", () => {
  const engine = new Engine(), rig = gradientRig();
  engine.setRig(rig);
  engine.overrides.strip = { r: 0.25, g: 0.5, b: 0.75, dim: 0.5 };
  engine.washes.w1 = { ...defaultWashState(), mode: "normal", brightness: 51, rgbw: [255, 0, 0, 0] };
  const raw = new Float32Array(engineFixtures(rig).length * 8).fill(1);
  const internal = engine as unknown as { publishFrame(raw: Float32Array): void };
  internal.publishFrame(raw);
  assert.equal(engine.lastFrame!.colors[0].dim, 0.2);
  engine.solo = new Set(["strip"]);
  internal.publishFrame(raw);
  const strip = engine.lastFrame!.fixtures.flatMap((f, i) => f.parentId === "strip" ? [engine.lastFrame!.colors[i]] : []);
  assert.equal(strip.length, 5);
  assert.ok(strip.every((c) => c.r === 0.25 && c.g === 0.5 && c.b === 0.75 && c.dim === 0.5));
  assert.equal(engine.lastFrame!.colors[0].dim, 0);
  engine.blackout = true; internal.publishFrame(raw);
  assert.ok(engine.lastFrame!.colors.every((c) => c.dim === 0));
});

test("event sweep and ring runner render moving, distinct gradient points through the real sandbox", () => {
  const rig = gradientRig(), fixtures = engineFixtures(rig), sandboxFixtures = toSandboxFixtures(fixtures, rig);
  for (const name of ["22-warm-to-white-sweep.js", "23-ring-runner.js"]) {
    const source = fs.readFileSync(new URL(`../../../patterns/${name}`, import.meta.url), "utf8");
    const instance = new PatternInstance(compilePattern(source), sandboxFixtures, { passSec: 5, length: 2 }, 1);
    instance.render(2, 120, 0);
    assert.equal(instance.error, null, name);
    const first = Array.from(instance.out.slice(-40));
    const points = [0, 1, 2, 3, 4].map((i) => first.slice(i * 8, i * 8 + 3).join(","));
    assert.ok(new Set(points).size > 1, `${name} must paint distinct strip points`);
    instance.render(1, 120, 2);
    assert.equal(instance.error, null, name);
    assert.notDeepEqual(Array.from(instance.out.slice(-40)), first, `${name} must move with time/beat`);
    assert.ok(instance.out.every((v) => Number.isFinite(v) && v >= 0 && v <= 1));
  }
});

test("saved strip IDs accept manual override, flash and solo; Stop cancels flash restoration", async (t) => {
  const oldDir = config.dataDir;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gradient-controls-"));
  config.dataDir = dataDir;
  fs.mkdirSync(path.join(config.dataDir, "patterns"));
  const rig = gradientRig(), settings = defaultSettings(), library = new Library();
  const show = new ShowController(library, () => rig, () => settings);
  t.after(() => { show.stop(); library.flush(); config.dataDir = oldDir; fs.rmSync(dataDir, { recursive: true, force: true }); });
  show.engine.setRig(rig);
  show.setOverride("strip", { r: 0.2, g: 0.4, b: 0.6, dim: 0.3 });
  show.setSolo(["strip"]); show.engine.refresh();
  let colors = show.engine.lastFrame!.colors.slice(-5);
  assert.ok(colors.every((c) => c.dim === 0.3 && c.r === 0.2));
  show.testFixture("strip", 0.05);
  colors = show.engine.lastFrame!.colors.slice(-5);
  assert.ok(colors.every((c) => c.dim === 0.15 && c.r === 1));
  show.stopLighting();
  await new Promise<void>((resolve) => setTimeout(resolve, 80));
  assert.equal(show.state.stopped, true);
  assert.deepEqual(show.state.overrides, {});
  assert.ok(show.engine.lastFrame!.colors.every((c) => c.dim === 0));
});

test("gradient folding retains point order and Stop/blackout zero strips despite other output failures", () => {
  const rig = gradientRig();
  rig.fixtures.push({ id: "bulb", name: "Test ordinary Hue", profileId: "hue-color-light", hueLightId: "fake-bulb", x: 1, y: 1, rotation: 0, tags: [], enabled: true });
  const fixtures = engineFixtures(rig), engine = new EventEmitter() as Engine;
  const settings = defaultSettings(); settings.hue.enabled = true; settings.hue.username = "fake-test-only";
  const control = { lasers: defaultLasersState(), blackout: false, stopped: false, generation: 1 };
  const output = new OutputManager(engine, settings, rig, () => control);
  const operations: Array<{ kind: string; colors?: [number, number, number][]; dim?: number }> = [];
  output.hue = {
    cancelPending() { operations.push({ kind: "cancel" }); },
    setColor() { throw new Error("fake ordinary light failure"); },
    setGradient(_id: string, colors: [number, number, number][], dim: number) { operations.push({ kind: "gradient", colors, dim }); },
  } as unknown as HueBridge;
  output.onDmx = () => { throw new Error("fake subscriber failure"); };
  const frame: EngineFrame = { t: 0, fixtures, values: new Float32Array(fixtures.length * 8), colors: [] };
  fixtures.forEach((f, i) => { frame.values[i * 8] = (f.segment ?? 0) / 4; frame.values[i * 8 + 2] = 1; frame.values[i * 8 + 6] = 0.5; });
  engine.emit("frame", frame);
  assert.match(output.hue.lastError!, /fake ordinary light failure/);
  assert.deepEqual(operations.at(-1), { kind: "gradient", colors: [[0, 0, 1], [0.25, 0, 1], [0.5, 0, 1], [0.75, 0, 1], [1, 0, 1]], dim: 0.5 });
  control.stopped = true; control.generation++; engine.emit("frame", frame);
  assert.equal(operations.at(-1)!.dim, 0);
  assert.equal(operations.at(-2)!.kind, "cancel");
  control.stopped = false; control.blackout = true; control.generation++; engine.emit("frame", frame);
  assert.equal(operations.at(-1)!.dim, 0);
});
