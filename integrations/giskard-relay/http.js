import { randomBytes } from 'node:crypto';
import { Relay } from './relay.js';
import { admission, authenticated, bounded, check, configuration, CONNECTOR, LIMIT, pause, PREFIX, Refused, RPC_MS, RESPONSE_LIMIT } from './protocol.js';

export function handler({ store, env, now = Date.now }) {
  const config = configuration(env), relay = new Relay(store, now);
  return async (req, res) => {
    const deadline = now() + RPC_MS;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const controller = new AbortController();
    const timer = setTimeout(() => { send(503, { ok: false, code: 'outcome_unknown', error: 'Lighting deadline reached; do not retry this turn' }); controller.abort(); }, RPC_MS);
    const signal = controller.signal; let requestId, validatedAction, admissionMayCommit = false;
    function send(status, body) {
      if (res.destroyed || res.writableEnded) return;
      let raw = JSON.stringify(body);
      if (Buffer.byteLength(raw) > RESPONSE_LIMIT) { status = 503; raw = '{"ok":false,"code":"outcome_unknown"}'; }
      res.statusCode = status; res.end(raw);
    }
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    req.once('aborted', disconnected); res.once('close', disconnected);
    try {
      check(config.enabled, 'disabled', 404); check(config.valid, 'not_configured', 503);
      // Compare the unparsed request target. No URL normalization, query tokens, slash or encoding aliases.
      const action = ['state','lease','apply','stop'].find(a => req.url === PREFIX + a);
      const route = ['session','poll','result'].find(a => req.url === CONNECTOR + a);
      check(req.method === 'POST' && (action || route), 'not_found', 404);
      check(authenticated(req.headers.authorization, action ? config.token : config.connectorToken), 'unauthorized', 401);
      check(/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') && !req.headers['content-encoding'], 'json_required', 415);
      check(!req.headers['content-length'] || /^\d+$/.test(req.headers['content-length']) && Number(req.headers['content-length']) <= LIMIT, 'body_too_large', 413);
      const raw = await bounded(req, LIMIT, signal);
      let body; try { body = JSON.parse(raw.toString('utf8')); } catch { throw new Refused('invalid_json', 400); }
      if (route) { send(200, await relay.connector(route, body, signal)); return; }
      admission(action, body, config); // Identity denial happens before any private storage access or quota.
      validatedAction = action;
      requestId = randomBytes(32).toString('hex');
      // Observe the actual admission CAS boundary, not exception text or a refusal code.
      // Once crossed, keep uncertainty sticky: an SDK retry can echo a precondition failure
      // after a committed write, followed by a duplicate/other refusal on transaction reload.
      const admitting = new Relay({ read: signal => store.read(signal), cas: (...args) => {
        admissionMayCommit = true;
        return store.cas(...args);
      } }, now);
      const job = await admitting.admit(action, body, signal, deadline, requestId);
      admissionMayCommit = true;
      for (let reads = 0; reads < 25 && !signal.aborted && now() < job.expires; reads++) {
        const result = await relay.take(job.id, signal);
        if (result) { send(result.status, result.body); return; }
        await pause(200, signal);
      }
      throw new Refused('outcome_unknown');
    } catch (e) {
      if (admissionMayCommit) {
        let uncertain = true;
        // A caller disappearing cannot revoke admitted Stop; its original cutoff still applies.
        if (validatedAction !== 'stop') {
          try { uncertain = await relay.cancel(requestId, AbortSignal.timeout(300)); } catch { /* ambiguous admission remains fenced by cutoff */ }
        }
        // Don't return early while an uncertain in-flight dispatch permit could still execute.
        // A lost caller connection itself cannot be synchronously observed on the other host.
        if (uncertain && !res.destroyed && now() < deadline - 1000) await pause(deadline - 1000 - now());
      }
      const definite = !admissionMayCommit && e instanceof Refused;
      send(definite ? e.status : 503, { ok: false, code: definite ? e.code : 'outcome_unknown', error: 'Lighting request unavailable, expired or outcome unknown; do not retry this turn' });
    } finally {
      clearTimeout(timer); req.removeListener('aborted', disconnected); res.removeListener('close', disconnected);
      // Best effort cancellation never grants success. Cutoff and HA effect permit remain authoritative
      // if the CAS or the response was lost. A dispatched mutation may have an unknown outcome.
      if (admissionMayCommit && signal.aborted && validatedAction !== 'stop') {
        try { await relay.cancel(requestId, AbortSignal.timeout(300)); } catch { /* fixed deadline still fences */ }
      }
      controller.abort();
    }
  };
}
