import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { findProfile, washFixtures, washSide, type FixtureOverride, type Rig, type WashMode } from "../../../shared/src/index.js";
import type { ShowController } from "../show.js";
import type { AgentService } from "../agent/agent.js";
import { OUTPUT_COMMISSIONED, PREVIEW } from "../output/policy.js";
import { isLoopback } from "./auth.js";
import { finite, idValue, object, validateOverride } from "./validate.js";
import { relayGate, type RelayGate } from "../integrations/giskard-relay.js";

const BODY_LIMIT = 8192;
const LEASE_MS = 120_000;
const WINDOW_MS = 60_000;
type Action = "state" | "lease" | "apply" | "stop";
interface Identity { teamId: string; channelId: string; userId: string; turnId: string; }
type Command =
  | { kind: "agent_request"; prompt: string }
  | { kind: "set_lights"; fixtureIds: string[]; brightness: number; color?: string }
  | { kind: "wash_mode"; fixtureIds: string[]; mode: WashMode; sensitivity?: number }
  | { kind: "quick_look"; fixtureIds: string[]; lookId: "warm-arrival" | "cyan-magenta" | "calm-blue" };
interface Lease { leaseId: string; identityKey: string; generation: number; expiresAt: number; until: number; used: boolean; }
interface Audit { actor: Identity; command: string; targetIds: string[]; generation: number; result: string; }
interface Context {
  show: ShowController;
  rigFile: { get(): Rig };
  agent: { cancelAll(): void } & Partial<Pick<AgentService, "requestLighting" | "lightingRequestStatus">>;
}
/** Dependency injection is for isolated tests; the mounted router always uses process policy. */
export interface GiskardOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  monotonicNow?: () => number;
  policy?: { preview: boolean; commissioned: boolean };
  audit?: (event: Audit) => void;
  maxLeases?: number;
  relayGate?: RelayGate;
}
class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
function exact(raw: unknown, keys: string[], label: string) {
  const value = object(raw, label);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(400, "invalid_request", `Unknown ${label} field`);
  return value;
}
const digest = (token: string) => createHash("sha256").update(token).digest();
const actorKey = (identity: Identity) => JSON.stringify([identity.teamId, identity.channelId, identity.userId, identity.turnId]);
const hex = (values: number[]) => "#" + values.slice(0, 3).map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

function settings(env: NodeJS.ProcessEnv) {
  const token = env.LIGHTESOTA_GISKARD_TOKEN ?? "";
  const teamId = env.LIGHTESOTA_GISKARD_TEAM_ID ?? "", channelId = env.LIGHTESOTA_GISKARD_CHANNEL_ID ?? "";
  const users = (env.LIGHTESOTA_GISKARD_USER_IDS ?? "").split(",").map((v) => v.trim());
  const valid = /^[\x21-\x7e]{32,1024}$/.test(token) && /^T[A-Z0-9]{2,31}$/.test(teamId)
    && /^C[A-Z0-9]{2,31}$/.test(channelId) && users.length <= 100 && users.every((u) => /^[UW][A-Z0-9]{2,31}$/.test(u));
  return { enabled: env.LIGHTESOTA_GISKARD_ENABLED === "1", valid, tokenDigest: digest(token), teamId, channelId, users: new Set(users) };
}

