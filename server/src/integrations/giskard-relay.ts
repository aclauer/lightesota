import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { DatabaseSync } from "node:sqlite";

type Action = "state" | "lease" | "apply" | "stop";
type Body = { identity: { teamId: string; channelId: string; userId: string; turnId: string }; [key: string]: unknown };
type Job = { id: string; action: Action; body: Body; fence: number; ttl: number };
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const receiptKey = (action: Action, body: Body) => hash(JSON.stringify([action, ...["teamId", "channelId", "userId", "turnId"].map(k => body.identity[k as keyof Body["identity"]])]));
const failure = () => new Error("Giskard connector unavailable");
const validId = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const tokenValid = (v: unknown): v is string => typeof v === "string" && /^[\x21-\x7e]{32,1024}$/.test(v);

/** This permit is optional and can only narrow the existing authenticated API. It is never a credential.
 * Only the in-process connector can install one; delayed HTTP bytes after timeout/restart cannot use it. */
export class RelayGate {
  private fence = 0;
  private active?: { id: string; action: Action; body: string; until: number; used: boolean };
  constructor(private now = () => performance.now()) {}
  open(id: string, action: Action, body: unknown, until: number, fence: number) {
    if (!validId(id) || !Number.isSafeInteger(fence) || fence < this.fence || until <= this.now()) throw failure();
    this.fence = fence;
    this.active = { id, action, body: hash(JSON.stringify(body)), until, used: false };
  }
  consume(id: string, action: Action, body: unknown) {
    const a = this.active;
    if (!a || a.id !== id || a.action !== action || a.used || this.now() >= a.until || a.body !== hash(JSON.stringify(body))) throw failure();
    a.used = true;
  }
  close() { this.active = undefined; }
}
export const relayGate = new RelayGate();

/** Never evict receipts, even on backend restart. Exclusive SQLite locking prevents a second
 * connector using the same persistent directory. DELETE journal + FULL + fullfsync commits before I/O. */
export class ReceiptLedger {
  private db: DatabaseSync;
  private failed = false;
  private initialized: boolean;
  constructor(directory: string, private capacity = 100000, private stopCapacity = 10000) {
    const file = path.join(directory, "giskard-relay.sqlite"), marker = path.join(directory, "giskard-relay.initialized");
    let db: DatabaseSync | undefined;
    try {
      const existed = fs.existsSync(file), marked = fs.existsSync(marker);
      if (existed !== marked) throw failure(); // Includes interrupted initialization or removed ledger.
      if (existed && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) throw failure();
      if (marked && (!fs.lstatSync(marker).isFile() || fs.lstatSync(marker).isSymbolicLink()
        || fs.statSync(marker).size !== 3 || fs.readFileSync(marker, "utf8") !== "v1\n")) throw failure();
      if (!existed) { const fd = fs.openSync(file, "wx", 0o600); fs.fsyncSync(fd); fs.closeSync(fd); }
      db = new DatabaseSync(file);
      db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE;");
      if (!existed) {
        db.exec("CREATE TABLE receipts (key TEXT PRIMARY KEY, lane TEXT NOT NULL CHECK(lane IN ('ordinary','stop')));");
      }
      const version = db.prepare("PRAGMA user_version").get();
      const integrity = db.prepare("PRAGMA integrity_check").get();
      if (existed && ![1, 2].includes(version?.user_version as number) || integrity?.integrity_check !== "ok") throw failure();
      db.prepare("SELECT key,lane FROM receipts LIMIT 1").all();
      if (!existed || version?.user_version === 1) {
        db.exec("CREATE TABLE initialization (id INTEGER PRIMARY KEY CHECK(id=1), established INTEGER NOT NULL CHECK(established IN (0,1))); PRAGMA user_version=2;");
        // Recognized legacy ledgers cannot prove they are fresh, even if receipts are empty.
        db.prepare("INSERT INTO initialization(id,established) VALUES (1,?)").run(existed ? 1 : 0);
      }
      const state = db.prepare("SELECT id,established FROM initialization LIMIT 2").all();
      if (state.length !== 1 || state[0]?.id !== 1 || ![0, 1].includes(state[0]?.established as number)) throw failure();
      this.initialized = state[0].established === 1;
      if (!this.initialized && db.prepare("SELECT key FROM receipts LIMIT 1").get()) throw failure();
      db.exec("COMMIT;");
      if (!existed) {
        const fd = fs.openSync(marker, "wx", 0o600); fs.writeSync(fd, "v1\n"); fs.fsyncSync(fd); fs.closeSync(fd);
        const dir = fs.openSync(directory, "r"); fs.fsyncSync(dir); fs.closeSync(dir);
      }
      this.db = db;
    } catch { try { db?.close(); } catch { /* no unsafe recovery */ } throw failure(); }
  }
  get canInitialize() { if (this.failed) throw failure(); return !this.initialized; }
  observeMailbox() {
    if (this.failed) throw failure();
    if (this.initialized) return;
    try {
      this.db.exec("BEGIN EXCLUSIVE; UPDATE initialization SET established=1 WHERE id=1; COMMIT;");
      this.initialized = true; // Durable observation precedes polling or any attempted dispatch.
    } catch { this.failed = true; throw failure(); }
  }
  claim(action: Action, body: Body) {
    if (this.failed || !this.initialized) throw failure();
    if (action === "state") return true;
    const key = receiptKey(action, body), lane = action === "stop" ? "stop" : "ordinary";
    try {
      this.db.exec("BEGIN EXCLUSIVE");
      if (this.db.prepare("SELECT key FROM receipts WHERE key=?").get(key)) { this.db.exec("COMMIT"); return false; }
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE lane=?").get(lane)?.n as number;
      if (count >= (lane === "stop" ? this.stopCapacity : this.capacity)) { this.db.exec("ROLLBACK"); return false; }
      this.db.prepare("INSERT INTO receipts(key,lane) VALUES (?,?)").run(key, lane);
      this.db.exec("COMMIT"); // A failed/ambiguous commit permanently disables this instance.
      return true;
    } catch { this.failed = true; throw failure(); }
  }
  close() { this.failed = true; this.db.close(); }
}

