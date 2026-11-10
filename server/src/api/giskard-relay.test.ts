import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import https from "node:https";
import type http from "node:http";
import { EventEmitter } from "node:events";
import { GiskardConnector, ReceiptLedger, RelayConnectionError, RelayTransportError, RelayGate, connectorConfig, cloudTransport } from "../integrations/giskard-relay.js";

const { Relay } = await import(new URL("../../../integrations/giskard-relay/relay.js", import.meta.url).href);
const { Store } = await import(new URL("../../../integrations/giskard-relay/test/support.js", import.meta.url).href);

test("relay permit expires at the effect boundary and cannot be reused", () => {
  let now = 100;
  const gate = new RelayGate(() => now);
  const body = { identity: { turnId: "test" } };
  gate.open("a".repeat(64), "lease", body, 200, 1);
  now = 200;
  assert.throws(() => gate.consume("a".repeat(64), "lease", body));
  now = 100;
  gate.open("b".repeat(64), "stop", body, 200, 2);
  assert.throws(() => gate.open("c".repeat(64), "lease", body, 200, 1));
  gate.consume("b".repeat(64), "stop", body);
  assert.throws(() => gate.consume("b".repeat(64), "stop", body));
});

test("receipt commit survives crash windows and restart; duplicate lease/apply/Stop never dispatch twice", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-receipts-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = { identity: { teamId: "TTEST", channelId: "CTEST", userId: "UTEST", turnId: "event" } };
  let ledger = new ReceiptLedger(dir);
  ledger.observeMailbox();
  for (const action of ["lease", "apply", "stop"] as const) assert.equal(ledger.claim(action, body), true);
  // Crash point: committed claim, backend may or may not have executed; no completion record is needed.
  ledger.close(); ledger = new ReceiptLedger(dir);
  for (const action of ["lease", "apply", "stop"] as const) assert.equal(ledger.claim(action, body), false);
  assert.throws(() => new ReceiptLedger(dir), "exclusive lifetime lock must defeat a second instance");
  ledger.close();
  assert.equal(fs.statSync(path.join(dir, "giskard-relay.sqlite")).mode & 0o777, 0o600);
  const raw = fs.readFileSync(path.join(dir, "giskard-relay.sqlite"));
  assert.equal(raw.includes(Buffer.from("TTEST")), false);
});

test("ledger corruption, missing initialized database and capacity never silently reset replay protection", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-corrupt-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const body = { identity: { teamId: "TTEST", channelId: "CTEST", userId: "UTEST", turnId: "one" } };
  const ledger = new ReceiptLedger(dir, 1, 1);
  ledger.observeMailbox();
  assert.equal(ledger.claim("lease", body), true); assert.equal(ledger.claim("apply", body), false);
  assert.equal(ledger.claim("stop", body), true, "ordinary capacity cannot exhaust Stop storage");
  ledger.close();
  fs.writeFileSync(path.join(dir, "giskard-relay.sqlite"), "corrupt");
  assert.throws(() => new ReceiptLedger(dir));
  assert.equal(fs.readFileSync(path.join(dir, "giskard-relay.sqlite"), "utf8"), "corrupt");
  fs.unlinkSync(path.join(dir, "giskard-relay.sqlite"));
  assert.throws(() => new ReceiptLedger(dir));
  assert.equal(fs.existsSync(path.join(dir, "giskard-relay.sqlite")), false);
});

test("connector is disabled by default and accepts only a fixed HTTPS origin with distinct protected tokens", () => {
  assert.equal(connectorConfig({}, 8787, "/test"), null);
  const env = { LIGHTESOTA_GISKARD_ENABLED: "1", LIGHTESOTA_GISKARD_RELAY_ENABLED: "1",
    LIGHTESOTA_GISKARD_TOKEN: "backend-test-123456789012345678901234", LIGHTESOTA_GISKARD_CONNECTOR_TOKEN: "connector-test-123456789012345678901234",
    LIGHTESOTA_GISKARD_RELAY_ORIGIN: "https://relay.example.test" };
  assert.equal(connectorConfig(env, 8787, "/test")?.port, 8787);
  for (const origin of ["http://relay.example.test", "https://user:password@relay.example.test", "https://relay.example.test/", "https://relay.example.test/path", "https://relay.example.test?token=x", "https://relay.example.test#x"]) {
    assert.throws(() => connectorConfig({ ...env, LIGHTESOTA_GISKARD_RELAY_ORIGIN: origin }, 8787, "/test"));
  }
  assert.throws(() => connectorConfig({ ...env, LIGHTESOTA_GISKARD_CONNECTOR_TOKEN: env.LIGHTESOTA_GISKARD_TOKEN }, 8787, "/test"));
});

