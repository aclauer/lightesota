import { bounded, MAILBOX_LIMIT, Refused } from './protocol.js';
export const MAILBOX_PATH = 'lightesota-giskard/mailbox-v1.json';
export class Conflict extends Error {}
/** Only this boundary uses the SDK. No head(), CDN read, public access, path input or overwrite fallback. */
export function blobStore(sdk) {
  return {
    async read(signal) {
      const result = await sdk.get(MAILBOX_PATH, { access: 'private', useCache: false, abortSignal: signal });
      if (result === null) return null;
      if (result.statusCode !== 200 || !result.blob?.etag) throw new Refused();
      const raw = await bounded(result.stream, MAILBOX_LIMIT, signal);
      return { etag: result.blob.etag, value: JSON.parse(raw.toString('utf8')) };
    },
    async cas(etag, value, signal) {
      const raw = JSON.stringify(value);
      if (Buffer.byteLength(raw) > MAILBOX_LIMIT) throw new Refused('capacity');
      try {
        await sdk.put(MAILBOX_PATH, raw, { access: 'private', addRandomSuffix: false,
          allowOverwrite: etag !== null, ...(etag === null ? {} : { ifMatch: etag }),
          contentType: 'application/json', abortSignal: signal });
      } catch (e) {
        // Every other error is ambiguous. Never retry an uncertain write as a new operation.
        if (e instanceof sdk.BlobPreconditionFailedError) throw new Conflict();
        throw new Refused('outcome_unknown');
      }
    },
  };
}