export interface ConnectorConfig { origin: string; token: string; backendToken: string; port: number; dataDir: string; }
export function connectorConfig(env: NodeJS.ProcessEnv, port: number, dataDir: string): ConnectorConfig | null {
  if (env.LIGHTESOTA_GISKARD_RELAY_ENABLED !== "1") return null;
  try {
    const origin = env.LIGHTESOTA_GISKARD_RELAY_ORIGIN ?? "", u = new URL(origin);
    const token = env.LIGHTESOTA_GISKARD_CONNECTOR_TOKEN, backendToken = env.LIGHTESOTA_GISKARD_TOKEN;
    if (u.protocol !== "https:" || !u.hostname || u.username || u.password || u.search || u.hash
      || origin !== u.origin || !tokenValid(token) || !tokenValid(backendToken) || token === backendToken
      || env.LIGHTESOTA_GISKARD_ENABLED !== "1" || !Number.isInteger(port) || port < 1 || port > 65535) throw failure();
    return { origin, token, backendToken, port, dataDir };
  } catch { throw failure(); }
}

type Reply = { status: number; raw: Buffer };
type Transport = (route: "session" | "poll" | "result", body: unknown, signal: AbortSignal) => Promise<any>;
type BackendTransport = (action: Action, body: Body, signal: AbortSignal, dispatch: string) => Promise<Reply>;

/** Only structured relay protocol codes are classified; exception messages never enter recovery. */
export class RelayConnectionError extends Error {
  constructor(readonly code = "unavailable") { super("Giskard relay connection unavailable"); }
}
/** Only local network/timeout events create this type; HTTP/protocol errors remain distinct. */
export class RelayTransportError extends RelayConnectionError {
  constructor() { super(); }
}

