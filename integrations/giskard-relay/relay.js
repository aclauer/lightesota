import { randomBytes } from 'node:crypto';
import { Conflict } from './blob.js';
import { check, exact, hash, identityKey, Refused, RPC_MS, DISPATCH_MS, RETAIN_MS, SESSION_MS, HEALTH_MS, RESPONSE_LIMIT, MAILBOX_LIMIT } from './protocol.js';

// Covers the 120s lease/binding lifetime, dispatch and retained jobs. HA retains attempted actions;
// trusted ingress must not replay historical events that never reached HA (hashes cannot prove age).
export const DEDUP_MS = 130000;
const empty = () => ({ version: 2, fence: 0, session: null, jobs: [], receipts: { ordinary: [], stop: [] }, bindings: [], quotas: {} });
const id = () => randomBytes(32).toString('hex');
const validId = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function validate(m) {
  // Corrupt/unknown storage is never replaced by an empty mailbox.
  check([1, 2].includes(m?.version) && Number.isSafeInteger(m.fence) && m.fence >= 0 && m.fence < Number.MAX_SAFE_INTEGER - 1
    && Array.isArray(m.jobs) && m.jobs.length <= 5 && Array.isArray(m.bindings) && m.bindings.length <= 128
    && Array.isArray(m.receipts?.ordinary) && m.receipts.ordinary.length <= 2048
    && Array.isArray(m.receipts?.stop) && m.receipts.stop.length <= 512 && exact(m.quotas, Object.keys(m.quotas ?? {}))
    && Object.keys(m.quotas).length <= 202 && Buffer.byteLength(JSON.stringify(m)) <= MAILBOX_LIMIT, 'mailbox_invalid', 503);
  const receipt = m.version === 1 ? validId : r => validId(r?.key) && Number.isFinite(r.until);
  check(m.receipts.ordinary.every(receipt) && m.receipts.stop.every(receipt)
    && m.jobs.every(j => validId(j.id) && validId(j.key) && ['state','lease','apply','stop'].includes(j.action)
      && ['queued','sent','done','unknown'].includes(j.phase) && Number.isFinite(j.expires) && Number.isFinite(j.cutoff)
      && Number.isSafeInteger(j.fence) && j.fence <= m.fence)
    && (!m.session || validId(m.session.id) && Number.isFinite(m.session.until) && Number.isFinite(m.session.health)), 'mailbox_invalid', 503);
}
function strip(job) { delete job.body; delete job.parts; delete job.result; job.phase = 'unknown'; }
function sweep(m, now) {
  // One CAS migration retains legacy hashes for a full dedup window, with every fence/job intact.
  // Old deployments reject version 2, rather than racing a writer with different retention rules.
  if (m.version === 1) {
    for (const lane of ['ordinary', 'stop']) m.receipts[lane] = m.receipts[lane].map(key => ({ key, until: now + DEDUP_MS }));
    m.version = 2;
  }
  for (const lane of ['ordinary', 'stop']) m.receipts[lane] = m.receipts[lane].filter(r => now < r.until);
  m.jobs = m.jobs.filter(j => now < j.expires + RETAIN_MS);
  for (const j of m.jobs) if (now >= j.expires || (j.phase === 'queued' && now >= j.cutoff)) strip(j);
  m.bindings = m.bindings.filter(b => now < b.until && b.fence === m.fence);
}
function session(m, value, now) { check(validId(value) && m.session?.id === value && now < m.session.until, 'session_expired', 409); }
function quota(m, key, max, now) {
  let q = m.quotas[key];
  if (!q || now >= q.start + 60000) q = m.quotas[key] = { start: now, count: 0 };
  check(++q.count <= max, 'rate_limited', 429);
}

