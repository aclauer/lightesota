import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { ShowController } from "../show.js";
import { Library } from "../library.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { config } from "../config.js";
import { runTool, type AgentHost } from "../agent/tools.js";
import { AgentService } from "../agent/agent.js";
import { laserBytes, type Scene } from "../../../shared/src/index.js";
import type { FromWorker } from "./worker.js";

// Isolated storage and in-memory worker replies; no server or physical transport.
config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightesota-control-"));
fs.mkdirSync(path.join(config.dataDir, "patterns"));
const library = new Library();
const pattern = library.savePattern({ source: 'export default {name:"Control test",render(ctx){ctx.fill("#ff0000",{dim:1});}}' });
const scene: Scene = { id: "test", name: "Test", patternId: pattern.id, params: {}, master: 1, bpm: null, speed: 1, overrides: {}, favorite: false, hotkey: null, swatch: [], createdAt: 1, updatedAt: 1 };
library.upsertScene(scene);
library.upsertPlaylist({ id: "test", name: "Test", loop: true, shuffle: false, steps: [{ id: "step", sceneId: "test", duration: 0.25, unit: "seconds" }], createdAt: 1, updatedAt: 1 });
function harness(t: TestContext) {
  const rig = defaultRig(), settings = defaultSettings();
  const show = new ShowController(library, () => rig, () => settings);
  const internal = show.engine as unknown as {
    ensureWorker(): void; post(message: unknown): void; revision: number; generation: number; awaiting: boolean;
    onWorkerMessage(message: FromWorker): void; publishFrame(raw: Float32Array): void;
    restartWorker(): void; currentId: string | null; pendingLoad: unknown;
  };
  t.mock.method(internal, "ensureWorker", () => {});
  const messages: unknown[] = [];
  t.mock.method(internal, "post", (message: unknown) => { messages.push(message); });
  show.engine.setRig(rig);
  const savedNotifications: boolean[] = [];
  const host: AgentHost = { library, show, getRig: () => rig, getSettings: () => settings, onPatternSaved: (_id, live) => { savedNotifications.push(live !== false); } };
  t.after(() => show.stop());
  return { show, rig, settings, internal, messages, host, savedNotifications };
}
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const startedAt = (show: ShowController) => (show as unknown as { runClock: { started: number } }).runClock.started;

test("boot preserves libraries/history while resetting emitting runtime and generation", (t) => {
  const old = { generation: Date.now() * 1000 + 100, patternId: pattern.id, overrides: { w1: { dim: 1 } }, released: true, solo: ["w1"], history: [{ patternId: pattern.id, params: {}, sceneId: null, at: 1 }], washes: { w1: { mode: "music32", brightness: 255 } }, lasers: { armed: true }, master: "NaN", transport: { bpm: "fast" }, speed: null };
  fs.writeFileSync(path.join(config.dataDir, "show.json"), JSON.stringify(old));
  const { show } = harness(t);
  assert.equal(show.state.stopped, true); assert.equal(show.state.patternId, null);
  assert.equal(show.state.master, 1); assert.equal(show.state.transport.bpm, 120); assert.equal(show.state.speed, 1);
  assert.deepEqual(show.state.overrides, {}); assert.equal(show.state.released, false);
  assert.ok(show.state.generation > old.generation);
  assert.ok(Object.values(show.state.washes).every((w) => w.mode === "off"));
  assert.equal(show.state.lasers.armed, false);
  assert.equal(show.state.history[0].patternId, pattern.id);
  assert.equal(library.getPattern(pattern.id)?.name, "Control test"); assert.equal(library.scenes[0].id, "test");
});

