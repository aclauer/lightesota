import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
export const PREFIX = '/api/integrations/giskard/';
export const CONNECTOR = '/api/connector/';
export const LIMIT = 8192, RESPONSE_LIMIT = 65536, MAILBOX_LIMIT = 786432;
export const RPC_MS = 5500, DISPATCH_MS = 3500, RETAIN_MS = 10000;
export const SESSION_MS = 30000, HEALTH_MS = 12000;
export const hash = value => createHash('sha256').update(value).digest('hex');
export const identityKey = body => hash(JSON.stringify(['teamId', 'channelId', 'userId', 'turnId'].map(k => body.identity[k])));
export class Refused extends Error {
  constructor(code = 'unavailable', status = 503) { super(code); this.code = code; this.status = status; }
}
export function check(condition, code = 'invalid_request', status = 400) { if (!condition) throw new Refused(code, status); }
export const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => keys.includes(k));
export const tokenValid = t => typeof t === 'string' && /^[\x21-\x7e]{32,1024}$/.test(t);
export const authenticated = (header, token) => {
  const match = typeof header === 'string' && header.length <= 1031 && /^Bearer ([^\s]+)$/i.exec(header);
  return !!match && timingSafeEqual(Buffer.from(hash(match[1]), 'hex'), Buffer.from(hash(token), 'hex'));
};
export function configuration(env) {
  const users = (env.GISKARD_RELAY_USER_IDS ?? '').split(',').map(x => x.trim());
  const config = { enabled: env.VERCEL === '1' && env.VERCEL_ENV === 'production' && env.GISKARD_RELAY_ENABLED === '1',
    token: env.GISKARD_RELAY_TOKEN ?? '', connectorToken: env.GISKARD_CONNECTOR_TOKEN ?? '',
    team: env.GISKARD_RELAY_TEAM_ID, channel: env.GISKARD_RELAY_CHANNEL_ID, users };
  config.valid = tokenValid(config.token) && tokenValid(config.connectorToken) && config.token !== config.connectorToken
    && /^T[A-Z0-9]{2,31}$/.test(config.team ?? '') && /^C[A-Z0-9]{2,31}$/.test(config.channel ?? '')
    && users.length <= 100 && users.every(u => /^[UW][A-Z0-9]{2,31}$/.test(u));
  return config;
}
export function admission(action, body, config) {
  check(exact(body, action === 'apply' ? ['identity', 'leaseId', 'command'] : action === 'state' ? ['identity', 'requestId'] : ['identity']));
  const i = body.identity;
  check(exact(i, ['teamId', 'channelId', 'userId', 'turnId']) && typeof i.turnId === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(i.turnId));
  check(i.teamId === config.team && i.channelId === config.channel && config.users.includes(i.userId), 'identity_denied', 403);
  if (action === 'state' && body.requestId !== undefined) check(typeof body.requestId === 'string' && /^[A-Za-z0-9_-]{24}$/.test(body.requestId));
  if (action !== 'apply') return;
  check(typeof body.leaseId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(body.leaseId));
  const c = body.command;
  if (c?.kind === 'agent_request') {
    check(exact(c, ['kind', 'prompt']) && typeof c.prompt === 'string' && c.prompt.trim().length > 0 && Buffer.byteLength(c.prompt) <= 4096);
    return;
  }
  const fields = { set_lights: ['kind', 'fixtureIds', 'brightness', 'color'], wash_mode: ['kind', 'fixtureIds', 'mode', 'sensitivity'], quick_look: ['kind', 'fixtureIds', 'lookId'] };
  check(c && typeof c.kind === 'string' && Object.hasOwn(fields, c.kind) && exact(c, fields[c.kind]));
  check(Array.isArray(c.fixtureIds) && c.fixtureIds.length > 0 && c.fixtureIds.length <= 128
    && new Set(c.fixtureIds).size === c.fixtureIds.length && c.fixtureIds.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(id) && !['__proto__','constructor','prototype'].includes(id)));
  if (c.kind === 'set_lights') check(Number.isFinite(c.brightness) && c.brightness >= 0 && c.brightness <= 100 && (c.color === undefined || typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color)));
  if (c.kind === 'wash_mode') check(['off', 'normal', 'music6', 'music32'].includes(c.mode) && (c.sensitivity === undefined || Number.isInteger(c.sensitivity) && c.sensitivity >= 11 && c.sensitivity <= 255));
  if (c.kind === 'quick_look') check(['warm-arrival', 'cyan-magenta', 'calm-blue'].includes(c.lookId));
}
export async function bounded(stream, max, signal) {
  const source = typeof stream.getReader === 'function' ? Readable.fromWeb(stream) : stream;
  const abort = () => source.destroy(new Refused('expired'));
  const chunks = []; let size = 0;
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    for await (const chunk of source) {
      if (signal?.aborted) throw new Refused('expired');
      const b = Buffer.from(chunk); size += b.length;
      if (size > max) throw new Refused('body_too_large', 413);
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  } finally { signal?.removeEventListener('abort', abort); }
}
export const pause = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms); signal?.addEventListener('abort', done, { once: true });
});