export class Relay {
  constructor(store, now = Date.now) { this.store = store; this.now = now; }
  async transaction(change, signal, allowCreate = false) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (signal?.aborted) throw new Refused('expired');
      const read = await this.store.read(signal);
      check(read || allowCreate, 'mailbox_missing', 503);
      const m = read ? read.value : empty();
      if (signal?.aborted) throw new Refused('expired');
      validate(m); const before = JSON.stringify(m);
      sweep(m, this.now()); const result = change(m, this.now()); validate(m);
      if (before === JSON.stringify(m) && read) return result;
      try { await this.store.cas(read?.etag ?? null, m, signal); if (signal?.aborted) throw new Refused('outcome_unknown'); return result; }
      catch (e) { if (!(e instanceof Conflict)) throw e; }
    }
    throw new Refused('contention');
  }
  async admit(action, body, signal, deadline = this.now() + RPC_MS, requestId = id()) {
    const key = identityKey(body), start = this.now();
    const cutoff = Math.min(start + DISPATCH_MS, deadline - 1500);
    return this.transaction((m, now) => {
      check(now < start + 1000 && now + 250 < cutoff, 'expired', 503);
      check(m.session && now < m.session.health && now + DISPATCH_MS < m.session.until, 'connector_unavailable', 503);
      const lane = action === 'stop' ? 'stop' : 'ordinary';
      const receipt = hash(action + ':' + key);
      if (action !== 'state') {
        check(!m.receipts[lane].some(r => r.key === receipt), 'outcome_unknown', 409);
        // Larger structural bounds above only accommodate legacy hashes during their first window.
        check(m.receipts[lane].length < (lane === 'stop' ? 128 : 256), 'receipt_capacity', 503);
      }
      check(m.jobs.filter(j => (j.action === 'stop') === (action === 'stop')).length < (action === 'stop' ? 1 : 4), 'capacity', 503);
      if (action === 'apply') check(m.bindings.some(b => b.key === key && b.lease === hash(body.leaseId) && b.fence === m.fence && now < b.until), 'invalid_lease', 409);
      quota(m, lane, lane === 'stop' ? 30 : 60, now);
      quota(m, lane + ':' + body.identity.userId, lane === 'stop' ? 10 : 30, now);
      if (action !== 'state') m.receipts[lane].push({ key: receipt, until: now + DEDUP_MS });
      if (action === 'stop') {
        m.fence++; m.bindings = [];
        for (const j of m.jobs) strip(j); // Lease requests and completed authority are fenced too.
      }
      const j = { id: requestId, key, action, body, phase: 'queued', fence: m.fence,
        cutoff, expires: deadline, session: m.session.id };
      m.jobs.push(j); return { id: requestId, expires: j.expires, cutoff: j.cutoff };
    }, signal);
  }
  async take(requestId, signal) {
    return this.transaction(m => {
      const j = m.jobs.find(j => j.id === requestId);
      if (!j || j.phase === 'unknown') { m.jobs = m.jobs.filter(j => j.id !== requestId); return { status: 503, body: { ok: false, code: 'outcome_unknown', error: 'Lighting outcome unknown; do not retry this turn' } }; }
      if (j.phase !== 'done') return null;
      m.jobs = m.jobs.filter(j => j.id !== requestId);
      return j.result;
    }, signal);
  }
  async cancel(requestId, signal) {
    return this.transaction(m => { const j = m.jobs.find(j => j.id === requestId); if (j) strip(j); return !!j?.dispatched; }, signal);
  }
  async connector(route, body, signal) {
    check(exact(body, route === 'session' ? ['session','initialize'] : route === 'poll' ? ['session'] : ['session','id','index','total','status','data']));
    check(validId(body.session));
    if (route === 'session') check(typeof body.initialize === 'boolean');
    return this.transaction((m, now) => {
      if (route === 'session') {
        // A different live instance cannot be displaced by reconnect storms.
        check(!m.session || now >= m.session.until || m.session.id === body.session, 'session_busy', 409);
        if (m.session?.id !== body.session) { m.fence++; m.bindings = []; for (const j of m.jobs) strip(j); }
        if (!m.session || m.session.id !== body.session || now - m.session.renewed >= 8000) m.session = { id: body.session, until: now + SESSION_MS, health: now + HEALTH_MS, renewed: now };
        return { ok: true, ttl: m.session.until - now };
      }
      session(m, body.session, now);
      if (route === 'poll') {
        if (now - m.session.renewed >= 8000) m.session = { ...m.session, until: now + SESSION_MS, health: now + HEALTH_MS, renewed: now };
        const j = m.jobs.find(j => j.action === 'stop' && j.phase === 'queued') ?? m.jobs.find(j => j.phase === 'queued');
        if (!j || now + 250 >= j.cutoff) return { ok: true, ttl: m.session.until - now, job: null };
        // Sent work is never redelivered, even if this CAS committed but its reply was lost.
        j.phase = 'sent'; j.dispatched = true;
        return { ok: true, ttl: m.session.until - now, job: { id: j.id, action: j.action, body: j.body, fence: j.fence, ttl: j.cutoff - now } };
      }
      check(route === 'result');
      const j = m.jobs.find(j => j.id === body.id);
      check(j && j.session === body.session && j.fence === m.fence && j.phase === 'sent' && now < j.expires, 'expired', 409);
      check(Number.isInteger(body.total) && body.total >= 1 && body.total <= 13 && Number.isInteger(body.index) && body.index >= 0 && body.index < body.total
        && Number.isInteger(body.status) && body.status >= 200 && body.status <= 599 && typeof body.data === 'string'
        && body.data.length <= 7200 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.data));
      if (!j.parts) { j.parts = []; j.total = body.total; j.status = body.status; }
      check(j.total === body.total && j.status === body.status && body.index === j.parts.length);
      j.parts.push(body.data);
      check(j.parts.reduce((n, p) => n + Buffer.byteLength(p, 'base64'), 0) <= RESPONSE_LIMIT);
      if (j.parts.length === j.total) {
        const raw = Buffer.concat(j.parts.map(p => Buffer.from(p, 'base64')));
        let result; try { result = JSON.parse(raw.toString('utf8')); } catch { throw new Refused('invalid_result'); }
        check(exact(result, Object.keys(result ?? {})) && typeof result.ok === 'boolean', 'invalid_result', 503);
        const accepted = body.status === 202 && j.action === 'apply' && j.body?.command?.kind === 'agent_request'
          && result.request?.status === 'accepted' && typeof result.request.id === 'string' && /^[A-Za-z0-9_-]{24}$/.test(result.request.id);
        if (body.status !== 200 && !accepted || result.ok !== true) result = { ok: false, code: 'backend_refused', error: 'Lighting backend refused or could not confirm the operation; do not retry this turn' };
        if (j.action === 'lease' && result.ok) {
          check(typeof result.leaseId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(result.leaseId) && m.bindings.length < 128, 'invalid_result', 503);
          m.bindings.push({ key: j.key, lease: hash(result.leaseId), fence: m.fence, until: now + 120000 });
        }
        delete j.body; delete j.parts;
        j.phase = 'done'; j.result = { status: result.ok ? body.status : 503, body: result };
      }
      return { ok: true };
    }, signal, route === 'session' && body.initialize === true);
  }
}