test("wash modes own selected fixtures; brightness retains music, RGBW forces Normal, invalid changes are atomic", (t) => {
  const { show, internal } = harness(t);
  show.setWash(["w1", "w2"], { mode: "music6", brightness: 38 });
  const peer = structuredClone(show.state.washes.w3);
  show.setWash(["w1"], { brightness: 22 });
  assert.equal(show.state.washes.w1.mode, "music6"); assert.equal(show.state.washes.w2.brightness, 38);
  show.setWash(["w1"], { rgbw: [0, 255, 255, 0] });
  assert.equal(show.state.washes.w1.mode, "normal"); assert.equal(show.state.washes.w1.sensitivity, 255);
  show.setWash(["w2"], { mode: "off" }); show.setPattern(pattern.id, {}, 0);
  internal.publishFrame(new Float32Array(32).fill(1));
  assert.equal(show.engine.lastFrame!.values[6], Math.fround(22 / 255)); assert.equal(show.engine.lastFrame!.values[14], 0);
  assert.deepEqual(show.state.washes.w3, peer);
  const before = JSON.stringify(show.state);
  assert.throws(() => show.setWash(["w1", "l1"], { mode: "normal" }), /Not an enabled/);
  assert.throws(() => show.setWash(["w1"], { sensitivity: 10 }), /11..255/);
  assert.throws(() => show.setWash(["w1"], { brightness: NaN }), /integer/);
  assert.equal(JSON.stringify(show.state), before);
  show.releaseWashes(["w2"]); internal.publishFrame(new Float32Array(32).fill(1));
  assert.equal(show.engine.lastFrame!.values[14], 1); assert.equal(show.state.washes.w1.owner, "manual");
});

test("quick looks have exact modest ceilings, RGBW and historical side scopes", (t) => {
  const { show } = harness(t);
  show.quickLook("warm-arrival", ["w1"]);
  assert.deepEqual(show.state.washes.w1.rgbw, [255, 120, 32, 64]); assert.equal(show.state.washes.w1.brightness, 32);
  show.quickLook("cyan-magenta", ["w2", "w3"]);
  assert.deepEqual(show.state.washes.w2.rgbw, [0, 255, 255, 0]); assert.deepEqual(show.state.washes.w3.rgbw, [255, 0, 255, 0]);
  assert.equal(show.state.washes.w4.mode, "off");
  show.quickLook("calm-blue", ["w4"]); assert.equal(show.state.washes.w4.brightness, 25);
  show.quickLook("music32", ["w4"]); assert.equal(show.state.washes.w4.mode, "music32"); assert.equal(show.state.washes.w4.brightness, 38);
});

test("Stop rejects queued worker loads/frames, playlists, flash restoration and old AI apply", async (t) => {
  const { show, internal, host, savedNotifications } = harness(t);
  show.playPlaylist("test"); const revision = internal.revision;
  show.testFixture("w1", 0.05); show.armLasers(true, "test operator"); show.setLaserLook("slow-sweep");
  const generation = show.state.generation; show.stopLighting();
  internal.onWorkerMessage({ type: "loaded", slot: "a", id: pattern.id, params: {}, usesLasers: false, laserLook: null, revision, generation: internal.generation });
  internal.onWorkerMessage({ type: "frame", buf: new Float32Array(32).fill(1), errorA: null, errorB: null, renderMs: 1, logs: [], revision, generation: internal.generation });
  assert.equal(internal.currentId, null); assert.equal(internal.pendingLoad, null); assert.equal(show.engine.fadeProgress, null);
  assert.equal(show.state.playlist, null); assert.equal(show.state.patternId, null); assert.equal(show.state.lasers.armed, false);
  assert.throws(() => runTool(host, "apply_pattern", { id: pattern.id }, { role: "guest", by: "test" }, generation), /Stale/);
  const saved = JSON.parse(runTool(host, "write_pattern", { id: null, source: 'export default {name:"Late saved work",render(ctx){ctx.fill("#fff");}}' }, { role: "guest", by: "test" }, generation));
  assert.ok(library.getPattern(saved.id)); assert.equal(savedNotifications.at(-1), false);
  await wait(280);
  assert.equal(show.state.patternId, null); assert.equal(show.state.washes.w1.mode, "off");
  assert.ok(show.engine.lastFrame!.colors.every((color) => color.dim === 0));
  show.releaseWashes(["w1"]);
  assert.equal(show.engine.lastFrame!.colors[0].dim, 0, "releasing an override cannot expose a stale pre-Stop frame");
});