/** Separate authority: no browser cookie, existing bearer token, role, prompt or model may grant access. */
export function createGiskardApi(ctx: Context, options: GiskardOptions = {}) {
  const configured = settings(options.env ?? process.env);
  const policy = { ...(options.policy ?? { preview: PREVIEW, commissioned: OUTPUT_COMMISSIONED }) };
  const now = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const ownerKey = (i: Identity) => digest(JSON.stringify([i.teamId, i.channelId, i.userId])).toString("hex");
  const audit = options.audit ?? ((event: Audit) => console.info(JSON.stringify({ integration: "giskard", ...event })));
  const maxLeases = options.maxLeases ?? 10_000;
  function relayEffect(action: Action, req: Request) {
    const permit = req.headers["x-lightesota-relay-dispatch"];
    if (permit === undefined) return; // Existing direct callers retain exactly their authority.
    try {
      if (typeof permit !== "string" || !isLoopback(req.socket.remoteAddress) || req.destroyed) throw new Error();
      (options.relayGate ?? relayGate).consume(permit, action, req.body);
    } catch { fail(409, "relay_expired", "Connector dispatch is expired, unknown or already consumed"); }
  }
  // Never evict tombstones: old trusted turns must not become fresh after expiry, Stop or capacity pressure.
  // Process-local random IDs bind leases to this server boot; restart makes every prior lease unknown.
  const leases = new Map<string, Lease>();
  const turns = new Map<string, Lease>();
  const budgets = new Map<string, { startedAt: number; count: number }>();

  function limit(key: string, max: number) {
    const time = now(); let bucket = budgets.get(key);
    if (!bucket || time - bucket.startedAt >= WINDOW_MS) { bucket = { startedAt: time, count: 0 }; budgets.set(key, bucket); }
    if (++bucket.count > max) fail(429, "rate_limited", "Request limit reached; wait before retrying");
  }
  function report(identity: Identity, command: string, targetIds: string[], result: string) {
    // Exceptions and request bodies never enter the audit stream. Audit failure cannot replay a write.
    try { audit({ actor: { ...identity }, command, targetIds: [...targetIds], generation: ctx.show.state.generation, result }); } catch { /* no secret-bearing logger errors */ }
  }
  function error(res: Response, e: unknown) {
    const known = e instanceof ApiError;
    return res.status(known ? e.status : 500).json({ ok: false, code: known ? e.code : "operation_failed", error: known ? e.message : "Lighting operation failed; read current state before a new trusted turn" });
  }
  function guard(action: Action, req: Request, res: Response): boolean {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (!configured.enabled) fail(404, "disabled", "Integration is disabled");
      if (!configured.valid) fail(503, "not_configured", "Integration requires a dedicated token and explicit Slack team, channel and users");
      const header = req.headers.authorization;
      const match = typeof header === "string" && header.length <= 1031 ? /^Bearer ([^\s]+)$/i.exec(header) : null;
      if (!match || !timingSafeEqual(digest(match[1]), configured.tokenDigest)) fail(401, "unauthorized", "Dedicated Bearer authentication required");
      // TLS or an actual loopback tunnel hop. Never trust client-supplied forwarding headers.
      if (!(req.socket as typeof req.socket & { encrypted?: boolean }).encrypted && !isLoopback(req.socket.remoteAddress)) fail(403, "protected_transport_required", "Use HTTPS or a private protected tunnel terminating on loopback");
      // Only authenticated, protected traffic spends budgets; ordinary traffic cannot exhaust Stop.
      limit(action === "stop" ? "global:stop" : "global:ordinary", action === "stop" ? 120 : 240);
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] ?? "")) fail(415, "json_required", "Content-Type must be application/json");
      const length = req.headers["content-length"];
      if (typeof length === "string" && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) fail(413, "body_too_large", "JSON body exceeds 8192 bytes");
      return true;
    } catch (e) { error(res, e); return false; }
  }
  function identify(raw: unknown): Identity {
    const v = exact(raw, ["teamId", "channelId", "userId", "turnId"], "identity");
    if (typeof v.teamId !== "string" || !/^T[A-Z0-9]{2,31}$/.test(v.teamId)
      || typeof v.channelId !== "string" || !/^C[A-Z0-9]{2,31}$/.test(v.channelId)
      || typeof v.userId !== "string" || !/^[UW][A-Z0-9]{2,31}$/.test(v.userId)
      || typeof v.turnId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v.turnId)) fail(400, "invalid_request", "Invalid trusted identity");
    if (v.teamId !== configured.teamId || v.channelId !== configured.channelId || !configured.users.has(v.userId)) fail(403, "identity_denied", "Trusted identity is not allowed");
    return { teamId: v.teamId, channelId: v.channelId, userId: v.userId, turnId: v.turnId };
  }
  function ordinaryFixtures() {
    const rig = ctx.rigFile.get();
    const seen = new Set<string>();
    // Integration targets are saved fixtures, never internal gradient segments. Unknown
    // profiles and hazards cannot gain ordinary-fixture authority through incomplete rig data.
    return rig.fixtures.filter((f) => {
      const profile = findProfile(f.profileId, rig.customProfiles);
      if (!f.enabled || !profile || profile.kind === "laser" || profile.kind === "haze" || seen.has(f.id)) return false;
      seen.add(f.id);
      return true;
    });
  }
  function state() {
    const s = ctx.show.state, rig = ctx.rigFile.get(), fixtures = ordinaryFixtures();
    const washes = new Set(washFixtures(rig).map((f) => f.id));
    return {
      generation: s.generation, blackout: s.blackout, released: s.released, stopped: s.stopped, master: s.master,
      preview: policy.preview, commissioned: policy.commissioned,
      outputStatus: s.blackout ? "blackout" : s.released ? "released" : s.stopped ? "stopped" : s.master === 0 ? "master_zero" : policy.preview ? "preview" : !policy.commissioned ? "uncommissioned" : "commanded",
      fixtures: fixtures.map((f) => ({ id: f.id, name: f.name, tags: [...f.tags], side: washSide(f), transport: findProfile(f.profileId, rig.customProfiles)!.transport })),
      lights: fixtures.map((f) => {
        const wash = washes.has(f.id) ? s.washes[f.id] : undefined, ov = s.overrides[f.id];
        return wash ? { fixtureId: f.id, owner: wash.owner, mode: wash.mode, brightness: wash.brightness / 255 * 100, color: hex(wash.rgbw), white: wash.rgbw[3] / 255 * 100, sensitivity: wash.sensitivity }
          : { fixtureId: f.id, owner: ov ? "manual" : "pattern", brightness: ov?.dim === undefined ? null : ov.dim * 100, color: ov && [ov.r, ov.g, ov.b].every((v) => v !== undefined) ? hex([ov.r!, ov.g!, ov.b!].map((v) => v * 255)) : null };
      }),
      ownership: { authority: "lightesota", physicalState: "unverified", caveat: "Requested Lightesota state only; no physical fixture feedback. Independent senders, including Home Assistant, may still affect lights." },
    };
  }
  function validateCommand(raw: unknown): Command {
    try {
      const input = object(raw, "command");
      const kind = input.kind;
      if (kind === "agent_request") {
        const v = exact(input, ["kind", "prompt"], "command");
        if (typeof v.prompt !== "string" || !v.prompt.trim() || Buffer.byteLength(v.prompt) > 4096) fail(400, "invalid_command", "Prompt must be nonempty and at most 4096 UTF-8 bytes");
        return { kind, prompt: v.prompt };
      }
      const fields = kind === "set_lights" ? ["kind", "fixtureIds", "brightness", "color"] : kind === "wash_mode" ? ["kind", "fixtureIds", "mode", "sensitivity"] : kind === "quick_look" ? ["kind", "fixtureIds", "lookId"] : null;
      if (!fields) fail(400, "invalid_command", "Unsupported command kind");
      const v = exact(input, fields, "command");
      if (!Array.isArray(v.fixtureIds) || !v.fixtureIds.length || v.fixtureIds.length > 128) fail(400, "invalid_command", "Choose 1..128 unique fixture IDs");
      const fixtureIds = v.fixtureIds.map((id) => idValue(id));
      const allowed = kind === "set_lights" ? ordinaryFixtures() : washFixtures(ctx.rigFile.get());
      if (new Set(fixtureIds).size !== fixtureIds.length || fixtureIds.some((id) => !allowed.some((f) => f.id === id))) fail(400, "invalid_command", "Every target must be an enabled ordinary fixture; modes and quick looks require existing washes");
      if (kind === "set_lights") {
        const brightness = finite(v.brightness, 0, 100, "brightness");
        if (v.color !== undefined && (typeof v.color !== "string" || !/^#[0-9a-f]{6}$/i.test(v.color))) fail(400, "invalid_command", "Color must be #RRGGBB");
        return { kind, fixtureIds, brightness, ...(v.color === undefined ? {} : { color: (v.color as string).toLowerCase() }) };
      }
      if (kind === "wash_mode") {
        if (!["off", "normal", "music6", "music32"].includes(v.mode as string)) fail(400, "invalid_command", "Unsupported wash mode");
        return { kind, fixtureIds, mode: v.mode as WashMode, ...(v.sensitivity === undefined ? {} : { sensitivity: finite(v.sensitivity, 11, 255, "sensitivity", true) }) };
      }
      if (!["warm-arrival", "cyan-magenta", "calm-blue"].includes(v.lookId as string)) fail(400, "invalid_command", "Unsupported quick look");
      return { kind: "quick_look", fixtureIds, lookId: v.lookId as "warm-arrival" | "cyan-magenta" | "calm-blue" };
    } catch (e) { if (e instanceof ApiError) throw e; return fail(400, "invalid_command", "Invalid command fields or values"); }
  }
  function usable(lease: Lease | undefined, identity: Identity): Lease {
    if (!lease || lease.identityKey !== actorKey(identity) || lease.used || now() >= lease.expiresAt || monotonicNow() >= lease.until || lease.generation !== ctx.show.state.generation) fail(409, "invalid_lease", "Lease is unknown, expired, consumed or stale; a new trusted user turn is required");
    return lease;
  }
  function prepareApply(command: Exclude<Command, { kind: "agent_request" }>): () => void {
    if (command.kind === "quick_look") return () => ctx.show.quickLook(command.lookId, command.fixtureIds);
    if (command.kind === "wash_mode") return () => ctx.show.setWash(command.fixtureIds, { mode: command.mode, ...(command.sensitivity === undefined ? {} : { sensitivity: command.sensitivity }) });
    const washIds = new Set(washFixtures(ctx.rigFile.get()).map((f) => f.id));
    const selectedWashes = command.fixtureIds.filter((id) => washIds.has(id));
    const rgb = command.color ? [1, 3, 5].map((i) => parseInt(command.color!.slice(i, i + 2), 16)) : undefined;
    const overrides: { id: string; ov: FixtureOverride }[] = [];
    for (const id of command.fixtureIds.filter((id) => !washIds.has(id))) {
      const previous = ctx.show.state.overrides[id];
      const frame = ctx.show.engine.lastFrame, i = frame?.fixtures.findIndex((f) => (f.parentId ?? f.id) === id) ?? -1;
      const values = i >= 0 && frame ? Array.from(frame.values.slice(i * 8, i * 8 + 6)) : [0, 0, 0, 0, 0, 0];
      const ov: FixtureOverride = { r: values[0], g: values[1], b: values[2], w: values[3], a: values[4], uv: values[5], ...previous, mix: 1, dim: command.brightness / 100 };
      if (rgb) Object.assign(ov, { r: rgb[0] / 255, g: rgb[1] / 255, b: rgb[2] / 255, w: 0, a: 0, uv: 0 });
      overrides.push({ id, ov: validateOverride(ov) });
    }
    // Precompute every ordinary override before any selected wash can change state.
    return () => {
      if (selectedWashes.length) ctx.show.setWash(selectedWashes, { brightness: Math.round(command.brightness * 255 / 100), ...(rgb ? { rgbw: [...rgb, 0] as [number, number, number, number] } : {}) });
      for (const { id, ov } of overrides) ctx.show.setOverride(id, ov);
    };
  }
  function handleBody(action: Action, req: Request, res: Response) {
    let identity: Identity | undefined, command: Command | undefined;
    try {
      if (Buffer.byteLength(JSON.stringify(req.body) ?? "") > BODY_LIMIT) fail(413, "body_too_large", "JSON body exceeds 8192 bytes");
      let body: Record<string, unknown>;
      try { body = exact(req.body, action === "apply" ? ["identity", "leaseId", "command"] : action === "state" ? ["identity", "requestId"] : ["identity"], "request"); identity = identify(body.identity); }
      catch (e) { if (e instanceof ApiError) throw e; fail(400, "invalid_request", "Expected a JSON object with a trusted identity"); }
      limit(`${identity!.userId}:${action === "stop" ? "stop" : "ordinary"}`, action === "stop" ? 30 : 60);
      if (action === "state") {
        if (body!.requestId !== undefined && (typeof body!.requestId !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(body!.requestId))) fail(400, "invalid_request", "Invalid requestId");
        relayEffect(action, req);
        return res.json({ ok: true, state: state(), request: ctx.agent.lightingRequestStatus?.(ownerKey(identity!), body!.requestId as string | undefined) ?? { status: "unknown" } });
      }
      if (action === "lease") {
        relayEffect(action, req);
        const key = actorKey(identity!); let lease = turns.get(key);
        if (lease) lease = usable(lease, identity!);
        else {
          if (turns.size >= maxLeases) fail(503, "lease_capacity", "Lease ledger is full; operator maintenance is required");
          lease = { leaseId: randomBytes(32).toString("base64url"), identityKey: key, generation: ctx.show.state.generation, expiresAt: now() + LEASE_MS, until: monotonicNow() + LEASE_MS, used: false };
          turns.set(key, lease); leases.set(lease.leaseId, lease);
        }
        report(identity!, "lease", [], "ok");
        return res.json({ ok: true, leaseId: lease.leaseId, generation: lease.generation, expiresAt: lease.expiresAt, remainingMutations: 1, command: { kind: "lease" }, state: state(), preview: policy.preview, physicalOutput: "unverified" });
      }
      if (action === "stop") {
        relayEffect(action, req);
        // Strong Stop comes first: even a failing cancellation callback cannot prevent the barrier.
        try { ctx.show.stopLighting(); } finally { ctx.agent.cancelAll(); }
        report(identity!, "stop", [], "ok");
        return res.json({ ok: true, command: { kind: "stop" }, state: state(), preview: policy.preview, physicalOutput: "unverified" });
      }
      command = validateCommand(body!.command);
      if (typeof body!.leaseId !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body!.leaseId)) fail(400, "invalid_request", "Invalid leaseId");
      if (!policy.preview && !policy.commissioned) fail(503, "uncommissioned", "Output is not commissioned; state and Stop remain available");
      if (ctx.show.state.blackout || ctx.show.state.released) fail(409, "output_blocked", "Output is blacked out or released; an operator must resolve it");
      const apply = command.kind === "agent_request" ? undefined : prepareApply(command);
      const lease = usable(leases.get(body!.leaseId as string), identity!);
      // Consume before any effect; errors cannot authorize a duplicate. No await or callback between
      // the final generation assertion and the synchronous ShowController mutation batch.
      relayEffect(action, req);
      lease.used = true;
      ctx.show.assertGeneration(lease.generation);
      if (command.kind === "agent_request") {
        if (!ctx.agent.requestLighting) fail(503, "agent_unavailable", "Lighting agent is unavailable");
        const request = ctx.agent.requestLighting(command.prompt, ownerKey(identity!), lease.generation, Math.min(lease.expiresAt - now(), lease.until - monotonicNow()));
        report(identity!, command.kind, [], "accepted");
        return res.status(202).json({ ok: true, command: { kind: command.kind }, request, preview: policy.preview, physicalOutput: "unverified" });
      }
      apply!();
      report(identity!, command.kind, command.fixtureIds, "ok");
      return res.json({ ok: true, command, state: state(), preview: policy.preview, physicalOutput: "unverified" });
    } catch (e) {
      if (identity) report(identity, command?.kind ?? action, command && "fixtureIds" in command ? command.fixtureIds : [], e instanceof ApiError ? e.code : "operation_failed");
      return error(res, e);
    }
  }
  return { guard, handleBody, handle(action: Action, req: Request, res: Response) { if (guard(action, req, res)) return handleBody(action, req, res); } };
}

