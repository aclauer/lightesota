import assert from 'node:assert/strict';
import test from 'node:test';
import { blobStore, Conflict, MAILBOX_PATH } from '../blob.js';
import { MAILBOX_LIMIT, Refused } from '../protocol.js';
import { bounded } from '../protocol.js';
import { PassThrough } from 'node:stream';
import { BlobError, BlobPreconditionFailedError } from '@vercel/blob';
import * as installedSdk from '@vercel/blob';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { handler } from '../http.js';
import { env, memoryHttp } from './support.js';

test('opt-in storage diagnostics distinguish SDK read and CAS failures without changing throws', async () => {
  const logs = [];
  const readError = new installedSdk.BlobAccessError();
  const writeError = new BlobPreconditionFailedError();
  for (const error of [readError, writeError]) {
    error.message = 'synthetic-secret-message'; error.stack = 'synthetic-secret-stack';
    error.cause = { token: 'synthetic-secret-token', body: 'synthetic-private-mailbox' };
  }
  const store = blobStore({ ...installedSdk, get: async () => { throw readError; }, put: async () => { throw writeError; } },
    { diagnostics: true, log: line => logs.push(JSON.parse(line)), now: () => 0 });
  await assert.rejects(store.read(), error => error === readError);
  await assert.rejects(store.cas('synthetic-private-etag', { identity: 'synthetic-private-identity' }), Conflict);
  assert.deepEqual(logs, [
    { event: 'giskard_relay_storage', operation: 'read', stage: 'get', code: 'BlobAccessError' },
    { event: 'giskard_relay_storage', operation: 'cas', stage: 'update', code: 'BlobPreconditionFailedError' },
  ]);
});

test('diagnostics default off and failing sinks cannot change results or exceptions', async () => {
  const failure = new BlobError('synthetic-private-response');
  const sdk = { ...installedSdk, get: async () => null, put: async () => { throw failure; } };
  for (const diagnostics of [undefined, false, '1']) {
    let logs = 0;
    const store = blobStore(sdk, { diagnostics, log: () => { logs++; } });
    assert.equal(await store.read(), null);
    await assert.rejects(store.cas(null, {}), error => error instanceof Refused && error.code === 'outcome_unknown' && error.status === 503);
    assert.equal(logs, 0);
  }
  const store = blobStore(sdk, { diagnostics: true, log: () => { throw new Error('broken sink'); } });
  assert.equal(await store.read(), null);
  await assert.rejects(store.cas(null, {}), error => error instanceof Refused && error.code === 'outcome_unknown');
  sdk.get = async () => { throw failure; };
  await assert.rejects(store.read(), error => error === failure);
  sdk.put = async () => {};
  assert.equal(await store.cas(null, {}), undefined);
});

test('diagnostics use real class identities and fixed codes, never arbitrary error properties', async () => {
  const cases = Object.entries(installedSdk).filter(([name]) => /^Blob/.test(name) && name !== 'BlobError');
  cases.push(['BlobError', BlobError]);
  for (const [name, ErrorClass] of cases) {
    const logs = [], error = new ErrorClass('synthetic-secret');
    for (const key of ['message', 'stack', 'name', 'cause', 'headers', 'body', 'code'])
      Object.defineProperty(error, key, { get() { throw new Error('diagnostics inspected private error property'); } });
    const store = blobStore({ ...installedSdk, get: async () => { throw error; } },
      { diagnostics: true, log: line => logs.push(JSON.parse(line)), now: () => 0 });
    await assert.rejects(store.read(), thrown => thrown === error);
    assert.deepEqual(logs, [{ event: 'giskard_relay_storage', operation: 'read', stage: 'get', code: name }]);
  }
  for (const error of [new Error('BlobAccessError forbidden'), { name: 'BlobAccessError', code: 'forbidden', message: 'secret' }, 'secret', null]) {
    const logs = [];
    const store = blobStore({ ...installedSdk, put: async () => { throw error; } },
      { diagnostics: true, log: line => logs.push(JSON.parse(line)) });
    await assert.rejects(store.cas(null, {}), error => error instanceof Refused && error.code === 'outcome_unknown');
    assert.deepEqual(logs, [{ event: 'giskard_relay_storage', operation: 'cas', stage: 'create', code: 'unclassified' }]);
  }
});

