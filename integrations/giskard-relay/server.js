import http from 'node:http';
import { handler } from './http.js';
import { blobStore } from './blob.js';

// Unconditional listen is the Vercel Node HTTP entrypoint. Tests import http.js instead.
// Disabled/preview requests cannot initialize the private-store client.
const lazyStore = {
  async read(signal) { return (await load()).read(signal); },
  async cas(etag, value, signal) { return (await load()).cas(etag, value, signal); },
};
let loaded;
function load() {
  return loaded ??= import('@vercel/blob').then(sdk => blobStore(sdk, {
    diagnostics: process.env.GISKARD_RELAY_DIAGNOSTICS === '1',
  }));
}
const server = http.createServer({ maxHeaderSize: 8192 }, handler({ store: lazyStore, env: process.env }));
server.requestTimeout = 6000;
server.headersTimeout = 6000;
server.maxRequestsPerSocket = 50;
server.listen(Number(process.env.PORT ?? 3000));
