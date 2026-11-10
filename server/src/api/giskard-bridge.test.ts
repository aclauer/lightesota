import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { test, type TestContext } from "node:test";
import express from "express";
import { config } from "../config.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { AgentService } from "../agent/agent.js";
import { createGiskardRouter } from "./giskard.js";
import { GiskardConnector, ReceiptLedger, RelayConnectionError, RelayGate, backendTransport, cloudTransport } from "../integrations/giskard-relay.js";

// The deployable relay is intentionally a separate JavaScript package, with no HA SDK dependency.
const { handler } = await import(new URL("../../../integrations/giskard-relay/http.js", import.meta.url).href);
const { Relay } = await import(new URL("../../../integrations/giskard-relay/relay.js", import.meta.url).href);
const { memoryHttp, Store, env, body } = await import(new URL("../../../integrations/giskard-relay/test/support.js", import.meta.url).href);
const sockets = process.env.BRIDGE_LOOPBACK_TEST === "1";
const token = "synthetic-backend-only-token-1234567890";

async function endpoint(t: TestContext, handle: http.RequestListener) {
  if (!sockets) return { port: 8787, call: (options: any) => memoryHttp(handle, options) };
  const server = http.createServer(handle);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as { port: number }).port;
  const call = (options: any) => new Promise<any>((resolve, reject) => {
    const raw = options.raw ?? JSON.stringify(options.body), headers = { authorization: `Bearer ${options.token ?? env.GISKARD_RELAY_TOKEN}`,
      "content-type": "application/json", "content-length": String(Buffer.byteLength(raw)), ...options.headers };
    const req = http.request({ hostname: "127.0.0.1", port, path: options.path, method: options.method ?? "POST", headers, signal: options.signal }, res => {
      const chunks: Buffer[] = []; res.on("data", c => chunks.push(c));
      res.on("end", () => { const raw = Buffer.concat(chunks); resolve({ status: res.statusCode, raw, body: JSON.parse(raw.toString()), headers: res.headers }); });
      res.on("error", reject);
    }); req.on("error", reject);
    if (options.beforeBody) { req.flushHeaders(); Promise.resolve(options.beforeBody()).then(() => req.end(raw), reject); }
    else req.end(raw);
  });
  return { port, call };
}

async function harness(t: TestContext, hook?: (action: string, deliver: () => Promise<any>) => Promise<any>, timing?: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void> },
  cloudHook?: (route: string, data: any, deliver: () => Promise<any>) => Promise<any>, inference?: typeof fetch) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "giskard-bridge-")); config.dataDir = directory;
  const library = new Library(), rig = defaultRig(), settings = defaultSettings();
  const show = new ShowController(library, () => rig, () => settings); show.engine.setRig(rig);
  const gate = new RelayGate(timing?.now), app = express(); let stops = 0;
  if (inference) { fs.mkdirSync(path.join(directory, "agent")); fs.mkdirSync(path.join(directory, "patterns")); }
  const agent = inference ? new AgentService({ library, show, getRig: () => rig, getSettings: () => settings,
    onPatternSaved: (id, live) => { if (live !== false) show.patternUpdated(id); } }, () => {}, { hermes: { fetch: inference } }) : { cancelAll() { stops++; } };
  const ctx = { show, rigFile: { get: () => rig }, agent };
  app.use("/api/integrations/giskard", createGiskardRouter(ctx, { relayGate: gate, now: timing?.now, audit() {}, policy: { preview: true, commissioned: false },
    env: { LIGHTESOTA_GISKARD_ENABLED: "1", LIGHTESOTA_GISKARD_TOKEN: token, LIGHTESOTA_GISKARD_TEAM_ID: env.GISKARD_RELAY_TEAM_ID,
      LIGHTESOTA_GISKARD_CHANNEL_ID: env.GISKARD_RELAY_CHANNEL_ID, LIGHTESOTA_GISKARD_USER_IDS: env.GISKARD_RELAY_USER_IDS } }));
  const backend = await endpoint(t, app), store = new Store(), relay = await endpoint(t, handler({ store, env, now: timing?.now }));
  const connectorConfig = { origin: "https://fixed-test.invalid", token: env.GISKARD_CONNECTOR_TOKEN, backendToken: token, port: backend.port, dataDir: directory };
  const counts: Record<string, number> = {};
  const connector = new GiskardConnector(connectorConfig, new ReceiptLedger(directory), gate,
    async (route, data, signal) => {
      const deliver = () => relay.call({ path: `/api/connector/${route}`, body: data, token: env.GISKARD_CONNECTOR_TOKEN, signal });
      const r = await (cloudHook ? cloudHook(route, data, deliver) : deliver());
      if (r.status !== 200) throw new RelayConnectionError(r.body.code); return r.body;
    }, timing?.now, async (action, data, signal, dispatch) => {
      counts[action] = (counts[action] ?? 0) + 1;
      const deliver = () => sockets ? backendTransport(connectorConfig)(action, data, signal, dispatch)
        : backend.call({ path: `/api/integrations/giskard/${action}`, body: data, token, signal, headers: { "x-lightesota-relay-dispatch": dispatch } });
      return hook ? hook(action, deliver) : deliver();
    }, timing?.sleep);
  const running = connector.start();
  t.after(async () => { connector.stop(); await running; show.stop(); library.flush(); fs.rmSync(directory, { recursive: true, force: true }); });
  for (let n = 0; n < 100 && !store.value?.session; n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(store.value?.session);
  const call = (action: string, data: unknown) => relay.call({ path: `/api/integrations/giskard/${action}`, body: data });
  return { call, counts, show, library, gate, store, backend, stops: () => stops, connector, running, directory, core: new Relay(store, timing?.now) };
}