test("worker recovery requires Start and a same-ID delayed load cannot replace a newer request", (t) => {
  const { show, internal, messages } = harness(t);
  show.setPattern(pattern.id, {}, 0); const old = internal.revision;
  internal.awaiting = true;
  show.setPattern(pattern.id, {}, 0);
  assert.equal(internal.awaiting, false, "switching releases an invalidated render wait instead of triggering watchdog Stop");
  internal.onWorkerMessage({ type: "loaded", slot: "a", id: pattern.id, params: { wrong: 1 }, usesLasers: false, laserLook: null, revision: old, generation: internal.generation });
  assert.deepEqual(show.state.params, {});
  internal.onWorkerMessage({ type: "loaded", slot: "a", id: pattern.id, params: {}, usesLasers: false, laserLook: null, revision: internal.revision, generation: internal.generation });
  const loads = messages.filter((m) => (m as { type: string }).type === "load").length;
  internal.restartWorker(); assert.equal(show.state.stopped, true); assert.equal(show.state.patternId, null);
  assert.equal(messages.filter((m) => (m as { type: string }).type === "load").length, loads);
});

test("manual takeover holds selected output and detaches only its coordinated-show writer", (t) => {
  const { show } = harness(t);
  show.quickLook("warm-arrival", ["w4"]); show.startCoordinatedShow({ id: "neon-exchange", fixtureIds: ["w1", "w2"] });
  const held = structuredClone(show.state.washes.w1), peer = structuredClone(show.state.washes.w4), generation = show.state.generation;
  show.takeManualControl(["w1"]);
  assert.deepEqual(show.state.washes.w1, { ...held, owner: "manual" }); assert.deepEqual(show.state.coordinatedShow!.fixtureIds, ["w2"]);
  show.tickCoordinatedShow(); assert.deepEqual(show.state.washes.w4, peer);
  assert.throws(() => show.assertGeneration(generation), /Stale/);
});

test("laser staging/Arm stay dark, disarm drops intent and blackout release never reactivates lasers", (t) => {
  const { show } = harness(t);
  show.setLaser("l1", { mode: "manual", pattern: "wave", color: "cyan" });
  assert.equal(show.state.lasers.fixtures.l1.mode, "off"); show.armLasers(true, "test operator");
  assert.ok(laserBytes(show.state.lasers.fixtures.l1, true, false).every((b) => b === 0));
  show.setLaser("l1", { mode: "manual" }); assert.ok(laserBytes(show.state.lasers.fixtures.l1, true, false).some((b) => b !== 0));
  show.setBlackout(true); show.setBlackout(false); assert.equal(show.state.lasers.armed, false);
  show.setLaser("l1", { mode: "music" }); show.armLasers(true, "test operator"); assert.equal(show.state.lasers.fixtures.l1.mode, "off");
  show.lasersOff("test"); assert.throws(() => show.setLaserLook("slow-sweep"), /Arm lasers/); assert.throws(() => show.quickLook("laser-duo"), /Arm lasers/);
});

test("finite shared shows swap phrases and finish owned output by monotonic duration despite tempo changes", (t) => {
  const { show } = harness(t); let beat = 0;
  Object.defineProperty(show.engine, "beat", { get: () => beat });
  show.quickLook("warm-arrival", ["w4"]); const peer = structuredClone(show.state.washes.w4);
  show.startCoordinatedShow({ id: "call-response", fixtureIds: ["w1", "w3"], ceiling: 25, durationSec: 10 }); const started = startedAt(show);
  assert.equal(show.state.washes.w1.brightness, 25); assert.equal(show.state.washes.w3.brightness, 10);
  assert.deepEqual(show.state.washes.w1.rgbw, [0, 255, 255, 0]); assert.deepEqual(show.state.washes.w3.rgbw, [255, 0, 255, 0]);
  beat = 16; show.tickCoordinatedShow(started + 3000); assert.equal(show.state.washes.w1.brightness, 10); assert.equal(show.state.washes.w3.brightness, 25);
  assert.deepEqual(show.state.washes.w1.rgbw, [0, 255, 255, 0], "Call/Response retains Side A cyan across emphasis swaps");
  assert.deepEqual(show.state.washes.w3.rgbw, [255, 0, 255, 0], "Call/Response retains Side B magenta across emphasis swaps");
  show.setBpm(300); beat = 19; show.tickCoordinatedShow(started + 9999); assert.ok(show.state.coordinatedShow);
  show.tickCoordinatedShow(started + 10000); assert.equal(show.state.coordinatedShow, null); assert.equal(show.state.washes.w1.mode, "off");
  assert.deepEqual(show.state.washes.w4, peer); show.tickCoordinatedShow(started + 50000); assert.equal(show.state.washes.w1.mode, "off");
});

