import assert from 'node:assert/strict';
import test from 'node:test';
import { blobStore, Conflict, MAILBOX_PATH } from '../blob.js';
import { MAILBOX_LIMIT } from '../protocol.js';
import { bounded } from '../protocol.js';
import { PassThrough } from 'node:stream';
import { BlobError, BlobPreconditionFailedError } from '@vercel/blob';

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
