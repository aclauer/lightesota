// Worker thread: compiles patterns in a vm sandbox and renders frames on request.
import { parentPort } from "node:worker_threads";
import { compilePattern, OUT_STRIDE, PatternInstance, type SandboxFixture } from "./sandbox.js";
import type { ParamValues } from "@lightesota/shared";

export type ToWorker =
  | { type: "load"; slot: "a" | "b"; id: string; source: string; params?: ParamValues; seed: number }
  | { type: "move"; from: "a"; to: "b" }          // current becomes outgoing
  | { type: "unload"; slot: "a" | "b" }
  | { type: "params"; slot: "a" | "b"; params: ParamValues }
  | { type: "fixtures"; fixtures: SandboxFixture[] }
  | { type: "render"; dt: number; bpm: number; beat: number; mix: number };

export type FromWorker =
  | { type: "loaded"; slot: "a" | "b"; id: string; params: ParamValues }
  | { type: "loadError"; slot: "a" | "b"; id: string; error: string }
  | { type: "frame"; buf: Float32Array; errorA: string | null; errorB: string | null; renderMs: number; logs: string[] };

let fixtures: SandboxFixture[] = [];
const slots: { a: PatternInstance | null; b: PatternInstance | null } = { a: null, b: null };
let logs: string[] = [];
const log = (...a: unknown[]) => { if (logs.length < 10) logs.push(a.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(" ")); };

if (!parentPort) throw new Error("worker must be run as a worker thread");
const port = parentPort;

port.on("message", (msg: ToWorker) => {
  switch (msg.type) {
    case "fixtures":
      fixtures = msg.fixtures;
      slots.a?.setFixtures(fixtures);
      slots.b?.setFixtures(fixtures);
      break;
    case "load": {
      try {
        const compiled = compilePattern(msg.source, { timeoutMs: 1000, log });
        const inst = new PatternInstance(compiled, fixtures, msg.params, msg.seed, log);
        if (inst.error) throw new Error(inst.error);
        slots[msg.slot] = inst;
        port.postMessage({ type: "loaded", slot: msg.slot, id: msg.id, params: inst.params } satisfies FromWorker);
      } catch (e) {
        port.postMessage({ type: "loadError", slot: msg.slot, id: msg.id, error: (e as Error).message } satisfies FromWorker);
      }
      break;
    }
    case "move":
      slots.b = slots.a;
      slots.a = null;
      break;
    case "unload":
      slots[msg.slot] = null;
      break;
    case "params":
      slots[msg.slot]?.setParams(msg.params);
      break;
    case "render": {
      const t0 = performance.now();
      const n = Math.max(1, fixtures.length);
      const buf = new Float32Array(n * OUT_STRIDE);
      const a = slots.a, b = slots.b;
      if (a) a.render(msg.dt, msg.bpm, msg.beat);
      if (b) b.render(msg.dt, msg.bpm, msg.beat);
      const mix = a && b ? msg.mix : a ? 1 : 0;
      if (a && b) {
        for (let i = 0; i < buf.length; i++) buf[i] = b.out[i] * (1 - mix) + a.out[i] * mix;
        // Crossfading two dim values multiplied by colors is not linear in light; blend the
        // *lit* color instead so the fade looks even.
        for (let f = 0; f < fixtures.length; f++) {
          const o = f * OUT_STRIDE;
          const da = a.out[o + 6], db = b.out[o + 6];
          for (let c = 0; c < 6; c++) buf[o + c] = b.out[o + c] * db * (1 - mix) + a.out[o + c] * da * mix;
          buf[o + 6] = 1;
          buf[o + 7] = mix < 0.5 ? b.out[o + 7] : a.out[o + 7];
        }
      } else if (a) buf.set(a.out);
      else if (b) buf.set(b.out);
      const out: FromWorker = { type: "frame", buf, errorA: a?.error ?? null, errorB: b?.error ?? null, renderMs: performance.now() - t0, logs };
      logs = [];
      port.postMessage(out, [buf.buffer]);
      break;
    }
  }
});