/** Node's direct HTTPS/HTTP clients ignore proxy environment variables and never follow redirects. */
function post(url: URL, token: string, body: unknown, signal: AbortSignal, dispatch?: string): Promise<Reply> {
  const raw = Buffer.from(JSON.stringify(body));
  if (raw.length > 8192) return Promise.reject(failure());
  return new Promise((resolve, reject) => {
    let httpFailure = false;
    const interrupted = () => reject(httpFailure ? failure() : new RelayTransportError());
    const request = (url.protocol === "https:" ? https : http).request(url, { method: "POST", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": raw.length,
        ...(dispatch ? { "x-lightesota-relay-dispatch": dispatch } : {}) } }, response => {
      httpFailure = response.statusCode !== 200; // A known HTTP refusal is not a lost success ACK.
      const chunks: Buffer[] = []; let length = 0;
      if (response.statusCode! >= 300 && response.statusCode! < 400 || response.headers["content-encoding"]
        || !/^application\/json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) { reject(failure()); response.destroy(); return; }
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 65536) { reject(failure()); response.destroy(); return; }
        chunks.push(chunk);
      });
      response.on("end", () => resolve({ status: response.statusCode!, raw: Buffer.concat(chunks) }));
      response.on("error", interrupted);
      response.on("aborted", interrupted);
    });
    request.on("error", interrupted); request.end(raw);
  });
}
export function cloudTransport(config: ConnectorConfig): Transport {
  return async (route, body, signal) => {
    const result = await post(new URL(`/api/connector/${route}`, config.origin), config.token, body, signal);
    let reply;
    try { reply = JSON.parse(result.raw.toString("utf8")); } catch { throw new RelayConnectionError(); }
    if (result.status !== 200) throw new RelayConnectionError(typeof reply?.code === "string" ? reply.code : "unavailable");
    return reply;
  };
}
export function backendTransport(config: ConnectorConfig): BackendTransport {
  return (action, body, signal, dispatch) => post(new URL(`http://127.0.0.1:${config.port}/api/integrations/giskard/${action}`), config.backendToken, body, signal, dispatch);
}
const wait = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms); signal.addEventListener("abort", done, { once: true });
});

