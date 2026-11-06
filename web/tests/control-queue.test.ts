import assert from "node:assert/strict";
import test from "node:test";
import type { ClientMessage } from "@lightesota/shared";
import { ControlQueue } from "../src/lib/control-queue.js";

function harness() {
  let generation = 10;
  const sent: { msg: ClientMessage; resolve: (value: unknown) => void; reject: (error: Error) => void }[] = [];
  const queue = new ControlQueue((msg) => new Promise((resolve, reject) => sent.push({ msg, resolve, reject })), () => generation);
  return { queue, sent, setGeneration: (next: number) => { generation = next; } };
}
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("rapid slider gestures coalesce and advance only through their own correlated acknowledgement", async () => {
  const h = harness();
  const first = h.queue.enqueue({ type: "setWash", fixtureIds: ["w1"], patch: { brightness: 10 } });
  const middle = h.queue.enqueue({ type: "setWash", fixtureIds: ["w1"], patch: { brightness: 20 } });
  const last = h.queue.enqueue({ type: "setWash", fixtureIds: ["w1"], patch: { brightness: 30 } });
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].msg.generation, 10);
  h.setGeneration(11);
  h.sent[0].resolve({ generation: 11 });
  await first;
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1].msg, { type: "setWash", fixtureIds: ["w1"], patch: { brightness: 30 }, generation: 11 });
  h.setGeneration(12);
  h.sent[1].resolve({ generation: 12 });
  await Promise.all([middle, last]);
});

test("external control changes discard queued gestures instead of upgrading them to another owner's generation", async () => {
  const h = harness();
  const first = h.queue.enqueue({ type: "setLaser", fixtureId: "l1", state: { pan: 64 } });
  const pending = h.queue.enqueue({ type: "setLaser", fixtureId: "l1", state: { pan: 80 } });
  const rejected = assert.rejects(pending, /Lighting changed/);
  h.setGeneration(12); // Our reply owns 11; another control already owns 12.
  h.sent[0].resolve({ generation: 11 });
  await Promise.all([first, rejected]);
  assert.equal(h.sent.length, 1);
});

test("Stop discards pending Start and a late acknowledgement cannot resurrect it", async () => {
  const h = harness();
  const first = h.queue.enqueue({ type: "setMaster", master: 0.5 });
  const pending = h.queue.enqueue({ type: "setLaser", fixtureId: "l1", state: { mode: "manual" } });
  const rejected = [assert.rejects(first, /Stop/), assert.rejects(pending, /Stop/)];
  h.queue.cancel("Stopped by Stop");
  h.setGeneration(12);
  h.sent[0].resolve({ generation: 11 });
  await Promise.all(rejected);
  await settle();
  assert.equal(h.sent.length, 1);
});

test("failed or disconnected requests discard the queue and explicit stale intent is never rebound", async () => {
  for (const reason of ["Stale control generation", "Disconnected: command result is unknown"]) {
    const h = harness();
    const first = h.queue.enqueue({ type: "setSpeed", speed: 1.2 });
    const pending = h.queue.enqueue({ type: "setSpeed", speed: 2 });
    const rejected = [assert.rejects(first, new RegExp(reason)), assert.rejects(pending, /canceled after a failed command/)];
    h.sent[0].reject(new Error(reason));
    await Promise.all(rejected);
    assert.equal(h.sent.length, 1);
    h.setGeneration(20);
    await assert.rejects(h.queue.enqueue({ type: "setPattern", patternId: "saved-before-stop", generation: 10 }), /Stale control generation/);
    assert.equal(h.sent.length, 1, "an async Save & apply must retain the generation of the original click");
  }
});

test("haze levels serialize and coalesce, while Start and disarm retain the generation barrier", async () => {
  const { isQueuedControl, isImmediateStop } = await import("../src/lib/control-queue.js");
  assert.equal(isQueuedControl({type:"setHaze",armed:true}),true);
  assert.equal(isQueuedControl({type:"setHaze",runSec:30}),true);
  assert.equal(isImmediateStop({type:"hazeOff"}),true);
  assert.equal(isImmediateStop({type:"setHaze",armed:false}),true);
  const h=harness();
  const first=h.queue.enqueue({type:"setHaze",fan:0.2});
  const middle=h.queue.enqueue({type:"setHaze",fan:0.3});
  const last=h.queue.enqueue({type:"setHaze",fan:0.4});
  const start=h.queue.enqueue({type:"setHaze",runSec:30});
  const startRejected=assert.rejects(start,/disarm/);
  h.setGeneration(11);h.sent[0].resolve({generation:11});await first;
  assert.deepEqual(h.sent[1].msg,{type:"setHaze",fan:0.4,generation:11});
  const rejects=[assert.rejects(middle,/disarm/),assert.rejects(last,/disarm/)];
  h.queue.cancel('haze disarm');h.setGeneration(12);h.sent[1].resolve({generation:11});
  await Promise.all([...rejects,startRejected]);await settle();assert.equal(h.sent.length,2);
});
