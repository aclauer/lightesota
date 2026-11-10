import { bounded, MAILBOX_LIMIT, Refused } from './protocol.js';
export const MAILBOX_PATH = 'lightesota-giskard/mailbox-v1.json';
export class Conflict extends Error {}

// Specific SDK classes precede their BlobError base. Never inspect error messages,
// stacks, error.name, causes or arbitrary upstream code/status properties.
const SDK_ERRORS = ['BlobAccessError', 'BlobClientTokenExpiredError', 'BlobContentTypeNotAllowedError',
  'BlobFileTooLargeError', 'BlobNotFoundError', 'BlobPathnameMismatchError', 'BlobPreconditionFailedError',
  'BlobRequestAbortedError', 'BlobServiceNotAvailable', 'BlobServiceRateLimited', 'BlobStoreNotFoundError',
  'BlobStoreSuspendedError', 'BlobUnknownError'];
function diagnosticCode(sdk, error) {
  for (const name of SDK_ERRORS) if (typeof sdk[name] === 'function' && error instanceof sdk[name]) return name;
  if (typeof sdk.BlobError === 'function' && error instanceof sdk.BlobError) {
    // SDK 2.9.0 creates this subclass but does not export it. Match only its
    // known constructor name on an SDK BlobError; emit a literal, never the name.
    if (Object.getPrototypeOf(error)?.constructor?.name === 'BlobOidcEnvironmentNotAllowedError') return 'BlobOidcEnvironmentNotAllowedError';
    return 'BlobError';
  }
  if (error instanceof Refused && ['unavailable', 'expired', 'body_too_large'].includes(error.code)) return `refused_${error.code}`;
  if (error instanceof SyntaxError) return 'SyntaxError';
  if (error instanceof TypeError) return 'TypeError';
  return 'unclassified';
}
function storageDiagnostics(sdk, { diagnostics = false, log = line => console.warn(line), now = () => performance.now() } = {}) {
  let windowStart, count = 0;
  return (operation, stage, code, error) => {
    if (diagnostics !== true) return;
    try {
      const at = now();
      if (!Number.isFinite(at)) return;
      if (windowStart === undefined || at - windowStart >= 60000) { windowStart = at; count = 0; }
      if (count >= 12) return;
      count++; // Reserve synchronously before the sink: concurrent calls share one budget.
      log(JSON.stringify({ event: 'giskard_relay_storage', operation, stage,
        code: code === 'error' ? diagnosticCode(sdk, error) : code }));
    } catch { /* Diagnostics must never replace a storage result or exception. */ }
  };
}

/** Only this boundary uses the SDK. No head(), CDN read, public access, path input or overwrite fallback. */
export function blobStore(sdk, options) {
  const report = storageDiagnostics(sdk, options);
  return {
    async read(signal) {
      let stage = 'get';
      try {
        const result = await sdk.get(MAILBOX_PATH, { access: 'private', useCache: false, abortSignal: signal });
        if (result === null) { report('read', stage, 'missing'); return null; }
        stage = 'metadata';
        if (result.statusCode !== 200 || !result.blob?.etag) throw new Refused();
        stage = 'body';
        const raw = await bounded(result.stream, MAILBOX_LIMIT, signal);
        stage = 'parse';
        const value = JSON.parse(raw.toString('utf8'));
        report('read', stage, 'ok');
        return { etag: result.blob.etag, value };
      } catch (error) { report('read', stage, 'error', error); throw error; }
    },
    async cas(etag, value, signal) {
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > MAILBOX_LIMIT) throw new Refused('capacity');
      try {
        await sdk.put(MAILBOX_PATH, raw, { access: 'private', addRandomSuffix: false,
          allowOverwrite: etag !== null, ...(etag === null ? {} : { ifMatch: etag }),
          contentType: 'application/json', abortSignal: signal });
        report('cas', etag === null ? 'create' : 'update', 'ok');
      } catch (e) {
        report('cas', etag === null ? 'create' : 'update', 'error', e);
        // Every other error is ambiguous. Never retry an uncertain write as a new operation.
        if (e instanceof sdk.BlobPreconditionFailedError) throw new Conflict();
        throw new Refused('outcome_unknown');
      }
    },
  };
}