export class GiskardConnector {
  private controller = new AbortController();
  private sessionController = new AbortController();
  private instance = randomBytes(32).toString("hex");
  private until = 0;
  private running?: Promise<void>;
  constructor(private config: ConnectorConfig, private ledger: ReceiptLedger, private gate = relayGate,
    private cloud: Transport = cloudTransport(config), private now = () => performance.now(),
    private backend: BackendTransport = backendTransport(config), private sleep = wait) {}
  private async call(route: "session" | "poll" | "result", body = {}, timeout = 2500) {
    const signal = AbortSignal.any([this.controller.signal, this.sessionController.signal, AbortSignal.timeout(timeout)]);
    try {
      const reply = await this.cloud(route, { ...body, session: this.instance }, signal);
      if (this.controller.signal.aborted || this.sessionController.signal.aborted
        || route !== "session" && this.now() >= this.until) throw new RelayConnectionError("session_expired");
      if (signal.aborted) throw new RelayTransportError();
      return reply;
    } catch (e) { throw e instanceof RelayConnectionError ? e : new RelayConnectionError(); }
  }
  start() { if (this.running) throw failure(); this.running = this.run(); return this.running; }
  stop() { this.controller.abort(); this.sessionController.abort(); this.gate.close(); }
  private async run() {
    let canInitialize = this.ledger.canInitialize, initialize = canInitialize, backoff = 1000;
    try {
      while (!this.controller.signal.aborted) {
        // Every recovery abandons the prior session and its work. Keep the same exclusive ledger.
        this.gate.close(); this.sessionController.abort(); this.until = 0;
        this.sessionController = new AbortController(); this.instance = randomBytes(32).toString("hex");
        try {
          const start = this.now(), reply = await this.call("session", { initialize });
          if (reply?.ok !== true || !Number.isFinite(reply.ttl) || reply.ttl <= 0 || reply.ttl > 30000) throw failure();
          this.ledger.observeMailbox();
          canInitialize = false; initialize = false;
          this.until = start + reply.ttl;
          let idle = 0;
          while (!this.controller.signal.aborted && this.now() < this.until) {
            const sent = this.now(), response = await this.call("poll");
            if (response?.ok !== true || !Number.isFinite(response.ttl) || response.ttl <= 0 || response.ttl > 30000) throw failure();
            this.until = sent + response.ttl; backoff = 1000;
            if (response.job) { await this.dispatch(response.job, sent); idle = 0; }
            else idle = Math.min(idle + 1, 4);
            if (!this.controller.signal.aborted) await this.sleep(idle ? Math.min(2000, 500 * idle) : 100, this.controller.signal);
          }
        } catch (e) {
          if (this.controller.signal.aborted) break;
          if (!(e instanceof RelayConnectionError)) throw e; // Invalid protocol or durable storage: disable.
          if (e.code === "session_busy") {
            this.ledger.observeMailbox(); // Consistent read proves existence, even before we own it.
            canInitialize = false;
          }
          if (e.code === "mailbox_missing") {
            // After an ambiguous first creation, first request initialize:false for readback.
            // Only a definitively missing, never-known-initialized mailbox may be created anew.
            if (!canInitialize || initialize) throw e;
            initialize = true;
          } else {
            initialize = false;
            if (["mailbox_invalid", "unauthorized", "identity_denied", "not_configured", "disabled", "invalid_request", "json_required"].includes(e.code)) throw e;
          }
        }
        this.gate.close(); this.sessionController.abort(); this.until = 0;
        if (!this.controller.signal.aborted) await this.sleep(backoff, this.controller.signal);
        backoff = Math.min(15000, backoff * 2);
      }
    } finally { this.stop(); this.ledger.close(); }
  }
  /** Public for dependency-injected tests; production only calls this from the single serialized loop. */
  async dispatch(job: Job, sent: number) {
    if (!validId(job?.id) || !["state", "lease", "apply", "stop"].includes(job.action) || !Number.isSafeInteger(job.fence)
      || !Number.isFinite(job.ttl) || job.ttl <= 0 || job.ttl > 3500 || !job.body?.identity || Buffer.byteLength(JSON.stringify(job.body)) > 8192) throw failure();
    // Measured from BEFORE the poll request, conservatively includes the outbound transit time.
    const until = Math.min(sent + job.ttl - 100, this.until);
    if (this.controller.signal.aborted || this.now() >= until) return;
    let result: Reply = { status: 503, raw: Buffer.from('{"ok":false,"code":"outcome_unknown"}') };
    if (this.ledger.claim(job.action, job.body)) {
      // Crash after claim and before send loses the operation safely. Never recover by replaying it.
      if (this.controller.signal.aborted || this.now() >= until) return;
      this.gate.open(job.id, job.action, job.body, until, job.fence);
      try {
        const response = await this.backend(job.action, job.body,
          AbortSignal.any([this.controller.signal, this.sessionController.signal, AbortSignal.timeout(Math.max(1, Math.floor(until - this.now())))]), job.id);
        if (!Buffer.isBuffer(response.raw) || response.raw.length > 65536 || response.raw.length === 0) throw failure();
        result = response;
      } catch { /* Unknown, never retry. The persisted receipt already prevents replay. */ }
      finally { this.gate.close(); }
    }
    if (this.controller.signal.aborted || this.now() >= this.until) return;
    // Each connector POST is <=8192 bytes, including envelopes. At most 13 chunks / 65536 bytes.
    const total = Math.ceil(result.raw.length / 5400);
    try {
      for (let index = 0; index < total; index++) {
        await this.call("result", { id: job.id, index, total, status: result.status,
          data: result.raw.subarray(index * 5400, (index + 1) * 5400).toString("base64") }, 1000);
      }
    } catch (e) {
      this.gate.close();
      // Abandon the entire result transfer, never retry a chunk or backend operation.
      // A lost ACK does not invalidate a still-live session; the next poll revalidates it.
      if (e instanceof RelayConnectionError && e.code === "expired") return;
      if (e instanceof RelayTransportError && !this.controller.signal.aborted && !this.sessionController.signal.aborted
        && this.now() < this.until) return;
      throw e; // Auth/config/protocol/storage errors and session loss retain their existing handling.
    }
  }
}

export function startGiskardConnector(env: NodeJS.ProcessEnv, port: number, directory: string) {
  let connector: GiskardConnector | undefined;
  try {
    const config = connectorConfig(env, port, directory);
    if (config) {
      connector = new GiskardConnector(config, new ReceiptLedger(directory));
      void connector.start().catch(() => { console.error("Giskard connector unavailable; operator review required."); });
    }
  } catch { console.error("Giskard connector disabled by invalid configuration or receipt storage."); }
  return () => connector?.stop();
}