test(`natural request bridge (${sockets ? "loopback sockets" : "Node HTTP streams"}): acceptance, owned status, real agent tools and Stop`, async t => {
  const reply = (name?: string, input?: unknown) => new Response([
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: name ? { tool_calls: [{ index: 0, id: "tool_one", type: "function", function: { name, arguments: JSON.stringify(input) } }] } : { content: "Applied; physical output unverified." }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: name ? "tool_calls" : "stop" }] })}\n\n`, "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } });
  let finish!: (value: Response) => void, round = 0;
  const h = await harness(t, undefined, undefined, undefined, async (_url, init) => {
    round++;
    if (round === 1 || round === 4) return new Promise(resolve => { finish = resolve; });
    if (round === 2) {
      const request = JSON.parse(String(init?.body)), saved = JSON.parse(request.messages.findLast((m: any) => m.role === "tool").content);
      return reply("apply_pattern", { id: saved.id, params: null, crossfadeMs: 0 });
    }
    return reply();
  });
  const who = body("natural-one"), lease = await h.call("lease", who);
  const command = { kind: "agent_request", prompt: "Make the lights shift from left to right" };
  const accepted = await h.call("apply", { ...who, leaseId: lease.body.leaseId, command });
  assert.equal(accepted.status, 202, JSON.stringify(accepted.body));
  assert.equal(accepted.body.request.status, "accepted");
  assert.equal((await h.call("state", { ...who, requestId: accepted.body.request.id })).body.request.status, "running");
  finish(reply("write_pattern", { id: null, source: 'export default { name: "Slack wave", render(ctx) { ctx.fill("#00ffff", {dim: .2}); } };' }));
  await new Promise(resolve => setImmediate(resolve));
  const completed = await h.call("state", { ...who, requestId: accepted.body.request.id });
  assert.equal(completed.body.request.status, "completed");
  assert.ok(h.library.getPattern(h.show.state.patternId!));
  assert.equal((await h.call("apply", { ...who, leaseId: lease.body.leaseId, command })).status, 409);
  const next = body("natural-two"), nextLease = await h.call("lease", next);
  assert.equal((await h.call("apply", { ...next, leaseId: nextLease.body.leaseId, command })).status, 202);
  assert.equal((await h.call("stop", body("stop-natural"))).status, 200);
  const before = structuredClone(h.show.state);
  finish(reply("set_master", { level: 1 })); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.show.state, before);
  assert.equal((await h.call("state", next)).body.request.status, "cancelled");
  assert.equal(h.counts.apply, 2);
});

test(`vertical bridge (${sockets ? "loopback sockets" : "Node HTTP streams"}): actual router state, lease, apply, Stop and no replay`, async t => {
  const h = await harness(t); const who = body("one");
  const state = await h.call("state", who); assert.equal(state.status, 200); assert.equal(state.body.state.ownership.physicalState, "unverified");
  const lease = await h.call("lease", who); assert.equal(lease.status, 200);
  const command = { kind: "set_lights", fixtureIds: ["w1"], brightness: 30, color: "#ff8800" };
  const applied = await h.call("apply", { ...who, leaseId: lease.body.leaseId, command });
  assert.equal(applied.status, 200); assert.equal(h.show.state.washes.w1.brightness, 77);
  assert.equal((await h.call("apply", { ...who, leaseId: lease.body.leaseId, command })).status, 409);
  const pending = await h.call("lease", body("pre-stop")); assert.equal(pending.status, 200);
  const stop = await h.call("stop", body("stop")); assert.equal(stop.status, 200); assert.equal(h.stops(), 1); assert.equal(h.show.state.stopped, true);
  assert.equal((await h.call("lease", body("pre-stop"))).status, 409);
  assert.equal((await h.call("apply", { ...body("pre-stop"), leaseId: pending.body.leaseId, command })).status, 409);
  assert.deepEqual(h.counts, { state: 1, lease: 2, apply: 1, stop: 1 });
});

test("uncertain apply after actual effect is never retried, including connector/backend restart receipts", async t => {
  const h = await harness(t, async (action, deliver) => { const response = await deliver(); if (action === "apply") throw new Error("synthetic lost response"); return response; });
  const who = body("uncertain"), lease = await h.call("lease", who);
  const data = { ...who, leaseId: lease.body.leaseId, command: { kind: "set_lights", fixtureIds: ["w1"], brightness: 20 } };
  const response = await h.call("apply", data); assert.equal(response.status, 503); assert.equal(h.counts.apply, 1);
  assert.equal(h.show.state.washes.w1.brightness, 51);
  assert.equal((await h.call("apply", data)).status, 409);
  h.connector.stop(); await h.running;
  const reopened = new ReceiptLedger(h.directory); assert.equal(reopened.claim("apply", who), false); assert.equal(reopened.claim("lease", who), false); reopened.close();
});

test("delivered backend bytes cannot execute after dispatch timeout or connector shutdown", async t => {
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>(r => { reached = r; });
  const held = new Promise<void>(r => { release = r; });
  const h = await harness(t, async (action, deliver) => { if (action === "lease") { reached(); await held; } return deliver(); });
  const request = h.call("lease", body("delayed")); await waiting;
  h.connector.stop(); release(); const result = await request;
  assert.notEqual(result.status, 200); assert.equal(h.counts.lease, 1);
  // The actual endpoint has no permit after stop, even if bytes escaped HTTP cancellation.
  const j = h.store.value.jobs.find((j: any) => j.action === "lease");
  const late = await h.backend.call({ path: "/api/integrations/giskard/lease", body: body("delayed"), token,
    headers: { "x-lightesota-relay-dispatch": j.id } });
  assert.equal(late.status, 409); assert.equal(late.body.code, "relay_expired");
});

test("actual protected router rejects path aliases and expired Stop before any effect", async t => {
  const h = await harness(t);
  for (const path of ["/api/integrations/giskard/stop/", "/api/integrations/giskard/STOP", "/api/integrations/giskard/%73top", "/api/integrations/giskard/stop?q=1"]) {
    assert.equal((await h.backend.call({ path, body: body("bad"), token })).status, 404);
  }
  const who = body("expired-stop"), id = "d".repeat(64);
  h.gate.open(id, "stop", who, performance.now() + 10, 1);
  assert.equal((await h.backend.call({ path: "/api/integrations/giskard/stop", body: who, token,
    headers: { "x-lightesota-relay-dispatch": id }, beforeBody: () => new Promise(r => setTimeout(r, 20)) })).status, 409);
  assert.equal(h.stops(), 0);
  const old = body("old-lease"), oldId = "e".repeat(64), stopId = "f".repeat(64);
  h.gate.open(oldId, "lease", old, performance.now() + 1000, 2);
  h.gate.open(stopId, "stop", who, performance.now() + 1000, 3);
  assert.equal((await h.backend.call({ path: "/api/integrations/giskard/stop", body: who, token, headers: { "x-lightesota-relay-dispatch": stopId } })).status, 200);
  assert.equal((await h.backend.call({ path: "/api/integrations/giskard/lease", body: old, token, headers: { "x-lightesota-relay-dispatch": oldId } })).status, 409);
  assert.equal(h.stops(), 1);
});

test("oversized backend response is refused without partial result or cached success", async t => {
  const h = await harness(t, async (action, deliver) => action === "state"
    ? { status: 200, raw: Buffer.alloc(65537, 32) } : deliver());
  const result = await h.call("state", body("oversized"));
  assert.equal(result.status, 503); assert.equal(result.body.ok, false);
  assert.equal(h.counts.state, 1);
});

// Advance the real connector loop without wall-clock outages or a parallel dispatch loop.
function manualTime() {
  let time = 100000, wake = () => {}, parked = () => {};
  let nextPark = new Promise<void>(resolve => { parked = resolve; });
  const sleep = async (_ms: number, signal: AbortSignal) => {
    if (signal.aborted) return;
    await new Promise<void>(resolve => {
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      wake = done; signal.addEventListener("abort", done, { once: true }); parked();
    });
  };
  return { now: () => time, sleep, advance(ms: number) { time += ms; }, ready: () => nextPark,
    async tick() { nextPark = new Promise(resolve => { parked = resolve; }); wake(); await nextPark; } };
}

test("lost result ACK abandons only that transfer; following state uses the original session without replay", async t => {
  // Exercise the real connector's transport error boundary without opening a socket.
  t.mock.method(https, "request", () => {
    const request = new EventEmitter() as http.ClientRequest;
    request.end = () => { queueMicrotask(() => request.emit("error", new Error("synthetic lost ACK"))); return request; };
    return request;
  });
  const lostReply = cloudTransport({ origin: "https://synthetic.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: "unused" });
  for (const mode of ["committed", "partial", "delayed"]) {
    const clock = manualTime(), sessions: string[] = [], uploads: any[] = [];
    let lose = true, delayed!: () => Promise<any>;
    const h = await harness(t, async (action, deliver) => {
      const reply = await deliver();
      return mode === "partial" && action === "stop" ? { ...reply, raw: Buffer.from(JSON.stringify({ ...reply.body, padding: "x".repeat(6000) })) } : reply;
    }, clock, async (route, data, deliver) => {
      if (route === "session") sessions.push(data.session);
      if (route === "result") uploads.push(data);
      if (route === "result" && lose) {
        lose = false;
        if (mode === "delayed") delayed = deliver;
        else await deliver();
        return lostReply(route, data, new AbortController().signal);
      }
      return deliver();
    });
    await clock.ready();
    const stopped = await h.core.admit("stop", body("stop-once")); await clock.tick();
    assert.equal(h.stops(), 1);
    assert.throws(() => h.gate.consume(stopped.id, "stop", body("stop-once")), "effect permit is closed before result upload");
    const result = await h.core.take(stopped.id);
    if (mode === "committed") assert.equal(result.status, 200, "caller can consume the committed Stop despite lost connector ACK");
    else assert.equal(result, null, "an incomplete transfer cannot acknowledge Stop");
    const state = await h.core.admit("state", body("after-stop")); await clock.tick();
    assert.equal(sessions.length, 1, "a lost result ACK must not replace a still-valid fenced session");
    assert.equal((await h.core.take(state.id)).status, 200);
    assert.deepEqual(h.counts, { stop: 1, state: 1 });
    assert.deepEqual(uploads.filter(u => u.id === stopped.id).map(u => u.index), [0], "neither a retry nor a later chunk may be sent");
    assert.ok(uploads.every(u => u.session === sessions[0]));
    if (mode === "partial") {
      clock.advance(5500);
      assert.equal((await h.core.take(stopped.id)).body.code, "outcome_unknown");
    }
    if (mode === "delayed") {
      clock.advance(5500);
      assert.equal((await h.core.take(stopped.id)).body.code, "outcome_unknown"); // Free the expired Stop slot through normal consumption.
      const newer = await h.core.admit("stop", body("newer-stop")); await clock.tick();
      assert.equal((await h.core.take(newer.id)).status, 200); assert.equal(h.stops(), 2);
      const late = await delayed();
      assert.equal(late.status, 409); assert.equal(late.body.code, "expired", "a delayed old result cannot cross a newer Stop fence");
    }
    h.connector.stop(); await h.running;
    const persisted = new ReceiptLedger(h.directory);
    assert.equal(persisted.claim("stop", body("stop-once")), false); persisted.close();
  }
});

test("outage after ambiguous apply result rotates session and never retries work; expired old lease/Stop receipts survive redeploy", async t => {
  const clock = manualTime(), sessions: string[] = [];
  let dropResult = false, resultPosts = 0;
  const h = await harness(t, undefined, clock, async (route, data, deliver) => {
    if (route === "session") sessions.push(data.session);
    if (route === "result") {
      resultPosts++;
      if (dropResult) { dropResult = false; h.store.ambiguous = true; }
    }
    return deliver();
  });
  await clock.ready();
  const complete = async (action: string, data: unknown) => {
    const job = await h.core.admit(action, data); await clock.tick(); return h.core.take(job.id);
  };
  const who = body("before-outage"), lease = await complete("lease", who);
  const applied = { ...who, leaseId: lease.body.leaseId, command: { kind: "set_lights", fixtureIds: ["w1"], brightness: 20 } };
  dropResult = true;
  const apply = await h.core.admit("apply", applied); await clock.tick();
  assert.equal(h.show.state.washes.w1.brightness, 51); assert.equal(h.counts.apply, 1);
  assert.throws(() => h.gate.consume(apply.id, "apply", applied), "lost session closes its local permit");
  const before = resultPosts, oldSession = sessions[0];
  // Simulate complete cloud unavailability beyond both the session and temporary dedup lifetime.
  clock.advance(180000); await clock.tick();
  assert.equal(sessions.length, 2); assert.notEqual(sessions[1], oldSession);
  assert.equal(resultPosts, before, "recovery must not reupload an uncertain result");
  const redeployed = new Relay(h.store, clock.now);
  await assert.rejects(redeployed.connector("poll", { session: oldSession }), /session_expired/);
  assert.equal((await redeployed.take(apply.id)).body.code, "outcome_unknown");
  await assert.rejects(redeployed.admit("apply", applied), /invalid_lease/);
  assert.equal((await complete("lease", who)).status, 503);
  assert.equal(h.counts.lease, 1, "HA permanently denies reacquisition of the attempted old lease");
  assert.equal((await complete("lease", body("fresh-after-outage"))).status, 200);
  assert.equal((await complete("stop", body("stop-once"))).status, 200);
  assert.equal(h.stops(), 1);
  clock.advance(180000); await clock.tick(); await clock.tick(); // Local TTL expires; new fenced session.
  assert.equal((await complete("stop", body("stop-once"))).status, 503);
  assert.equal(h.stops(), 1, "temporary cloud expiry cannot repeat a Stop at HA");
  assert.equal((await complete("state", body("healthy"))).status, 200);
  assert.deepEqual(h.counts, { lease: 2, apply: 1, stop: 1, state: 1 });
});

test("more than 2048 completed lease flows keep cloud history bounded; expired cloud dedup cannot renew HA authority", async t => {
  const clock = manualTime(), h = await harness(t, undefined, clock);
  await clock.ready();
  let largest = 0;
  for (let n = 0; n < 2055; n++) {
    const job = await h.core.admit("lease", body(`volume-${n}`));
    largest = Math.max(largest, Buffer.byteLength(JSON.stringify(h.store.value)));
    await clock.tick();
    largest = Math.max(largest, Buffer.byteLength(JSON.stringify(h.store.value)));
    const response = await h.core.take(job.id);
    assert.equal(response?.status, 200, `lease flow ${n} must complete`);
    largest = Math.max(largest, Buffer.byteLength(JSON.stringify(h.store.value)));
    clock.advance(3000); // Twenty eligible model turns/minute, including actual HA receipt commits.
  }
  assert.equal(h.counts.lease, 2055);
  assert.ok(h.store.value.receipts.ordinary.length < 64);
  assert.ok(largest < 50000, `mailbox grew to ${largest} bytes`);
  const duplicate = await h.core.admit("lease", body("volume-0"));
  await clock.tick();
  assert.equal((await h.core.take(duplicate.id)).status, 503);
  assert.equal(h.counts.lease, 2055, "permanent HA receipt must prevent a new backend lease after cloud dedup expiry");
  t.diagnostic(`2055 completed leases; peak mailbox ${largest} bytes; ${h.store.value.receipts.ordinary.length} temporary ordinary receipts at end`);
});
