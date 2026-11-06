import assert from "node:assert/strict";
import { test } from "node:test";
import { Engine } from "./engine.js";
import { defaultRig } from "../defaults.js";
import { defaultLaserState, type LaserState } from "../../../shared/src/index.js";
import type { FromWorker } from "./worker.js";

const source = (color: string) => `export default {render(ctx){ctx.fill('#ffffff');},lasers(){return [{color:'${color}',spread:${color === "red" ? 0 : 1}}];}}`;

test("worker generation and source/parameter revision guard loaded, frame and laser replies", (t) => {
  const engine = new Engine();
  const internal = engine as unknown as { ensureWorker(): void; post(message: unknown): void; generation: number; revision: number; onWorkerMessage(message: FromWorker): void };
  t.mock.method(internal, "ensureWorker", () => {});
  t.mock.method(internal, "post", () => {});
  engine.setRig(defaultRig());
  const loaded: number[] = [], lasers: LaserState[][] = [];
  engine.on("patternLoaded", (event) => loaded.push(event.revision));
  engine.on("lasers", (event) => lasers.push(event.states));
  engine.switchPattern("same", source("red"), {}, 0);
  const oldRevision = engine.patternRevision;
  engine.switchPattern("same", source("cyan"), {}, 0);
  const reply: FromWorker = { type: "loaded", slot: "a", id: "same", params: {}, usesLasers: true, laserLook: null, revision: engine.patternRevision, generation: engine.patternGeneration };
  internal.onWorkerMessage({ ...reply, revision: oldRevision });
  internal.onWorkerMessage({ ...reply, generation: engine.patternGeneration - 1 });
  assert.deepEqual(loaded, []);
  internal.onWorkerMessage(reply);
  assert.deepEqual(loaded, [engine.patternRevision]);
  const frame: FromWorker = { type: "frame", buf: new Float32Array(64).fill(1), errorA: null, errorB: null, renderMs: 1, logs: [], lasers: [{ ...defaultLaserState(), mode: "manual" }], revision: engine.patternRevision, generation: engine.patternGeneration };
  internal.onWorkerMessage({ ...frame, revision: oldRevision });
  internal.onWorkerMessage({ ...frame, generation: engine.patternGeneration - 1 });
  assert.deepEqual(lasers, []);
  engine.setParams({ amount: 2 });
  const parameterRevision = engine.patternRevision;
  internal.onWorkerMessage(frame);
  assert.deepEqual(lasers, [], "a newly followed parameter revision cannot accept an old rendered intent");
  internal.onWorkerMessage({ type: "paramsApplied", slot: "a", id: "same", params: {}, revision: parameterRevision, generation: engine.patternGeneration - 1 });
  assert.deepEqual(loaded, [reply.revision]);
  internal.onWorkerMessage({ type: "paramsApplied", slot: "a", id: "same", params: {}, revision: parameterRevision, generation: engine.patternGeneration });
  assert.deepEqual(loaded, [reply.revision, parameterRevision]);
  internal.onWorkerMessage({ ...frame, revision: parameterRevision, lasers: [] });
  assert.deepEqual(lasers, [[]], "empty output explicitly clears a previously emitting laser layer");
  engine.halt();
  internal.onWorkerMessage({ ...frame, revision: parameterRevision });
  internal.onWorkerMessage(reply);
  assert.deepEqual(lasers, [[]]);
  assert.equal(engine.fadeProgress, null);
});

function nextLasers(engine: Engine, accept: (states: LaserState[]) => boolean, timeout = 3500) {
  return new Promise<LaserState[]>((resolve, reject) => {
    const timer = setTimeout(() => { engine.off("lasers", listener); reject(new Error("Timed out waiting for in-memory worker laser reply")); }, timeout);
    const listener = (event: { states: LaserState[] }) => {
      if (!accept(event.states)) return;
      clearTimeout(timer); engine.off("lasers", listener); resolve(event.states);
    };
    engine.on("lasers", listener);
  });
}

test("real worker keeps laser state discrete through fades, empty sources and fresh recovery Start", async (t) => {
  const engine = new Engine();
  t.after(() => engine.stop());
  engine.setRig(defaultRig());
  engine.start(40);
  let response = nextLasers(engine, (states) => states[0]?.color === "red");
  engine.switchPattern("same", source("red"), {}, 0);
  assert.equal((await response)[0].pan, 48);
  const parametersApplied = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Parameter revision was not acknowledged")), 1000);
    engine.once("patternLoaded", (event) => { clearTimeout(timer); resolve(event.revision); });
  });
  engine.setParams({});
  assert.equal(await parametersApplied, engine.patternRevision);
  response = nextLasers(engine, (states) => states[0]?.color === "cyan");
  engine.switchPattern("same", source("cyan"), {}, 500);
  assert.equal((await response)[0].pan, 80, "incoming laser values never interpolate through outgoing bytes");
  response = nextLasers(engine, (states) => states.length === 0);
  engine.clearPattern(400);
  await response;
  assert.ok(engine.lastFrame!.colors[0].dim > 0 && engine.lastFrame!.colors[0].dim < 1, "outgoing washes fade while lasers are already off");
  response = nextLasers(engine, (states) => states.length === 0);
  engine.switchPattern("same", "export default {render(ctx){ctx.fill('#ffffff');}}", {}, 200);
  await response;
  response = nextLasers(engine, (states) => states[0]?.color === "red");
  engine.switchPattern("same", source("red"), {}, 0);
  await response;
  const generation = engine.patternGeneration;
  (engine as unknown as { restartWorker(): void }).restartWorker();
  response = nextLasers(engine, (states) => states[0]?.color === "cyan");
  engine.switchPattern("same", source("cyan"), {}, 0);
  await response;
  assert.ok(engine.patternGeneration > generation, "explicit fresh Start survives recovery backoff");
});
