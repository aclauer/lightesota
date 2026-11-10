import assert from 'node:assert/strict';
import test from 'node:test';
import { DEDUP_MS, Relay } from '../relay.js';
import { admission, configuration, hash, identityKey } from '../protocol.js';
import { handler } from '../http.js';
import { Conflict } from '../blob.js';
import { body, env, identity, memoryHttp, session, Store } from './support.js';

async function setup() { let now = 100000; const store = new Store(), relay = new Relay(store, () => now); await relay.connector('session', { session, initialize: true }); return { store, relay, advance: n => { now += n; } }; }
const result = (id, payload, status = 200) => ({ session, id, index: 0, total: 1, status, data: Buffer.from(JSON.stringify(payload)).toString('base64') });

test('natural command is bounded and 202 means only backend-acknowledged acceptance', async () => {
  const { relay } = await setup(), who = body('natural'), config = configuration(env);
  const lease = await relay.admit('lease', who); await relay.connector('poll', { session });
  await relay.connector('result', result(lease.id, { ok: true, leaseId: 'a'.repeat(43) })); await relay.take(lease.id);
  const request = { ...who, leaseId: 'a'.repeat(43), command: { kind: 'agent_request', prompt: 'Shift the lights left to right' } };
  admission('apply', request, config);
  for (const command of [{ ...request.command, prompt: '' }, { ...request.command, prompt: 'é'.repeat(2049) }, { ...request.command, role: 'admin' }]) assert.throws(() => admission('apply', { ...request, command }, config));
  assert.throws(() => admission('state', { ...who, requestId: '../conversation' }, config));
  const job = await relay.admit('apply', request); await relay.connector('poll', { session });
  const accepted = { ok: true, request: { id: 'r'.repeat(24), status: 'accepted' }, physicalOutput: 'unverified' };
  await relay.connector('result', result(job.id, accepted, 202));
  assert.deepEqual(await relay.take(job.id), { status: 202, body: accepted });
  await assert.rejects(relay.admit('apply', request));
  const stop = await relay.admit('stop', body('not-an-ack')); await relay.connector('poll', { session });
  await relay.connector('result', result(stop.id, accepted, 202));
  assert.equal((await relay.take(stop.id)).status, 503, 'acceptance can never acknowledge Stop');
});