/** Mount before the application's general JSON parser to enforce this API's smaller body bound. */
export function createGiskardRouter(ctx: Context, options?: GiskardOptions) {
  const router = express.Router(), api = createGiskardApi(ctx, options);
  const json = express.json({ limit: BODY_LIMIT, strict: true, inflate: false });
  router.use((req, res, next) => {
    if (req.method !== "POST" || !["state", "lease", "apply", "stop"].some(a => req.originalUrl === `/api/integrations/giskard/${a}`)) {
      res.status(404).json({ ok: false, code: "not_found", error: "Unknown integration endpoint" }); return;
    }
    next();
  });
  for (const action of ["state", "lease", "apply", "stop"] as const) {
    router.post(`/${action}`, (req, res, next) => {
      if (!api.guard(action, req, res)) return;
      const deadline = setTimeout(() => { if (!res.headersSent) res.status(408).json({ ok: false, code: "request_timeout", error: "Request deadline exceeded" }); req.destroy(); }, 15_000);
      deadline.unref(); res.once("close", () => clearTimeout(deadline)); res.once("finish", () => clearTimeout(deadline));
      next();
    }, json, (req, res) => {
      if (req.destroyed || res.headersSent || res.writableEnded) return;
      api.handleBody(action, req, res);
    });
  }
  router.use((_req, res) => { res.status(404).json({ ok: false, code: "not_found", error: "Unknown integration endpoint" }); });
  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent || res.writableEnded) return;
    const status = (err as { status?: number })?.status;
    res.status(status === 413 ? 413 : status === 415 ? 415 : 400).json({ ok: false, code: status === 413 ? "body_too_large" : "invalid_json", error: status === 413 ? "JSON body exceeds 8192 bytes" : "A valid uncompressed JSON body is required" });
  });
  return router;
}