test('read diagnostics separate missing, metadata, bounded body, JSON and success without logging bytes', async () => {
  const reply = raw => ({ statusCode: 200, blob: { etag: 'private-etag' }, stream: new ReadableStream({
    start(c) { c.enqueue(Buffer.from(raw)); c.close(); },
  }) });
  const cases = [
    [() => null, 'get', 'missing'],
    [() => ({ statusCode: 304 }), 'metadata', 'refused_unavailable'],
    [() => reply('private-invalid-json'), 'parse', 'SyntaxError'],
    [() => reply('x'.repeat(MAILBOX_LIMIT + 1)), 'body', 'refused_body_too_large'],
    [() => ({ statusCode: 200, blob: { etag: 'private-etag' }, stream: new ReadableStream({ start(c) { c.error(new Refused('expired')); } }) }), 'body', 'refused_expired'],
    [() => reply('{"private":"mailbox-bytes"}'), 'parse', 'ok'],
    [() => { throw new TypeError('private-url'); }, 'get', 'TypeError'],
  ];
  for (const [get, stage, code] of cases) {
    const logs = [], store = blobStore({ ...installedSdk, get }, { diagnostics: true, log: line => logs.push(JSON.parse(line)) });
    if (code === 'ok') assert.deepEqual(await store.read(), { etag: 'private-etag', value: { private: 'mailbox-bytes' } });
    else if (code === 'missing') assert.equal(await store.read(), null);
    else await assert.rejects(store.read());
    assert.deepEqual(logs, [{ event: 'giskard_relay_storage', operation: 'read', stage, code }]);
  }
});

test('one monotonic diagnostic budget bounds concurrent reads and CAS, including sink failures', async () => {
  let now = 0, attempts = 0, writes = 0;
  const logs = [], store = blobStore({ ...installedSdk, get: async () => null, put: async () => { writes++; } }, {
    diagnostics: true, now: () => now, log: line => {
      attempts++;
      if (attempts === 1) throw new Error('broken sink');
      logs.push(JSON.parse(line));
    },
  });
  const burst = () => Promise.all(Array.from({ length: 100 }, (_, i) => i % 2 ? store.read() : store.cas(null, {})));
  await burst(); assert.equal(attempts, 12); assert.equal(logs.length, 11); assert.equal(writes, 50);
  now = 59999; await burst(); assert.equal(attempts, 12); assert.equal(writes, 100);
  now = -1; await store.read(); assert.equal(attempts, 12, 'backward clock cannot replenish the budget');
  now = 60000; await burst(); assert.equal(attempts, 24); assert.equal(writes, 150);
  assert.ok(logs.every(log => ['ok', 'missing'].includes(log.code)));
});

test('installed SDK 2.9.0 wire behavior is exercised with network-disabled mocks and synthetic OIDC options', async () => {
  const dispatcher = getGlobalDispatcher(), mock = new MockAgent();
  mock.disableNetConnect(); setGlobalDispatcher(mock);
  try {
    const auth = { oidcToken: 'synthetic-oidc-token', storeId: 'store_fixture' };
    const logs = [], store = blobStore({ ...installedSdk,
      get: (path, options) => installedSdk.get(path, { ...options, ...auth }),
      put: (path, value, options) => installedSdk.put(path, value, { ...options, ...auth }),
    }, { diagnostics: true, log: line => logs.push(JSON.parse(line)) });
    const origin = mock.get('https://fixture.private.blob.vercel-storage.com');
    const read = { method: 'GET', path: `/${MAILBOX_PATH}?cache=0`, headers: { authorization: 'Bearer synthetic-oidc-token' } };
    origin.intercept(read).reply(200, '{}', { headers: { etag: 'synthetic-etag' } });
    assert.deepEqual(await store.read(), { etag: 'synthetic-etag', value: {} });
    origin.intercept(read).reply(403, 'synthetic-private-response');
    await assert.rejects(store.read(), error => error.constructor === BlobError);
    origin.intercept(read).reply(404, ''); assert.equal(await store.read(), null);
    for (const [etag, code, expected] of [[null, 'bad_request', 'BlobError'], ['old', 'precondition_failed', 'BlobPreconditionFailedError'],
      ['old', 'forbidden', 'BlobAccessError'], ['old', 'oidc_environment_not_allowed', 'BlobOidcEnvironmentNotAllowedError']]) {
      mock.get('https://vercel.com').intercept({ method: 'PUT', path: `/api/blob/?${new URLSearchParams({ pathname: MAILBOX_PATH })}`,
        headers: { 'x-vercel-blob-access': 'private', 'x-add-random-suffix': '0', 'x-allow-overwrite': etag === null ? '0' : '1',
          ...(etag === null ? {} : { 'x-if-match': etag }), authorization: 'Bearer synthetic-oidc-token', 'x-vercel-blob-store-id': 'fixture' },
      }).reply(code === 'precondition_failed' ? 412 : code === 'forbidden' ? 403 : 400, { error: { code, message: 'synthetic-private-error-body' } });
      await assert.rejects(store.cas(etag, {}), error => code === 'precondition_failed' ? error instanceof Conflict : error instanceof Refused && error.code === 'outcome_unknown');
      assert.equal(logs.at(-1).code, expected);
    }
    assert.deepEqual(logs.slice(0, 3).map(({ code }) => code), ['ok', 'BlobError', 'missing']);
    assert.equal(JSON.stringify(logs).includes('synthetic'), false);
    mock.assertNoPendingInterceptors();
  } finally { setGlobalDispatcher(dispatcher); await mock.close(); }
});