test("Build/Release stays within ceiling and laser cues skip missed phrases with four-second dwell", (t) => {
  const { show } = harness(t); let beat = 0; Object.defineProperty(show.engine, "beat", { get: () => beat });
  assert.throws(() => show.startCoordinatedShow({ id: "neon-exchange", fixtureIds: ["w1"], includeLasers: true }), /Arm lasers/);
  show.armLasers(true, "test operator"); show.startCoordinatedShow({ id: "build-release", fixtureIds: ["w1", "w3"], ceiling: 100, includeLasers: true }); const started = startedAt(show);
  assert.equal(show.state.washes.w1.brightness, 35); beat = 8; show.tickCoordinatedShow(started + 1000); assert.equal(show.state.washes.w1.brightness, 68);
  beat = 16; show.tickCoordinatedShow(started + 2000); assert.equal(show.state.washes.w1.brightness, 35); assert.equal(show.state.lasers.fixtures.l1.color, "cyan");
  show.tickCoordinatedShow(started + 4500); assert.equal(show.state.lasers.fixtures.l1.color, "cyan", "skipped phrase must not fire later mid-phrase");
  beat = 48; show.tickCoordinatedShow(started + 5000); assert.equal(show.state.lasers.fixtures.l1.color, "magenta");
  assert.deepEqual(laserBytes(show.state.lasers.fixtures.l1, true, false).slice(3), [0, 53, 64, 64, 0, 0, 0]);
  beat = 64.5; show.tickCoordinatedShow(started + 10000);
  assert.equal(show.state.lasers.fixtures.l1.color, "magenta", "250ms-late phrase must be skipped despite sufficient dwell");
  beat = 64.6; show.tickCoordinatedShow(started + 10100);
  assert.equal(show.state.lasers.fixtures.l1.color, "magenta", "a late phrase cannot catch up on the following tick");
  beat = 96.1; show.tickCoordinatedShow(started + 18000);
  assert.equal(show.state.lasers.fixtures.l1.color, "cyan", "a cue 50ms inside a fresh phrase can apply after a skipped cue");
  show.lasersOff("operator"); beat = 112; show.tickCoordinatedShow(started + 20000);
  assert.equal(show.state.coordinatedShow!.includeLasers, false); assert.equal(show.state.lasers.fixtures.l1.mode, "off");
});

test("Stop clears state even when output subscriber fails; preview blocks agent provider access", async (t) => {
  const { show, host } = harness(t); show.quickLook("music6", ["w1"]);
  const fail = () => { throw new Error("fake output failure"); }; show.engine.on("frame", fail);
  assert.throws(() => show.stopLighting(), /fake output failure/); show.engine.off("frame", fail);
  assert.equal(show.state.washes.w1.mode, "off"); assert.equal(show.state.stopped, true); assert.equal(show.state.lasers.armed, false);
  const agent = new AgentService(host, () => {}); assert.equal(agent.hasCredentials(), false);
  await assert.rejects(agent.send(null, "Do not call a provider"), /disabled in preview/);
});