test('auth, allowlist, production gate and exact raw paths precede all storage', async () => {
  const store = new Store(), handle = handler({ store, env });
  for (let n = 0; n < 130; n++) assert.equal((await memoryHttp(handle, { path: '/api/integrations/giskard/stop', token: 'bad' })).status, 401);
  for (const override of [{ userId: 'UOTHER' }, { channelId: 'COTHER' }, { teamId: 'TOTHER' }]) assert.equal((await memoryHttp(handle, { body: { identity: { ...identity, ...override } } })).status, 403);
  for (const path of ['/', '/api/integrations/giskard/State', '/api/integrations/giskard/state/', '/api/integrations/giskard/%73tate', '/api/integrations/giskard/a/../state', '/api/integrations/giskard/state?x=1', '/api/integrations/giskard//state']) assert.equal((await memoryHttp(handle, { path })).status, 404);
  for (const method of ['GET','PUT','DELETE','OPTIONS','HEAD']) assert.equal((await memoryHttp(handle, { method })).status, 404);
  for (const override of [{ VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { VERCEL: undefined }, { GISKARD_RELAY_ENABLED: '0' }]) assert.equal((await memoryHttp(handler({ store, env: { ...env, ...override } }))).status, 404);
  assert.equal((await memoryHttp(handle, { path: '/api/connector/poll' })).status, 401);
  assert.equal(store.reads, 0); assert.equal(store.writes, 0);
  const allowed = await memoryHttp(handle, { path: '/api/connector/session', body: { session, initialize: true }, token: env.GISKARD_CONNECTOR_TOKEN });
  assert.equal(allowed.status, 200); assert.equal(allowed.headers['access-control-allow-origin'], undefined);
});

test('strict bodies, 8192-byte cap, compression and command schema fail before storage', async () => {
  const store = new Store(), handle = handler({ store, env });
  for (const input of [{ raw: '{secret' }, { raw: '[]' }, { body: { identity, prompt: 'secret' } },
    { path: '/api/integrations/giskard/apply', body: { identity, leaseId: 'a'.repeat(43), command: { kind: 'eval', code: 'secret' } } }]) {
    const r = await memoryHttp(handle, input); assert.equal(r.status, 400); assert.ok(!JSON.stringify(r.body).includes('secret'));
  }
  assert.equal((await memoryHttp(handle, { raw: 'x'.repeat(8193) })).status, 413);
  assert.equal((await memoryHttp(handle, { headers: { 'content-encoding': 'gzip' } })).status, 415);
  assert.equal(store.reads, 0);
});

test('CAS concurrency admits one lease per event and never overwrites a winner', async () => {
  const { store, relay } = await setup(); const other = new Relay(store, relay.now);
  store.conflicts = 2;
  const attempts = await Promise.allSettled([relay.admit('lease', body('one')), other.admit('lease', body('one'))]);
  assert.equal(attempts.filter(a => a.status === 'fulfilled').length, 1);
  assert.equal(store.value.jobs.length, 1); assert.equal(store.value.receipts.ordinary.length, 1);
  store.conflicts = 10; await assert.rejects(relay.admit('state', body('two')), /contention/);
});

test('ambiguous admission and poll commits cannot cause a second delivery or reacquisition', async () => {
  const { store, relay } = await setup(); store.ambiguous = true;
  await assert.rejects(relay.admit('lease', body('one')));
  await assert.rejects(relay.admit('lease', body('one')), /outcome_unknown/);
  store.ambiguous = true; await assert.rejects(relay.connector('poll', { session }));
  assert.equal((await relay.connector('poll', { session })).job, null);
  assert.equal(store.value.jobs[0].phase, 'sent');
});

test('HTTP ordinary admission cancels its orphan on lost CAS acknowledgement or caller disconnect', async () => {
  for (const mode of ['ambiguous', 'disconnect']) {
    const store = new Store(), relay = new Relay(store), caller = new AbortController();
    await relay.connector('session', { session, initialize: true });
    const cas = store.cas.bind(store); let first = true;
    store.cas = async (...args) => {
      await cas(...args);
      if (first) {
        first = false;
        if (mode === 'disconnect') caller.abort();
        else throw new Error('synthetic lost admission acknowledgement');
      }
    };
    const response = await memoryHttp(handler({ store, env }), { path: '/api/integrations/giskard/lease', body: body('orphan'), signal: caller.signal });
    assert.equal(response.status, 503);
    assert.equal((await relay.connector('poll', { session })).job, null);
    assert.equal(store.value.receipts.ordinary.length, 1);
  }
});

test('admitted Stop survives caller disconnect and ambiguous admission without claiming success or extending cutoff', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const mode of ['disconnect', 'ambiguous']) {
    const { store, relay, advance } = await setup(), caller = new AbortController();
    const cas = store.cas.bind(store); let first = true, finished = false;
    store.cas = async (...args) => {
      await cas(...args);
      if (first) {
        first = false;
        if (mode === 'disconnect') caller.abort();
        else throw new Error('synthetic lost admission acknowledgement');
      }
    };
    const request = memoryHttp(handler({ store, env, now: relay.now }), {
      path: '/api/integrations/giskard/stop', body: body(mode), signal: caller.signal,
    }).then(response => { finished = true; return response; });
    await new Promise(resolve => setImmediate(resolve));
    const job = structuredClone(store.value.jobs[0]);
    const beforeAcknowledgement = finished;
    // Complete the handler before asserting, including the old implementation's failure path.
    if (job.phase === 'queued') {
      if (mode === 'disconnect') {
        assert.equal((await relay.connector('poll', { session })).job.id, job.id);
        await relay.connector('result', result(job.id, { ok: true, command: { kind: 'stop' } }));
      } else {
        advance(3500);
        assert.equal((await relay.connector('poll', { session })).job, null, 'lost ACK cannot extend Stop dispatch eligibility');
      }
    }
    t.mock.timers.tick(4500);
    const response = await request;
    assert.equal(job.phase, 'queued', `${mode} must not revoke admitted Stop`);
    assert.equal(job.cutoff, 103500); assert.equal(job.expires, 105500);
    assert.equal(beforeAcknowledgement, false);
    assert.equal(response.status, 503); assert.equal(response.body.code, 'outcome_unknown');
    if (mode === 'disconnect') assert.equal((await relay.take(job.id)).status, 200, 'backend ACK survives the disconnected handler finalizer');
  }
});

