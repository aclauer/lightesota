import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import { Conflict } from '../blob.js';
export const env = { VERCEL: '1', VERCEL_ENV: 'production', GISKARD_RELAY_ENABLED: '1',
  GISKARD_RELAY_TOKEN: 'synthetic-giskard-cloud-token-1234567890', GISKARD_CONNECTOR_TOKEN: 'synthetic-connector-cloud-token-1234567890',
  GISKARD_RELAY_TEAM_ID: 'TTEST123', GISKARD_RELAY_CHANNEL_ID: 'CTEST123', GISKARD_RELAY_USER_IDS: 'UTEST123' };
export const identity = { teamId: 'TTEST123', channelId: 'CTEST123', userId: 'UTEST123', turnId: 'event-123' };
export const body = turnId => ({ identity: { ...identity, turnId } });
export const session = 'a'.repeat(64);
/** A consistent external storage boundary. Can lose CAS, or commit and then lose the acknowledgement. */
export class Store {
  value = null; revision = 0; reads = 0; writes = 0; conflicts = 0; ambiguous = false; beforeCAS;
  async read(signal) { if (signal?.aborted) throw new Error(); this.reads++; return this.value ? { etag: String(this.revision), value: structuredClone(this.value) } : null; }
  async cas(etag, value, signal) {
    if (signal?.aborted) throw new Error();
    if (this.beforeCAS) await this.beforeCAS();
    if (this.conflicts-- > 0 || etag !== (this.value ? String(this.revision) : null)) throw new Conflict();
    this.value = structuredClone(value); this.revision++; this.writes++;
    if (this.ambiguous) { this.ambiguous = false; throw new Error('synthetic lost acknowledgement'); }
  }
}
/** Actual Node IncomingMessage/ServerResponse and Express parsing; no listen(), no network bypass. */
export async function memoryHttp(handler, { path = '/api/integrations/giskard/state', method = 'POST',
  token = env.GISKARD_RELAY_TOKEN, body: input = { identity }, raw = JSON.stringify(input), headers = {}, signal, beforeBody } = {}) {
  const chunks = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' });
  const req = new IncomingMessage(socket); req.method = method; req.url = path;
  req.headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)), ...headers };
  const res = new ServerResponse(req); res.assignSocket(socket);
  const finish = new Promise((resolve, reject) => { res.once('finish', resolve); res.once('error', reject); });
  let run;
  const abort = () => { req.emit('aborted'); res.emit('close'); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    run = handler(req, res); await beforeBody?.(req, res);
    req.complete = true; req.push(raw); req.push(null); await finish; await run;
    const wire = Buffer.concat(chunks), at = wire.indexOf('\r\n\r\n');
    const data = wire.subarray(at + 4);
    return { status: res.statusCode, raw: data, body: data.length ? JSON.parse(data.toString()) : null, headers: res.getHeaders() };
  } finally { signal?.removeEventListener('abort', abort); socket.destroy(); }
}