test("startup transport failure recovers with backoff and a new incarnation without releasing SQLite ownership", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-reconnect-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = new ReceiptLedger(dir), sessions: string[] = [], delays: number[] = [];
  let now = 100000;
  const connector = new GiskardConnector({ origin: "https://test.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir },
    ledger, new RelayGate(() => now), async (route, data: any) => {
      if (route === "session") {
        sessions.push(data.session);
        if (sessions.length === 1) throw new Error("synthetic startup timeout");
        return { ok: true, ttl: 30000 };
      }
      assert.throws(() => new ReceiptLedger(dir), "recovery must retain single connector ownership");
      connector.stop(); return { ok: true, ttl: 30000, job: null };
    }, () => now, async () => { assert.fail("recovery must not invent backend work"); },
    async (ms: number) => { delays.push(ms); now += ms; });
  await assert.doesNotReject(connector.start());
  assert.equal(sessions.length, 2); assert.notEqual(sessions[0], sessions[1]);
  assert.deepEqual(delays, [1000]);
});

test("only network events classify as lost ACKs; HTTP, malformed and oversized replies stay distinct", async t => {
  let mode = "";
  t.mock.method(https, "request", (_url: any, _options: any, respond: any) => {
    const request = new EventEmitter() as http.ClientRequest;
    request.end = () => {
      queueMicrotask(() => {
        if (mode === "network") { request.emit("error", new Error("synthetic private text")); return; }
        const response = new EventEmitter() as http.IncomingMessage;
        response.statusCode = ["http_aborted", "http_request_error", "unauthorized", "invalid_request", "outcome_unknown"].includes(mode) ? 503 : mode === "redirect" ? 302 : 200;
        response.headers = { "content-type": mode === "content_type" ? "text/plain" : "application/json", ...(mode === "encoded" ? { "content-encoding": "gzip" } : {}) };
        let destroyed = false;
        response.destroy = () => { destroyed = true; response.emit("aborted"); return response; };
        respond(response); if (destroyed) return;
        if (mode === "aborted" || mode === "http_aborted") { response.emit("aborted"); return; }
        if (mode === "http_request_error") { request.emit("error", new Error("synthetic private text")); return; }
        if (mode === "response_error") { response.emit("error", new Error("synthetic private text")); return; }
        response.emit("data", mode === "oversized" ? Buffer.alloc(65537) : Buffer.from(mode === "json" ? "invalid-json" : JSON.stringify({ ok: false, code: mode })));
        if (!destroyed) response.emit("end");
      });
      return request;
    };
    return request;
  });
  const cloud = cloudTransport({ origin: "https://synthetic.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: "unused" });
  for (mode of ["network", "aborted", "response_error", "http_aborted", "http_request_error", "redirect", "content_type", "encoded", "oversized", "json", "unauthorized", "invalid_request", "outcome_unknown"]) {
    const transport = ["network", "aborted", "response_error"].includes(mode);
    await assert.rejects(cloud("result", {}, new AbortController().signal), error => {
      assert.equal(error instanceof RelayTransportError, transport, mode);
      if (["unauthorized", "invalid_request", "outcome_unknown"].includes(mode)) assert.equal((error as RelayConnectionError).code, mode);
      assert.ok(!(error as Error).message.includes("synthetic private text"));
      return true;
    });
  }
});

test("lost ACK retention respects local expiry, shutdown, poll validation and definite result errors", async t => {
  let timedOut: AbortController | undefined;
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => timedOut && ms === 1000 ? timedOut.signal : realTimeout(ms));
  for (const mode of ["timeout", "local_expiry", "shutdown", "poll_expired", "poll_invalid", "result_expired", "unauthorized", "invalid_request", "mailbox_invalid", "outcome_unknown", "unclassified"]) {
    timedOut = mode === "timeout" ? new AbortController() : undefined;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ack-boundary-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const who = { identity: { teamId: "TTEST", channelId: "CTEST", userId: "UTEST", turnId: "stop" } }, id = "d".repeat(64);
    let now = 100000, polls = 0, uploads = 0, effects = 0, sessions = 0;
    const delays: number[] = [], gate = new RelayGate(() => now);
    const connector = new GiskardConnector({ origin: "https://synthetic.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir },
      new ReceiptLedger(dir), gate, async route => {
        if (route === "session") { sessions++; return { ok: true, ttl: 30000 }; }
        if (route === "poll") {
          if (++polls === 1) return { ok: true, ttl: 30000, job: { id, action: "stop", body: who, fence: 1, ttl: 3500 } };
          if (mode === "poll_expired" || mode === "poll_invalid") throw new RelayConnectionError(mode === "poll_expired" ? "session_expired" : "invalid_request");
          connector.stop(); return { ok: true, ttl: 30000, job: null };
        }
        uploads++;
        if (mode === "timeout") { timedOut!.abort(); return { ok: true }; } // Transport settles after its deadline.
        if (mode === "local_expiry") now += 30000;
        if (mode === "shutdown") connector.stop();
        if (["local_expiry", "shutdown", "poll_expired", "poll_invalid"].includes(mode)) throw new RelayTransportError();
        if (mode === "unclassified") throw new Error("synthetic unclassified failure");
        throw new RelayConnectionError(mode === "result_expired" ? "expired" : mode);
      }, () => now, async (action, data, _signal, dispatch) => {
        gate.consume(dispatch, action, data); effects++; return { status: 200, raw: Buffer.from('{"ok":true}') };
      }, async ms => { delays.push(ms); now += ms; if (ms >= 1000) connector.stop(); });
    const terminal = ["poll_invalid", "unauthorized", "invalid_request", "mailbox_invalid"].includes(mode);
    if (terminal) await assert.rejects(connector.start(), RelayConnectionError);
    else await connector.start();
    assert.equal(effects, 1); assert.equal(uploads, 1); assert.equal(sessions, 1);
    assert.throws(() => gate.consume(id, "stop", who));
    const polledAgain = ["timeout", "poll_expired", "poll_invalid", "result_expired"].includes(mode);
    assert.equal(polls, polledAgain ? 2 : 1, mode);
    assert.deepEqual(delays, mode === "poll_expired" ? [100, 1000] : ["timeout", "poll_invalid", "result_expired"].includes(mode) ? [100]
      : ["local_expiry", "outcome_unknown", "unclassified"].includes(mode) ? [1000] : [], mode);
  }
});

test("pending first initialization survives process restart; confirmed empty ledger never recreates a lost mailbox", async t => {
  for (const failure of ["unauthorized", "disabled", "unavailable"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-pending-restart-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const config = { origin: "https://test.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir };
    let now = 100000;
    const first = new GiskardConnector(config, new ReceiptLedger(dir), new RelayGate(() => now),
      async () => { throw new RelayConnectionError(failure); }, () => now,
      async () => { assert.fail("startup failure cannot dispatch"); }, async () => { first.stop(); });
    if (failure === "unavailable") await first.start();
    else await assert.rejects(first.start(), RelayConnectionError);

    const store = new Store(), relay = new Relay(store, () => now), flags: boolean[] = [];
    const secondLedger = new ReceiptLedger(dir);
    const second = new GiskardConnector(config, secondLedger, new RelayGate(() => now), async (route, data: any) => {
      if (route === "session") flags.push(data.initialize);
      if (route === "poll") assert.equal(secondLedger.canInitialize, false, "observation must commit before polling");
      try {
        const response = await relay.connector(route, data);
        if (route === "poll") second.stop();
        return response;
      } catch (e: any) { throw new RelayConnectionError(e.code); }
    }, () => now, async () => { assert.fail("no work was admitted"); }, async ms => { now += ms; });
    await assert.doesNotReject(second.start(), "a pending ledger must survive failed startup and process restart");
    assert.deepEqual(flags, [true]); assert.equal(store.writes, 1);

    // Even without a mutation receipt, observation of the real session is permanent.
    store.value = null; flags.length = 0;
    const third = new GiskardConnector(config, new ReceiptLedger(dir), new RelayGate(() => now), async (route, data: any) => {
      flags.push(data.initialize);
      try { return await relay.connector(route, data); } catch (e: any) { throw new RelayConnectionError(e.code); }
    }, () => now, async () => { assert.fail("missing established mailbox cannot dispatch"); }, async () => { assert.fail("known missing mailbox is terminal"); });
    await assert.rejects(third.start(), RelayConnectionError);
    assert.deepEqual(flags, [false]); assert.equal(store.value, null);
  }
});

test("recognized legacy ledgers migrate as established; unknown or inconsistent initialization state never becomes fresh", t => {
  const who = { identity: { teamId: "TTEST", channelId: "CTEST", userId: "UTEST", turnId: "legacy" } };
  for (const scenario of ["legacy-empty", "legacy-receipts", "unknown-marker", "unknown-schema", "missing-state", "pending-with-receipts"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-ledger-schema-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = new ReceiptLedger(dir);
    assert.equal(ledger.canInitialize, true);
    assert.throws(() => ledger.claim("lease", who), "pending initialization cannot authorize dispatch");
    ledger.observeMailbox();
    if (scenario === "legacy-receipts" || scenario === "pending-with-receipts") {
      for (const action of ["lease", "apply", "stop"] as const) assert.equal(ledger.claim(action, who), true);
    }
    ledger.close();
    const db = new DatabaseSync(path.join(dir, "giskard-relay.sqlite"));
    if (scenario.startsWith("legacy-")) db.exec("DROP TABLE initialization; PRAGMA user_version=1;");
    if (scenario === "unknown-schema") db.exec("PRAGMA user_version=99;");
    if (scenario === "missing-state") db.exec("DELETE FROM initialization;");
    if (scenario === "pending-with-receipts") db.exec("UPDATE initialization SET established=0;");
    db.close();
    if (scenario === "unknown-marker") fs.writeFileSync(path.join(dir, "giskard-relay.initialized"), "v9\n");
    if (!scenario.startsWith("legacy-")) { assert.throws(() => new ReceiptLedger(dir)); continue; }
    const migrated = new ReceiptLedger(dir);
    assert.equal(migrated.canInitialize, false, "an empty recognized legacy ledger still cannot prove freshness");
    if (scenario === "legacy-receipts") for (const action of ["lease", "apply", "stop"] as const) assert.equal(migrated.claim(action, who), false);
    migrated.close();
    const reopened = new ReceiptLedger(dir); assert.equal(reopened.canInitialize, false); reopened.close();
  }
});

test("ambiguous creation followed by session_busy persists existence and Stop fences before a process restart", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-busy-restart-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { origin: "https://test.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir };
  let now = 100000, attempts = 0;
  const store = new Store(), relay = new Relay(store, () => now); store.ambiguous = true;
  const first = new GiskardConnector(config, new ReceiptLedger(dir), new RelayGate(() => now), async (route, data: any) => {
    attempts++;
    try { return await relay.connector(route, data); }
    catch (e: any) {
      if (attempts === 1) await relay.admit("stop", { identity: { teamId: "TTEST", channelId: "CTEST", userId: "UTEST", turnId: "stop" } });
      throw new RelayConnectionError(e.code);
    }
  }, () => now, async () => { assert.fail("a different live session must retain ownership"); }, async ms => {
    now += ms; if (attempts === 2) first.stop();
  });
  await first.start();
  assert.equal(attempts, 2); assert.equal(store.value.fence, 2);
  assert.equal(store.value.jobs[0].action, "stop"); assert.equal(store.value.jobs[0].phase, "queued");
  const ledger = new ReceiptLedger(dir); assert.equal(ledger.canInitialize, false);
  store.value = null;
  const second = new GiskardConnector(config, ledger, new RelayGate(() => now), async (route, data: any) => {
    assert.equal(data.initialize, false);
    try { return await relay.connector(route, data); } catch (e: any) { throw new RelayConnectionError(e.code); }
  }, () => now, async () => { assert.fail("known mailbox loss cannot dispatch"); }, async () => { assert.fail("no reset after session_busy"); });
  await assert.rejects(second.start(), RelayConnectionError); assert.equal(store.value, null);
});

test("ambiguous initial creation reads back and waits out the live session; no blind initialization retry", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-create-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(); store.ambiguous = true;
  let now = 100000, attempts = 0, firstSession = "";
  const relay = new Relay(store, () => now), flags: boolean[] = [], delays: number[] = [];
  const connector = new GiskardConnector({ origin: "https://test.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir },
    new ReceiptLedger(dir), new RelayGate(() => now), async (route, data: any) => {
      if (route === "session") {
        flags.push(data.initialize); attempts++;
        if (attempts === 1) firstSession = data.session;
        else if (now < 130000) assert.equal(store.value.session.id, firstSession, "cannot displace a different live incarnation");
      }
      try {
        const response = await relay.connector(route, data);
        if (route === "poll") connector.stop();
        return response;
      } catch (e: any) { throw new RelayConnectionError(e.code); }
    }, () => now, async () => { assert.fail("startup recovery must not dispatch work"); },
    async ms => { delays.push(ms); now += ms; });
  await connector.start();
  assert.ok(attempts > 2); assert.deepEqual(flags, [true, ...Array(attempts - 1).fill(false)]);
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 15000]);
  assert.equal(store.writes, 2, "one ambiguous creation and one fenced takeover; no repeat creation writes");
  assert.equal(store.value.fence, 2); assert.notEqual(store.value.session.id, firstSession);
});

test("definitively absent fresh mailbox can initialize after readback; known-missing/corrupt/invalid configurations remain disabled", async t => {
  for (const code of ["fresh", "mailbox_missing", "mailbox_invalid", "unauthorized", "not_configured"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-closed-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const flags: boolean[] = [];
    let now = 100000, polls = 0, sleeps = 0;
    const connector = new GiskardConnector({ origin: "https://test.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir },
      new ReceiptLedger(dir), new RelayGate(() => now), async (route, data: any) => {
        if (route === "session") {
          flags.push(data.initialize);
          if (code === "fresh" && flags.length === 1) throw new RelayConnectionError();
          if (code === "fresh" && flags.length === 2) throw new RelayConnectionError("mailbox_missing");
          return { ok: true, ttl: 30000 };
        }
        polls++;
        if (code !== "fresh") throw new RelayConnectionError(code);
        connector.stop(); return { ok: true, ttl: 30000, job: null };
      }, () => now, async () => { assert.fail("no backend work expected"); }, async ms => { sleeps++; now += ms; });
    if (code === "fresh") { await connector.start(); assert.deepEqual(flags, [true, false, true]); assert.equal(sleeps, 2); }
    else { await assert.rejects(connector.start(), RelayConnectionError); assert.deepEqual(flags, [true]); assert.equal(sleeps, 0); }
    assert.equal(polls, 1);
  }
});

test("stop cancels a recovery backoff promptly and receipt failure never starts recovery", async t => {
  for (const failureAt of ["backoff", "claim", "observation"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-stop-retry-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const ledger = new ReceiptLedger(dir); let attempts = 0, slept!: () => void;
    const sleeping = new Promise<void>(resolve => { slept = resolve; });
    const connector = new GiskardConnector({ origin: "https://test.invalid", token: "unused", backendToken: "unused", port: 8787, dataDir: dir },
      ledger, new RelayGate(), async route => {
        if (route === "session") { attempts++; if (failureAt === "backoff") throw new RelayConnectionError(); return { ok: true, ttl: 30000 }; }
        assert.notEqual(failureAt, "observation", "failed observation must prevent polling");
        return { ok: true, ttl: 30000, job: { id: "c".repeat(64), action: "lease", fence: 1, ttl: 3000,
          body: { identity: { teamId: "TTEST", channelId: "CTEST", userId: "UTEST", turnId: "storage" } } } };
      }, undefined, async () => { assert.fail("no backend effect after failed durable claim"); },
      async (_ms, signal) => { slept(); await new Promise<void>(resolve => { signal.addEventListener("abort", () => resolve(), { once: true }); }); });
    if (failureAt !== "backoff") {
      // Same failure channel as a failed/ambiguous SQLite commit, without manipulating a live DB file.
      if (failureAt === "claim") ledger.claim = () => { throw new Error("synthetic storage failure"); };
      else ledger.observeMailbox = () => { throw new Error("synthetic storage failure"); };
      await assert.rejects(connector.start(), /synthetic storage failure/);
    } else {
      const running = connector.start(); await sleeping; connector.stop(); await running;
    }
    assert.equal(attempts, 1);
  }
});
