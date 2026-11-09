import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import type { Socket } from "node:net";
import { test, type TestContext } from "node:test";
import express, { type Request, type Response } from "express";
import { config } from "../config.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { createGiskardApi, createGiskardRouter, type GiskardOptions } from "./giskard.js";
import { Auth } from "./auth.js";

const token = "giskard-isolated-test-token-1234567890";
const identity = { teamId: "TTEST123", channelId: "C0CB4RFQ55Y", userId: "UTEST123", turnId: "event-123" };
const env = {
  LIGHTESOTA_GISKARD_ENABLED: "1", LIGHTESOTA_GISKARD_TOKEN: token,
  LIGHTESOTA_GISKARD_TEAM_ID: identity.teamId, LIGHTESOTA_GISKARD_CHANNEL_ID: identity.channelId,
  LIGHTESOTA_GISKARD_USER_IDS: identity.userId + ",WTEST456",
};
function harness(t: TestContext, options: GiskardOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightesota-giskard-"));
  config.dataDir = dir;
  const library = new Library(), rig = defaultRig(), settings = defaultSettings();
  rig.fixtures.push({ id: "hue-test", profileId: "hue-color-light", name: "Virtual Hue", enabled: true, tags: ["right"], x: 1, y: 1, rotation: 0, hueLightId: "test-only" });
  const show = new ShowController(library, () => rig, () => settings);
  show.engine.setRig(rig);
  let cancelled = 0, now = 100_000;
  const ctx = { show, rigFile: { get: () => rig }, agent: { cancelAll: () => { cancelled++; } } };
  const audit: unknown[] = [];
  const makeApi = (extra: GiskardOptions = {}) => createGiskardApi(ctx, { env, now: () => now, policy: { preview: true, commissioned: false }, audit: (event) => audit.push(event), ...options, ...extra });
  const api = makeApi();
  const call = (action: "state" | "lease" | "apply" | "stop", body: unknown = { identity }, header: string | undefined = `Bearer ${token}`, target = api, remoteAddress = "127.0.0.1") => {
    const req = { headers: { authorization: header, "content-type": "application/json" }, body, socket: { remoteAddress }, secure: false } as Request;
    const res = { code: 200, body: undefined as any, status(n: number) { this.code = n; return this; }, json(v: unknown) { this.body = v; return this; }, setHeader() {} };
    target.handle(action, req, res as unknown as Response);
    return res;
  };
  const lease = (who = identity) => { const r = call("lease", { identity: who }); assert.equal(r.code, 200, JSON.stringify(r.body)); return r.body.leaseId as string; };
  const apply = (command: unknown, who = identity, leaseId = lease(who)) => call("apply", { identity: who, leaseId, command });
  t.after(() => { show.stop(); library.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { ctx, show, rig, settings, api, makeApi, call, lease, apply, audit, advance: (ms: number) => { now += ms; }, cancelled: () => cancelled };
}

/** Real Express parsing over in-memory streams. No listener, network, worker, index.ts or output driver. */
async function inMemoryHttp(app: express.Express, raw: string, url = "/api/integrations/giskard/state", headers: Record<string, string> = {}, beforeBody?: (req: IncomingMessage, res: ServerResponse) => void) {
  const chunks: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }) as Socket;
  Object.defineProperty(socket, "remoteAddress", { value: "127.0.0.1" });
  const req = new IncomingMessage(socket);
  req.method = "POST"; req.url = url;
  req.headers = { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": String(Buffer.byteLength(raw)), ...headers };
  const res = new ServerResponse(req); res.assignSocket(socket);
  const finished = new Promise<void>((resolve, reject) => { res.once("finish", resolve); res.once("error", reject); });
  app(req, res); beforeBody?.(req, res); req.push(raw); req.push(null); await finished;
  socket.destroy();
  const body = Buffer.concat(chunks).toString().split("\r\n\r\n").slice(1).join("\r\n\r\n");
  return { code: res.statusCode, body: JSON.parse(body), headers: res.getHeaders() };
}

test("Giskard is default disabled and requires dedicated bearer even on localhost", (t) => {
  const h = harness(t);
  assert.equal(h.call("state", { identity }, `Bearer ${token}`, h.makeApi({ env: {} })).code, 404);
  for (const header of ["", "Basic wrong", "Bearer wrong", "Bearer fake-admin-test-only"]) assert.equal(h.call("state", { identity }, header).code, 401);
  assert.equal(h.call("state", { identity }, `Bearer ${token}`, h.api, "10.10.0.20").code, 403);
  fs.writeFileSync(path.join(config.dataDir, "auth.json"), JSON.stringify({ adminToken: "fake-admin-test-only", guestToken: "fake-guest-test-only" }));
  const auth = new Auth(() => h.settings);
  assert.equal(auth.roleForBearer({ headers: { authorization: `Bearer ${token}` } } as any), null);
  assert.equal(auth.roleForToken(token, "127.0.0.1"), "viewer");
});

test("Giskard bearer stays scoped even if accidentally reused as a browser/admin or guest credential", (t) => {
  const h = harness(t);
  const prior = process.env.LIGHTESOTA_GISKARD_TOKEN, priorOverride = config.adminTokenOverride;
  process.env.LIGHTESOTA_GISKARD_TOKEN = token;
  t.after(() => { if (prior === undefined) delete process.env.LIGHTESOTA_GISKARD_TOKEN; else process.env.LIGHTESOTA_GISKARD_TOKEN = prior; config.adminTokenOverride = priorOverride; });
  fs.writeFileSync(path.join(config.dataDir, "auth.json"), JSON.stringify({ adminToken: token, guestToken: token }));
  config.adminTokenOverride = token;
  const auth = new Auth(() => h.settings);
  assert.equal(auth.roleForBearer({ headers: { authorization: `Bearer ${token}` } } as any), null);
  assert.equal(auth.roleForRequest({ headers: { cookie: `lt_token=${token}` }, socket: { remoteAddress: "127.0.0.1" } } as any), "viewer");
  assert.equal(auth.roleForToken(token, "127.0.0.1"), "viewer");
  assert.equal(h.call("state").code, 200);
});

test("configuration and exact trusted identities fail closed; no public configuration or private history", (t) => {
  const h = harness(t);
  for (const key of ["LIGHTESOTA_GISKARD_TOKEN", "LIGHTESOTA_GISKARD_TEAM_ID", "LIGHTESOTA_GISKARD_CHANNEL_ID", "LIGHTESOTA_GISKARD_USER_IDS"]) {
    const invalid = { ...env, [key]: "" };
    assert.equal(h.call("state", { identity }, `Bearer ${token}`, h.makeApi({ env: invalid })).code, 503);
  }
  for (const users of ["*", "UTEST123,*", "someone", "UTEST123,"]) assert.equal(h.call("state", { identity }, `Bearer ${token}`, h.makeApi({ env: { ...env, LIGHTESOTA_GISKARD_USER_IDS: users } })).code, 503);
  for (const spoof of [{ teamId: "TOTHER" }, { channelId: "COTHER" }, { userId: "UOTHER" }]) assert.equal(h.call("state", { identity: { ...identity, ...spoof } }).code, 403);
  for (const body of [{ identity: { ...identity, admin: true } }, { identity, config: true }, { identity: { ...identity, turnId: "" } }]) assert.equal(h.call("state", body).code, 400);
  const r = h.call("state"); assert.equal(r.code, 200);
  assert.deepEqual(r.body.state.fixtures.map((f: any) => f.id), ["w1", "w2", "w3", "w4", "hue-test"]);
  assert.equal(r.body.state.preview, true); assert.equal(r.body.state.commissioned, false);
  assert.equal(r.body.state.ownership.physicalState, "unverified");
  assert.equal(JSON.stringify(r.body).includes(token), false);
  for (const key of ["rig", "settings", "history", "lasers", "haze", "username", "hueLightId"]) assert.equal(Object.hasOwn(r.body.state, key), false);
});

test("set_lights is sticky, preserves brightness-only color/mode, and changes only selected fixtures", (t) => {
  const h = harness(t);
  h.show.setWash(["w1"], { mode: "music6", brightness: 38 });
  const originalColor = [...h.show.state.washes.w1.rgbw], peer = structuredClone(h.show.state.washes.w2);
  assert.equal(h.apply({ kind: "set_lights", fixtureIds: ["w1"], brightness: 40 }).code, 200);
  assert.deepEqual(h.show.state.washes.w1.rgbw, originalColor); assert.equal(h.show.state.washes.w1.mode, "music6");
  assert.equal(h.show.state.washes.w1.brightness, 102); assert.equal(h.show.state.washes.w1.owner, "manual");
  assert.deepEqual(h.show.state.washes.w2, peer);
  const next = { ...identity, turnId: "color-turn" };
  assert.equal(h.apply({ kind: "set_lights", fixtureIds: ["w1", "hue-test"], brightness: 50, color: "#12ABef" }, next).code, 200);
  assert.equal(h.show.state.washes.w1.mode, "normal"); assert.deepEqual(h.show.state.washes.w1.rgbw, [18, 171, 239, 0]);
  assert.equal(h.show.state.overrides["hue-test"].dim, 0.5);
  const hueColor = h.show.state.overrides["hue-test"].r;
  assert.equal(h.apply({ kind: "set_lights", fixtureIds: ["hue-test"], brightness: 25 }, { ...identity, turnId: "hue-dim" }).code, 200);
  assert.equal(h.show.state.overrides["hue-test"].r, hueColor); assert.equal(h.show.state.overrides["hue-test"].dim, 0.25);
});

test("Giskard exposes saved gradient IDs once and applies a wash/strip batch with brightness-only color retention", (t) => {
  const h = harness(t);
  const strip = { id: "strip", name: "Gradient strip", profileId: "hue-gradient-strip", hueLightId: "fake-strip", x: 5, y: 7, rotation: 0, tags: ["strip"], enabled: true };
  h.rig.fixtures.push(strip);
  h.show.engine.setRig(h.rig);
  const raw = new Float32Array(10 * 8);
  for (let i = 5; i < 10; i++) { raw[i * 8] = 0.25; raw[i * 8 + 1] = 0.5; raw[i * 8 + 2] = 0.75; raw[i * 8 + 6] = 0.6; }
  (h.show.engine as unknown as { publishFrame(raw: Float32Array): void }).publishFrame(raw);
  const snapshot = h.call("state").body.state;
  assert.deepEqual(snapshot.fixtures.map((f: { id: string }) => f.id), ["w1", "w2", "w3", "w4", "hue-test", "strip"]);
  assert.equal(snapshot.lights.filter((f: { fixtureId: string }) => f.fixtureId === "strip").length, 1);
  const result = h.apply({ kind: "set_lights", fixtureIds: ["w1", "strip"], brightness: 25 });
  assert.equal(result.code, 200, JSON.stringify(result.body));
  assert.equal(h.show.state.washes.w1.brightness, 64);
  assert.deepEqual(h.show.state.overrides.strip, { r: 0.25, g: 0.5, b: 0.75, w: 0, a: 0, uv: 0, mix: 1, dim: 0.25 });
  assert.ok(h.show.engine.lastFrame!.colors.slice(-5).every((c) => c.r === 0.25 && c.g === 0.5 && c.b === 0.75 && c.dim === 0.25));
  h.rig.fixtures.push({ ...strip });
  assert.equal(h.call("state").body.state.fixtures.filter((f: { id: string }) => f.id === "strip").length, 1, "duplicate saved identity must not produce duplicate integration targets");
});

test("Giskard rejects virtual segments and unknown profiles before any selected wash changes", (t) => {
  const h = harness(t);
  const strip = { id: "strip", name: "Gradient strip", profileId: "hue-gradient-strip", hueLightId: "fake-strip", x: 5, y: 7, rotation: 0, tags: [], enabled: true };
  h.rig.fixtures.push(strip, { ...strip, id: "unknown", profileId: "unknown-profile" });
  h.show.engine.setRig(h.rig);
  const leaseId = h.lease(), before = JSON.stringify(h.show.state);
  for (const target of ["strip#0", "unknown", "l1", "h1"]) {
    const result = h.apply({ kind: "set_lights", fixtureIds: ["w1", target], brightness: 20 }, identity, leaseId);
    assert.equal(JSON.stringify(h.show.state), before, `${target} must not partially change a wash batch`);
    assert.equal(result.code, 400, `${target}: ${JSON.stringify(result.body)}`);
  }
  assert.equal(h.apply({ kind: "set_lights", fixtureIds: ["w1", "strip"], brightness: 20, color: "#123456" }, identity, leaseId).code, 200, "rejected validation does not consume the lease");
});

test("all targets and fields validate before any changes; hazards, raw channels and code are excluded", (t) => {
  const h = harness(t); const leaseId = h.lease(); const before = JSON.stringify(h.show.state);
  for (const command of [
    { kind: "set_lights", fixtureIds: ["w1", "l1"], brightness: 10 },
    { kind: "set_lights", fixtureIds: ["w1", "h1"], brightness: 10 },
    { kind: "set_lights", fixtureIds: ["w1", "s1"], brightness: 10 },
    { kind: "set_lights", fixtureIds: ["w1", "missing"], brightness: 10 },
    { kind: "set_lights", fixtureIds: ["w1", "w1"], brightness: 10 },
    { kind: "set_lights", fixtureIds: ["w1"], brightness: 101 },
    { kind: "set_lights", fixtureIds: ["w1"], brightness: 10, strobe: 1 },
    { kind: "set_lights", fixtureIds: ["w1"], brightness: 10, color: "red" },
    { kind: "wash_mode", fixtureIds: ["hue-test"], mode: "normal" },
    { kind: "wash_mode", fixtureIds: ["w1"], mode: "music6", sensitivity: 10 },
    { kind: "quick_look", fixtureIds: ["w1"], lookId: "laser-duo" },
    { kind: "quick_look", fixtureIds: ["w1"], lookId: "music6" },
    { kind: "eval", source: "console.log('unsafe')" },
    { kind: "set_lights", fixtureIds: ["w1"], brightness: 10, url: "http://example.invalid" },
  ]) {
    assert.equal(h.apply(command, identity, leaseId).code, 400);
    assert.equal(JSON.stringify(h.show.state), before);
  }
  assert.equal(h.apply({ kind: "set_lights", fixtureIds: ["w1"], brightness: 20 }, identity, leaseId).code, 200);
});

test("a lease is bound to exact actor, turn, one mutation and original generation", (t) => {
  const h = harness(t); const first = h.call("lease"); const leaseId = first.body.leaseId;
  h.advance(1_000);
  const repeated = h.call("lease"); assert.equal(repeated.body.leaseId, leaseId); assert.equal(repeated.body.expiresAt, first.body.expiresAt);
  const command = { kind: "quick_look", fixtureIds: ["w1"], lookId: "calm-blue" };
  assert.equal(h.apply(command, { ...identity, userId: "WTEST456" }, leaseId).code, 409);
  assert.equal(h.apply(command, { ...identity, turnId: "another-turn" }, leaseId).code, 409);
  assert.equal(h.apply(command, identity, leaseId).code, 200);
  const after = JSON.stringify(h.show.state);
  assert.equal(h.apply(command, identity, leaseId).code, 409); assert.equal(h.call("lease").code, 409);
  assert.equal(JSON.stringify(h.show.state), after);
});

test("expired leases, restarted services and capacity never silently reacquire authority", (t) => {
  const h = harness(t, { maxLeases: 2 }); const leaseId = h.lease(); h.advance(120_000);
  const command = { kind: "set_lights", fixtureIds: ["w1"], brightness: 20 };
  assert.equal(h.apply(command, identity, leaseId).code, 409); assert.equal(h.call("lease").code, 409);
  assert.equal(h.call("apply", { identity, leaseId, command }, `Bearer ${token}`, h.makeApi()).code, 409);
  h.lease({ ...identity, turnId: "second" });
  assert.equal(h.call("lease", { identity: { ...identity, turnId: "third" } }).code, 503);
  assert.equal(h.call("state").code, 200); assert.equal(h.call("stop").code, 200);
});

test("UI/HA Stop and external takeover during slow inference defeat stale Slack actions", async (t) => {
  const h = harness(t); const leaseId = h.lease();
  await Promise.resolve(); // Represents an inference await after preflight captured the lease.
  h.show.setWash(["w2"], { mode: "music32", brightness: 31 });
  const command = { kind: "set_lights", fixtureIds: ["w1"], brightness: 20 };
  assert.equal(h.apply(command, identity, leaseId).code, 409);
  assert.equal(h.show.state.washes.w1.mode, "off"); assert.equal(h.show.state.washes.w2.mode, "music32");
  const who = { ...identity, turnId: "before-stop" }; const pending = h.lease(who);
  h.show.stopLighting();
  assert.equal(h.call("state", { identity: who }).code, 200);
  assert.equal(h.call("lease", { identity: who }).code, 409);
  assert.equal(h.apply(command, who, pending).code, 409); assert.equal(h.show.state.stopped, true);
});

test("commissioning, blackout and release block applies while state/Stop remain available", (t) => {
  const h = harness(t, { policy: { preview: false, commissioned: false } });
  const command = { kind: "quick_look", fixtureIds: ["w1"], lookId: "warm-arrival" };
  assert.equal(h.apply(command).code, 503); assert.equal(h.show.state.stopped, true);
  assert.equal(h.call("state").code, 200); assert.equal(h.call("stop").code, 200); assert.equal(h.cancelled(), 1);
  const permitted = h.makeApi({ policy: { preview: false, commissioned: true } });
  for (const flag of ["blackout", "released"] as const) {
    h.show.state[flag] = true;
    const who = { ...identity, turnId: flag };
    const leaseId = h.call("lease", { identity: who }, `Bearer ${token}`, permitted).body.leaseId;
    assert.equal(h.call("apply", { identity: who, leaseId, command }, `Bearer ${token}`, permitted).code, 409);
    assert.equal(h.show.state[flag], true);
    h.show.state[flag] = false;
  }
});

test("master-zero is reported honestly; wash mode and quick looks preserve other fixtures", (t) => {
  const h = harness(t); h.show.setMaster(0);
  const peer = structuredClone(h.show.state.washes.w2);
  const r = h.apply({ kind: "wash_mode", fixtureIds: ["w1"], mode: "music32", sensitivity: 37 });
  assert.equal(r.code, 200); assert.equal(r.body.state.master, 0); assert.equal(r.body.state.outputStatus, "master_zero");
  assert.equal(r.body.physicalOutput, "unverified"); assert.equal(r.body.preview, true);
  assert.equal(h.show.state.washes.w1.sensitivity, 37); assert.deepEqual(h.show.state.washes.w2, peer);
  assert.equal(h.apply({ kind: "quick_look", fixtureIds: ["w3"], lookId: "cyan-magenta" }, { ...identity, turnId: "look" }).code, 200);
  assert.deepEqual(h.show.state.washes.w3.rgbw, [255, 0, 255, 0]); assert.deepEqual(h.show.state.washes.w2, peer);
});

test("Stop cancels agents and pending effects, disarms hazards, and logs only scoped structured metadata", (t) => {
  const h = harness(t); const leaseId = h.lease();
  h.show.testFixture("w1"); h.show.state.lasers.armed = true; h.show.state.haze.armed = true;
  const r = h.call("stop"); assert.equal(r.code, 200); assert.equal(h.cancelled(), 1);
  assert.equal(h.show.state.stopped, true); assert.equal(h.show.state.lasers.armed, false); assert.equal(h.show.state.haze.armed, false);
  assert.equal(h.show.state.washes.w1.mode, "off");
  assert.equal(h.apply({ kind: "quick_look", fixtureIds: ["w1"], lookId: "calm-blue" }, identity, leaseId).code, 409);
  for (const entry of h.audit as Record<string, unknown>[]) assert.deepEqual(Object.keys(entry).sort(), ["actor", "command", "generation", "result", "targetIds"]);
  assert.equal(JSON.stringify(h.audit).includes(token), false); assert.equal(JSON.stringify(h.audit).includes(leaseId), false);
});

test("finite body and request budgets reject excess requests; Stop has a separate reserve", (t) => {
  const h = harness(t);
  assert.equal(h.call("state", { identity, padding: "x".repeat(9000) }).code, 413);
  for (let i = 0; i < 60; i++) assert.equal(h.call("state").code, 200);
  assert.equal(h.call("state").code, 429);
  for (let i = 0; i < 30; i++) assert.equal(h.call("stop").code, 200);
  assert.equal(h.call("stop").code, 429);
  h.advance(60_000); assert.equal(h.call("state").code, 200); assert.equal(h.call("stop").code, 200);
});

for (const action of ["state", "lease", "apply", "stop"] as const) {
  test(`bogus bearer bursts on ${action} cannot exhaust authenticated state or Stop budgets`, (t) => {
    const h = harness(t), max = action === "stop" ? 120 : 240;
    const rejected = Array.from({ length: max + 1 }, () => h.call(action, { identity }, "Bearer bogus").code);
    assert.equal(h.call(action === "stop" ? "stop" : "state").code, 200);
    assert.equal(h.call(action === "stop" ? "state" : "stop").code, 200);
    assert.ok(rejected.every((code) => code === 401));
  });
}

for (const action of ["state", "stop"] as const) {
  test(`unprotected transport bursts cannot exhaust authenticated ${action} budgets`, (t) => {
    const h = harness(t), max = action === "stop" ? 120 : 240;
    const rejected = Array.from({ length: max + 1 }, () => h.call(action, { identity }, `Bearer ${token}`, h.api, "10.10.0.20").code);
    assert.equal(h.call(action).code, 200);
    assert.ok(rejected.every((code) => code === 403));
  });
}

test("authenticated global budgets stay bounded across allowed users with a separate Stop reserve", (t) => {
  const users = [identity.userId, "WTEST456", "UTEST789", "UTESTABC", "UTESTDEF"];
  const h = harness(t, { env: { ...env, LIGHTESOTA_GISKARD_USER_IDS: users.join(",") } });
  for (const userId of users.slice(0, 4)) {
    for (let i = 0; i < 60; i++) assert.equal(h.call("state", { identity: { ...identity, userId } }).code, 200);
  }
  assert.equal(h.call("state", { identity: { ...identity, userId: users[4] } }).code, 429);
  for (const userId of users.slice(0, 4)) {
    for (let i = 0; i < 30; i++) assert.equal(h.call("stop", { identity: { ...identity, userId } }).code, 200);
  }
  assert.equal(h.call("stop", { identity: { ...identity, userId: users[4] } }).code, 429);
  h.advance(60_000); assert.equal(h.call("state").code, 200); assert.equal(h.call("stop").code, 200);
});

test("Express path enforces the smaller parser, sanitized parse errors and closed endpoint surface", async (t) => {
  const h = harness(t); const app = express();
  app.use("/api/integrations/giskard", createGiskardRouter(h.ctx, { env, audit() {} }));
  app.use(express.json({ limit: "5mb" }));
  const good = await inMemoryHttp(app, JSON.stringify({ identity }));
  assert.equal(good.code, 200); assert.equal(good.headers["cache-control"], "no-store");
  assert.equal(good.headers["access-control-allow-origin"], undefined);
  for (const raw of ["{ invalid secret", "null", "[]"]) {
    const bad = await inMemoryHttp(app, raw); assert.equal(bad.code, 400); assert.equal(JSON.stringify(bad.body).includes("secret"), false);
  }
  assert.equal((await inMemoryHttp(app, JSON.stringify({ identity, padding: "x".repeat(9000) }))).code, 413);
  assert.equal((await inMemoryHttp(app, JSON.stringify({ identity }), undefined, { "content-encoding": "gzip" })).code, 415);
  assert.equal((await inMemoryHttp(app, JSON.stringify({ identity }), undefined, { "content-type": "text/plain" })).code, 415);
  assert.equal((await inMemoryHttp(app, JSON.stringify({ identity }), "/api/integrations/giskard/eval")).code, 404);
});

test("request deadline ends once and a late parser callback cannot mutate", async (t) => {
  const h = harness(t); const app = express();
  app.use("/api/integrations/giskard", createGiskardRouter(h.ctx, { env, audit() {} }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const before = JSON.stringify(h.show.state);
  let lateHeaders = 0;
  const r = await inMemoryHttp(app, JSON.stringify({ identity }), "/api/integrations/giskard/stop", {}, (req, res) => {
    const setHeader = res.setHeader.bind(res);
    t.mock.method(res, "setHeader", (name: string, value: string | number | readonly string[]) => {
      if (res.headersSent) lateHeaders++;
      return setHeader(name, value);
    });
    t.mock.timers.tick(15_000);
    assert.equal(req.destroyed, true); assert.equal(res.writableEnded, true);
  });
  // Allow the destroyed request's body-parser error callback to finish.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(r.code, 408); assert.equal(lateHeaders, 0);
  assert.equal(h.cancelled(), 0); assert.equal(JSON.stringify(h.show.state), before);
});