test('a 4683ms state outcome_unknown can be a read failure with no CAS attempt', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 100000 });
  let started, writes = 0;
  const reading = new Promise(resolve => { started = resolve; });
  const store = blobStore({ ...installedSdk, get: async () => {
    started(); await new Promise(resolve => setTimeout(resolve, 4683)); throw new BlobError('synthetic-read-failure');
  }, put: async () => { writes++; } });
  const request = memoryHttp(handler({ store, env }));
  await reading; t.mock.timers.tick(4683);
  const result = await request;
  assert.equal(Date.now(), 104683);
  assert.equal(result.status, 503); assert.equal(result.body.code, 'outcome_unknown');
  assert.equal(writes, 0, 'duration alone cannot establish admission or a write');
});

test('SDK boundary pins private uncached origin reads, bounded stream and exact CAS options', async () => {
  const calls = [], signal = new AbortController().signal;
  const sdk = { async get(...args) { calls.push(args); return { statusCode: 200, blob: { etag: 'old' }, stream: new ReadableStream({ start(c) { c.enqueue(Buffer.from('{"version":1}')); c.close(); } }) }; },
    async put(...args) { calls.push(args); } };
  const store = blobStore(sdk); assert.deepEqual(await store.read(signal), { etag: 'old', value: { version: 1 } });
  assert.deepEqual(calls[0], [MAILBOX_PATH, { access: 'private', useCache: false, abortSignal: signal }]);
  await store.cas('old', { version: 1 }, signal);
  assert.deepEqual(calls[1], [MAILBOX_PATH, '{"version":1}', { access: 'private', addRandomSuffix: false, allowOverwrite: true, ifMatch: 'old', contentType: 'application/json', abortSignal: signal }]);
  await store.cas(null, {}, signal); assert.equal(calls[2][2].allowOverwrite, false); assert.ok(!Object.hasOwn(calls[2][2], 'ifMatch'));
  sdk.get = async () => ({ statusCode: 200, blob: { etag: 'x' }, stream: new ReadableStream({ start(c) { c.enqueue(Buffer.alloc(MAILBOX_LIMIT + 1)); c.close(); } }) });
  await assert.rejects(store.read(signal), /body_too_large/);
});

test('a silent request body/Blob stream is interrupted by the fixed deadline', async () => {
  const stream = new PassThrough(), controller = new AbortController();
  const reading = bounded(stream, 8192, controller.signal); controller.abort();
  await assert.rejects(reading, /expired/); assert.equal(stream.destroyed, true);
});

test('real SDK precondition class alone retries; generic bad-request/initial-write failures remain ambiguous', async () => {
  let failure;
  let writes = 0;
  const store = blobStore({ BlobPreconditionFailedError, put: async () => { writes++; throw failure; } });
  failure = new BlobPreconditionFailedError(); await assert.rejects(store.cas('old', {}), Conflict);
  failure = new BlobError('synthetic bad_request: already exists');
  await assert.rejects(store.cas(null, {}), /outcome_unknown/);
  await assert.rejects(store.cas('old', {}), /outcome_unknown/);
  failure = new Error('secret upstream response'); await assert.rejects(store.cas('old', {}), e => e.message === 'outcome_unknown');
  failure = new Error('BlobPreconditionFailedError precondition_failed');
  await assert.rejects(store.cas(null, {}), /outcome_unknown/);
  assert.equal(writes, 5, 'no internal retry or message-based error classification');
});