test('definite admission refusals return without cancellation reads or the uncertain-write hold', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const reason of ['connector_unavailable', 'rate_limited', 'duplicate', 'identity_denied']) {
    const { store, relay, advance } = await setup();
    if (reason === 'connector_unavailable') advance(13000);
    if (reason === 'rate_limited') store.value.quotas.ordinary = { start: relay.now(), count: 60 };
    if (reason === 'duplicate') await relay.admit('lease', body(reason));
    const read = store.read.bind(store), writes = store.writes;
    let reads = 0, finished = false;
    store.read = async signal => {
      if (++reads > 1) throw new Error('synthetic unavailable follow-up read');
      return read(signal);
    };
    const data = body(reason); if (reason === 'identity_denied') data.identity.userId = 'UOTHER';
    const request = memoryHttp(handler({ store, env, now: relay.now }), {
      path: '/api/integrations/giskard/lease', body: data,
    }).then(response => { finished = true; return response; });
    await new Promise(resolve => setImmediate(resolve));
    const returnedWithoutWaiting = finished;
    t.mock.timers.tick(4500); const response = await request;
    assert.equal(returnedWithoutWaiting, true, `${reason} has no uncertain admission to wait for`);
    assert.equal(reads, reason === 'identity_denied' ? 0 : 1, 'definite refusal must not enter cancellation');
    assert.equal(store.writes, writes);
    assert.equal(response.status, { connector_unavailable: 503, rate_limited: 429, duplicate: 409, identity_denied: 403 }[reason]);
  }
});

test('ambiguous admission and an SDK conflict echo retain the guard even when a later read refuses admission', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const echo of [false, true]) {
    const { store, relay, advance } = await setup(), cas = store.cas.bind(store), read = store.read.bind(store);
    let reads = 0, first = true, finished = false;
    store.cas = async (...args) => {
      await cas(...args);
      if (first) { first = false; throw echo ? new Conflict() : new Error('synthetic lost write reply'); }
    };
    store.read = async signal => {
      if (++reads > (echo ? 2 : 1)) throw new Error('synthetic unavailable cancellation read');
      return read(signal);
    };
    const request = memoryHttp(handler({ store, env, now: relay.now }), {
      path: '/api/integrations/giskard/lease', body: body('uncertain'),
    }).then(response => { finished = true; return response; });
    await new Promise(resolve => setImmediate(resolve));
    const returnedBeforeGuard = finished;
    assert.equal(store.value.jobs[0].phase, 'queued');
    advance(4500); t.mock.timers.tick(4500); const response = await request;
    assert.equal(returnedBeforeGuard, false, 'a CAS attempt may have committed despite a later refusal');
    assert.equal(reads, echo ? 3 : 2);
    assert.equal(response.status, 503); assert.equal(response.body.code, 'outcome_unknown');
    store.read = read; store.cas = cas;
    assert.equal((await relay.connector('poll', { session })).job, null, 'uncertain work cannot run past cutoff');
  }
});

test('Stop reserves capacity, cancels queued leases and suppresses old in-flight authority; ACK is truthful', async () => {
  const { relay, store } = await setup();
  const old = await relay.admit('lease', body('old'));
  const dispatched = await relay.connector('poll', { session }); assert.equal(dispatched.job.id, old.id);
  for (let n = 0; n < 3; n++) await relay.admit('lease', body('pending' + n));
  await assert.rejects(relay.admit('state', body('full')), /capacity/);
  const stop = await relay.admit('stop', body('stop'));
  assert.equal(await relay.take(stop.id), null, 'queue acceptance must not be success');
  assert.equal((await relay.take(old.id)).body.code, 'outcome_unknown');
  await assert.rejects(relay.connector('result', result(old.id, { ok: true, leaseId: 'x'.repeat(43) })), /expired/);
  assert.equal((await relay.connector('poll', { session })).job.id, stop.id);
  assert.equal(await relay.take(stop.id), null);
  await relay.connector('result', result(stop.id, { ok: true, command: { kind: 'stop' } }));
  assert.equal((await relay.take(stop.id)).body.command.kind, 'stop');
  await assert.rejects(relay.admit('lease', body('pending0')), /outcome_unknown/);
  assert.equal(store.value.bindings.length, 0);
});

test('completed lease authority is erased by Stop and cannot authorize a later apply', async () => {
  const { relay } = await setup(); const lease = await relay.admit('lease', body('one'));
  await relay.connector('poll', { session });
  await relay.connector('result', result(lease.id, { ok: true, leaseId: 'x'.repeat(43) }));
  await relay.take(lease.id); await relay.admit('stop', body('stop'));
  await assert.rejects(relay.admit('apply', { ...body('one'), leaseId: 'x'.repeat(43) }), /invalid_lease/);
});