test("quiet or disconnected microphone drops stale BPM and activates shared-clock fallback", (t) => {
  const { show } = harness(t);
  show.setAudio("test", "fake microphone", { level: 0.5, bass: 0.4, mid: 0.2, high: 0.1, onset: true, bpm: 120 }); assert.equal(show.state.audio.active, true);
  show.setAudio("test", "fake microphone", { level: 0, bass: 0, mid: 0, high: 0, onset: false, bpm: 120 });
  assert.equal(show.state.audio.active, false); assert.equal(show.state.audio.bpm, null); assert.equal(show.engine.audioActive, false);
  show.setAudio("test", "fake microphone", null); assert.equal(show.state.audio.source, null);
});


test("captured wash scenes restore modes without laser arming; explicit pattern Start releases only show ownership", (t) => {
  const { show } = harness(t);
  show.quickLook("music32", ["w2"]);
  const saved = show.captureScene("Music snapshot");
  assert.equal(saved.washes!.w2.mode, "music32");
  show.stopLighting(); show.recallScene(saved.id);
  assert.equal(show.state.washes.w2.mode, "music32");
  assert.equal(show.state.stopped, false);
  assert.equal(show.state.lasers.armed, false);
  show.startCoordinatedShow({ id: "neon-exchange", fixtureIds: ["w1"] });
  show.setPattern(pattern.id, {}, 0);
  assert.equal(show.state.washes.w1.owner, "pattern");
  assert.equal(show.state.washes.w2.owner, "manual");
  assert.equal(show.state.washes.w2.mode, "music32");
});


test("release and reacquire are dark ownership barriers requiring a new Start", (t) => {
  const { show } = harness(t);
  show.setPattern(pattern.id, {}, 0); show.quickLook("music6", ["w2"]);
  const generation = show.state.generation;
  show.setReleased(true);
  assert.equal(show.state.released, true); assert.equal(show.state.stopped, true);
  assert.equal(show.state.patternId, null); assert.equal(show.state.washes.w2.mode, "off");
  assert.throws(() => show.assertGeneration(generation), /Stale/);
  show.setReleased(false);
  assert.equal(show.state.released, false); assert.equal(show.state.stopped, true);
  assert.equal(show.state.patternId, null);
});


test("a manual command cancels diagnostic flash restoration without disturbing unrelated manual peers", async (t) => {
  const { show } = harness(t);
  show.quickLook("music6", ["w1"]); show.quickLook("warm-arrival", ["w4"]);
  const peer = structuredClone(show.state.washes.w4);
  show.testFixture("w1", 0.05); show.quickLook("calm-blue", ["w2"]);
  assert.equal(show.state.washes.w1.mode, "off");
  await wait(70);
  assert.equal(show.state.washes.w1.mode, "off");
  assert.deepEqual(show.state.washes.w4, peer);
});

test("real render worker handshake remains dark after queued Stop and emits only after explicit fresh Start", async (t) => {
  const rig = defaultRig(), settings = defaultSettings();
  const show = new ShowController(library, () => rig, () => settings);
  t.after(() => show.stop());
  const seen: number[] = [];
  const logs: string[] = [];
  show.engine.on("log", (line) => logs.push(line));
  show.engine.on("patternError", ({error}) => logs.push(error));
  show.engine.on("frame", (frame) => { seen.push(frame.colors[0]?.dim ?? 0); });
  show.start(); show.setPattern(pattern.id, {}, 0); show.stopLighting();
  await wait(150);
  assert.ok(seen.every((dim) => dim === 0));
  const lit = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Render worker did not emit fresh pattern: ${logs.join("; ")} state=${show.state.patternId} stopped=${show.state.stopped}`)), 2500);
    show.engine.on("frame", function onFrame(frame) {
      if (frame.colors[0]?.dim > 0) { clearTimeout(timer); show.engine.off("frame", onFrame); resolve(); }
    });
  });
  show.setPattern(pattern.id, {}, 0);
  await lit;
  show.stopLighting();
  const stoppedAt = seen.length;
  await wait(80);
  assert.ok(seen.slice(stoppedAt).every((dim) => dim === 0));
});