test('disconnect cancellation, dispatch cutoff, retention, health expiry and takeover fail closed', async () => {
  const { relay, store, advance } = await setup();
  const disconnected = await relay.admit('lease', body('disconnect')); await relay.cancel(disconnected.id);
  assert.equal((await relay.connector('poll', { session })).job, null);
  const expired = await relay.admit('lease', body('expired')); advance(3500);
  assert.equal((await relay.connector('poll', { session })).job, null);
  assert.equal((await relay.take(expired.id)).body.code, 'outcome_unknown');
  await assert.rejects(relay.connector('session', { session: 'b'.repeat(64), initialize: false }), /session_busy/);
  advance(13000); await assert.rejects(relay.admit('state', body('offline')), /connector_unavailable/);
  await relay.connector('poll', { session });
  assert.ok(store.value.jobs.every(j => !j.body && !j.parts && !j.result));
  advance(31000); await relay.connector('session', { session: 'b'.repeat(64), initialize: false });
  await assert.rejects(relay.connector('poll', { session }), /session_expired/);
  assert.equal(store.value.receipts.ordinary.length, 2);
});

test('idle polling has no writes until heartbeat; corrupt storage is never reset', async () => {
  const { store, relay, advance } = await setup(); const writes = store.writes;
  for (let n = 0; n < 10; n++) await relay.connector('poll', { session });
  assert.equal(store.writes, writes); advance(8000); await relay.connector('poll', { session });
  assert.equal(store.writes, writes + 1);
  store.value.version = 999; await assert.rejects(relay.connector('poll', { session }), /mailbox_invalid/);
  assert.equal(store.value.version, 999);
});

test('missing mailbox after initialization is a failure, never an implicit replay reset', async () => {
  const { relay, store } = await setup(); store.value = null;
  await assert.rejects(relay.connector('poll', { session }), /mailbox_missing/);
  await assert.rejects(relay.connector('session', { session, initialize: false }), /mailbox_missing/);
  assert.equal(store.value, null);
});

test('legacy migration retains fences, live jobs and recent duplicates through the full temporary window', async () => {
  const { relay, store, advance } = await setup();
  const job = await relay.admit('lease', body('legacy'));
  const fence = store.value.fence;
  store.value.version = 1;
  store.value.receipts.ordinary = store.value.receipts.ordinary.map(r => r.key);
  store.value.receipts.stop = [hash('stop:' + identityKey(body('legacy-stop')))];
  store.conflicts = 1;
  assert.equal((await relay.connector('poll', { session })).job.id, job.id);
  assert.equal(store.value.version, 2); assert.equal(store.value.fence, fence);
  assert.equal(store.value.jobs[0].phase, 'sent');
  await assert.rejects(relay.admit('lease', body('legacy')), /outcome_unknown/);
  await assert.rejects(relay.admit('stop', body('legacy-stop')), /outcome_unknown/);
  advance(DEDUP_MS);
  await relay.connector('session', { session: 'b'.repeat(64), initialize: false });
  assert.deepEqual(store.value.receipts, { ordinary: [], stop: [] });
  assert.equal(store.value.jobs.length, 0); assert.equal(store.value.fence, fence + 1);
});

test('body parsing time cannot extend the original RPC dispatch deadline', async () => {
  const { relay } = await setup();
  // The caller has only 100ms left after delivering a slow body: no dispatch budget remains.
  await assert.rejects(relay.admit('lease', body('slow-body'), undefined, 100100), /expired/);
});

test('result chunk ordering and 65536 total byte cap; failed backend Stop never succeeds', async () => {
  const { relay } = await setup(); const job = await relay.admit('stop', body('stop'));
  await relay.connector('poll', { session });
  await assert.rejects(relay.connector('result', { ...result(job.id, {}), total: 14 }), /invalid_request/);
  await relay.connector('result', result(job.id, { ok: false, secret: 'never-return' }, 500));
  const response = await relay.take(job.id); assert.equal(response.status, 503); assert.ok(!JSON.stringify(response).includes('never-return'));
  const big = await relay.admit('state', body('big')); await relay.connector('poll', { session });
  for (let index = 0; index < 12; index++) await relay.connector('result', { session, id: big.id, total: 13, index, status: 200, data: Buffer.alloc(5400).toString('base64') });
  await assert.rejects(relay.connector('result', { session, id: big.id, total: 13, index: 12, status: 200, data: Buffer.alloc(737).toString('base64') }), /invalid_request/);
});
