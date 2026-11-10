import type Anthropic from "@anthropic-ai/sdk";
import {
  engineFixtures, washFixtures, findProfile, findLaserLook, laserFixtures, laserIsOn, roleAllows, LASER_LOOKS, LASER_COLORS, LASER_PATTERNS, LASER_MUSIC_COLORS, LASER_PAN_MIN, LASER_PAN_MAX,
  type LaserState, type ParamValues, type Rig, type Role, type Settings,
} from "../../../shared/src/index.js";
import type { Library } from "../library.js";
import type { ShowController } from "../show.js";
import { testPattern } from "../engine/sandbox.js";

export interface AgentHost {
  library: Library;
  show: ShowController;
  getRig: () => Rig;
  getSettings: () => Settings;
  /** Called after a pattern is saved so live clients refresh and a live pattern reloads. */
  onPatternSaved: (id: string, applyLive?: boolean) => void;
}

/** Who is talking to the agent on this turn; gates the laser tools. */
export interface ToolCaller { role: Role; by: string }
export interface GiskardTurn { generation: number; assertLive(): void }
// Fixed capability, independent of role and model instructions. Future tools are denied by default.
const GISKARD_TOOLS = new Set(["get_rig", "get_show_state", "list_patterns", "read_pattern", "write_pattern", "apply_pattern", "set_params", "set_bpm", "set_master", "list_scenes", "get_lasers", "set_lasers", "lasers_off"]);
interface RemoteTools { check(): void; effect<T>(advances: number, fn: () => T): T; saves: number }

type ToolDef = Anthropic.Beta.Messages.BetaTool;

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "get_rig",
    description: "List the fixtures (id, name, kind, position, tags) and room dimensions.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "get_show_state",
    description: "Current pattern, its params, BPM, master level and blackout state.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "list_patterns",
    description: "All saved patterns with id, name, description, tags and param names.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "read_pattern",
    description: "Return the JavaScript source of a pattern.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    strict: true,
  },
  {
    name: "write_pattern",
    description: "Create or update a pattern from JavaScript source. Compiles it and renders 30 test frames; returns the id, the parsed params schema and a summary, or an error to fix. Pass id to update an existing user pattern (editing a built-in creates a copy).",
    input_schema: {
      type: "object",
      properties: {
        id: { type: ["string", "null"], description: "Existing pattern id to update, or null to create" },
        source: { type: "string", description: "Full pattern module source" },
      },
      required: ["id", "source"],
      additionalProperties: false,
    },
    strict: true,
    eager_input_streaming: true,
  },
  {
    name: "apply_pattern",
    description: "Make a pattern live on the rig, optionally with params and a crossfade.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        params: { type: ["string", "null"], description: "JSON object of param values to set, e.g. {\"speed\": 0.5} (others keep defaults)" },
        crossfadeMs: { type: ["number", "null"] },
      },
      required: ["id", "params", "crossfadeMs"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "set_params",
    description: "Change params of the live pattern (merged into current values).",
    input_schema: { type: "object", properties: { params: { type: "string", description: "JSON object of param values, e.g. {\"color\": \"#ff0000\"}" } }, required: ["params"], additionalProperties: false },
    strict: true,
  },
  {
    name: "set_bpm",
    description: "Set the global BPM.",
    input_schema: { type: "object", properties: { bpm: { type: "number" } }, required: ["bpm"], additionalProperties: false },
    strict: true,
  },
  {
    name: "set_master",
    description: "Set the master intensity 0..1.",
    input_schema: { type: "object", properties: { level: { type: "number" } }, required: ["level"], additionalProperties: false },
    strict: true,
  },
  {
    name: "save_scene",
    description: "Save the current look (pattern + params + BPM + master) as a named scene for later recall.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    strict: true,
  },
  {
    name: "list_scenes",
    description: "List saved scenes.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "get_lasers",
    description: "Laser status: armed or not, each laser's current preset, and the list of available looks. Typed pattern laser output requires explicit operator Follow authorization for the current pattern source.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "set_lasers",
    description: "Control already armed lasers with a look or per-laser presets. Requires an admin, a running show and no blackout. This tool never arms lasers, restarts stopped lighting or clears blackout. Use exactly one of look or lasers; pass null for the other.",
    input_schema: {
      type: "object",
      properties: {
        look: { type: ["string", "null"], description: `A look id from get_lasers (e.g. ${LASER_LOOKS.slice(0, 4).map((l) => l.id).join(", ")}), or null` },
        lasers: { type: ["string", "null"], description: `JSON array of {id, mode:"off"|"manual"|"music", pattern:"fan"|"wave", color:${JSON.stringify(LASER_COLORS)}, pan:${LASER_PAN_MIN}..${LASER_PAN_MAX}, musicColor:${JSON.stringify(LASER_MUSIC_COLORS)}}; only id is required, other fields keep their value. Or null.` },
      },
      required: ["look", "lasers"],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: "lasers_off",
    description: "Turn every laser off and disarm them. Any control role (guest, editor or admin) may do this, including after the turn has become stale.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

export const GISKARD_TOOL_DEFS = TOOL_DEFS.filter(t => GISKARD_TOOLS.has(t.name)).map(t => ({ ...t,
  description: t.name === "write_pattern" ? "Create a NEW saved pattern in the existing sandbox. Supplied IDs are copied, never overwritten. Use the returned ID. At most eight saves per request."
    : t.name === "apply_pattern" ? "Explicitly Start this pattern across the whole ordinary rig, including Hue gradients and manually owned washes. Clears ordinary manual overrides and solo selection; retains master. Never clears blackout/release or authorizes pattern lasers."
    : t.name === "set_lasers" ? "Use typed looks/presets on lasers an operator has ALREADY armed, while lighting is running. Never arms, clears gates or authorizes pattern Follow. Supply exactly one of look or lasers."
    : t.description,
}));

const str = (v: unknown, name: string) => { if (typeof v !== "string") throw new Error(`${name} must be a string`); return v; };
const num = (v: unknown, name: string) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`); return v; };
const obj = (v: unknown, name: string): Record<string, unknown> => {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { throw new Error(`${name} must be a JSON object`); } }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${name} must be an object`);
  return v as Record<string, unknown>;
};

/** Keep the turn's authority across all provider iterations; never renew it after a tool call. */
export function createTurnToolRunner(host: AgentHost, caller: ToolCaller = { role: "viewer", by: "" }, remote?: GiskardTurn) {
  let generation = remote?.generation ?? host.show.state.generation;
  const identity = { ...caller };
  const check = () => {
    if (!remote) return;
    remote.assertLive(); host.show.assertGeneration(generation);
    if (host.show.state.blackout || host.show.state.released) throw new Error("Remote output is blocked");
  };
  const authority: RemoteTools | undefined = remote ? { check, saves: 0, effect(advances, fn) {
    check();
    const expected = generation + advances;
    const result = fn();
    // Only the exact synchronous operation's known barriers carry forward. A reentrant
    // takeover, failure or external change can never be adopted as this request's authority.
    host.show.assertGeneration(expected); generation = expected; check(); return result;
  } } : undefined;
  return Object.assign((name: string, input: unknown) => runTool(host, name, input, identity, generation, authority), { assertActive: check });
}

/** Execute a tool call. Throws on invalid input or failure; the caller turns that into an error result. */
export function runTool(host: AgentHost, name: string, rawInput: unknown, caller: ToolCaller = { role: "viewer", by: "" }, generation = host.show.state.generation, remote?: RemoteTools): string {
  if (remote) {
    remote.check();
    if (!GISKARD_TOOLS.has(name)) throw new Error("Tool is not available to Giskard");
  }
  const effect = <T>(advances: number, fn: () => T): T => remote ? remote.effect(advances, fn) : fn();
  const laserControl = !!remote || roleAllows(caller.role, "admin");
  if ((name === "write_pattern" || name === "save_scene") && !roleAllows(caller.role, "guest")) throw new Error("A control role is required to save agent work");
  const changesOutput = ["apply_pattern", "set_params", "set_bpm", "set_master", "set_lasers"].includes(name);
  if (changesOutput) {
    if (!roleAllows(caller.role, "guest")) throw new Error("A control role is required to change the live show");
    host.show.assertGeneration(generation);
    if (!host.getSettings().agent.allowApply) throw new Error("Changing the live show from the agent is disabled in settings");
  }
  const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
  switch (name) {
    case "get_rig": {
      const rig = host.getRig();
      return JSON.stringify({
        room: rig.room,
        fixtures: engineFixtures(rig).map((f) => {
          const p = findProfile(f.profileId, rig.customProfiles);
          return { id: f.id, name: f.name, kind: !p ? "other" : p.transport === "hue" ? "hue" : p.colorModel === "dimmer" ? "spot" : "wash", x: f.x, y: f.y, tags: f.tags, profile: p?.name };
        }),
      });
    }
    case "get_show_state": {
      const s = host.show.state;
      return JSON.stringify({ patternId: s.patternId, params: s.params, bpm: s.transport.bpm, master: s.master, blackout: s.blackout, stopped: s.stopped, released: s.released, generation: s.generation, speed: s.speed, activeSceneId: s.activeSceneId });
    }
    case "list_patterns":
      return JSON.stringify(host.library.listPatterns().map((p) => ({ id: p.id, name: p.name, description: p.description, tags: p.tags, usesBeat: p.usesBeat, builtin: p.builtin, params: Object.keys(p.params), error: p.error, usesLasers: p.usesLasers })));
    case "read_pattern": {
      const p = host.library.getPattern(str(input.id, "id"));
      if (!p) throw new Error(`No pattern with id ${String(input.id)}`);
      return p.source;
    }
    case "write_pattern": {
      const source = str(input.source, "source");
      const id = remote || input.id == null ? undefined : str(input.id, "id");
      // Saving current source invalidates laser ownership synchronously. Decide whether the wash
      // reload was authorized before that invalidation, without renewing the rest of this turn.
      const applyLive = generation === host.show.state.generation && host.getSettings().agent.allowApply;
      if (remote && (Buffer.byteLength(source) > 65536 || remote.saves >= 8)) throw new Error("Remote pattern save limit reached");
      // Compilation can consume time. Check authority again immediately before writing bytes.
      const prepared = remote ? testPattern(source) : undefined;
      const saved = effect(0, () => host.library.savePattern({ id, source }, false, prepared));
      if (remote) remote.saves++;
      host.onPatternSaved(saved.id, remote ? false : applyLive);
      return JSON.stringify({ ok: true, id: saved.id, name: saved.name, params: saved.params, usesBeat: saved.usesBeat, swatch: saved.swatch, note: id && id !== saved.id ? "built-in was copied to a new user pattern" : undefined });
    }
    case "apply_pattern": {
      if (!host.getSettings().agent.allowApply) throw new Error("Applying patterns from the agent is disabled in settings");
      const id = str(input.id, "id");
      const params = input.params == null ? undefined : (obj(input.params, "params") as ParamValues);
      const fade = input.crossfadeMs == null ? undefined : num(input.crossfadeMs, "crossfadeMs");
      effect(1, () => host.show.setPattern(id, params, fade));
      if (remote) {
        const washes = washFixtures(host.getRig()).map(f => f.id);
        if (washes.length) effect(1, () => host.show.releaseWashes(washes));
        effect(1, () => host.show.clearOverrides());
        if (host.show.state.solo.length) effect(1, () => host.show.setSolo([]));
      }
      return JSON.stringify({ ok: true, params: host.show.state.params });
    }
    case "set_params":
      if (!host.getSettings().agent.allowApply) throw new Error("Changing the live show from the agent is disabled in settings");
      effect(host.library.getPattern(host.show.state.patternId ?? "") ? 1 : 0, () => host.show.setParams(obj(input.params, "params") as ParamValues, true));
      return JSON.stringify({ ok: true, params: host.show.state.params });
    case "set_bpm":
      effect(0, () => host.show.setBpm(num(input.bpm, "bpm")));
      return JSON.stringify({ ok: true, bpm: host.show.state.transport.bpm });
    case "set_master":
      effect(1, () => host.show.setMaster(num(input.level, "level")));
      return JSON.stringify({ ok: true, master: host.show.state.master });
    case "save_scene": {
      const s = host.show.captureScene(str(input.name, "name"));
      return JSON.stringify({ ok: true, id: s.id, name: s.name });
    }
    case "list_scenes":
      return JSON.stringify(host.library.scenes.map((s) => ({ id: s.id, name: s.name, patternId: s.patternId, bpm: s.bpm })));
    case "get_lasers": {
      const rig = host.getRig(); const L = host.show.state.lasers;
      return JSON.stringify({
        armed: L.armed, armedBy: L.armedBy, look: L.look, lookNote: L.look === "pattern" ? "the live pattern's lasers() is driving them" : undefined, blackout: host.show.state.blackout,
        stopped: host.show.state.stopped, released: host.show.state.released,
        callerMayControl: laserControl,
        canApplyNow: laserControl && host.getSettings().agent.allowApply && L.armed && !host.show.state.blackout && !host.show.state.stopped && !host.show.state.released,
        lasers: laserFixtures(rig).map((f) => ({ id: f.id, name: f.name, on: laserIsOn(L.fixtures[f.id], L.armed, host.show.state.blackout || host.show.state.stopped || host.show.state.released), ...(L.fixtures[f.id] ?? {}) })),
        looks: LASER_LOOKS.map((l) => ({ id: l.id, name: l.name, description: l.description, animated: l.animated })),
        vocabulary: { patterns: LASER_PATTERNS, colors: LASER_COLORS, musicColors: LASER_MUSIC_COLORS, pan: [LASER_PAN_MIN, LASER_PAN_MAX], note: "pan is the spread of the unit's two mirrored fans (low = together, high = apart), not a direction; tilt, zoom and strobe are fixed by the operator and cannot be changed" },
      });
    }
    case "set_lasers": {
      if (!laserControl) throw new Error(`Only an admin can control the lasers${caller.by ? ` (${caller.by} is not one)` : ""}. Use lasers_off to turn them off.`);
      const command = obj(rawInput, "set_lasers");
      if (Object.keys(command).some((key) => key !== "look" && key !== "lasers")) throw new Error("Unknown set_lasers field");
      const hasLook = command.look != null, hasLasers = command.lasers != null;
      if (hasLook === hasLasers) throw new Error("Give exactly one look or lasers array");
      const fixtures = laserFixtures(host.getRig());
      if (fixtures.length === 0) throw new Error("No enabled laser fixtures in the rig");
      const look = hasLook ? str(command.look, "look") : null;
      if (look !== null && !findLaserLook(look)) throw new Error(`Unknown laser look ${look}`);
      const patches: { id: string; patch: Partial<LaserState> }[] = [];
      if (hasLasers) {
        let list: unknown = command.lasers;
        if (typeof list === "string") {
          try { list = JSON.parse(list); } catch { throw new Error("lasers must be a JSON array"); }
        }
        if (!Array.isArray(list) || list.length === 0 || list.length > fixtures.length) throw new Error("lasers must be a nonempty array of enabled laser fixtures");
        const seen = new Set<string>();
        for (const item of list) {
          if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("laser must be an object");
          const o = item as Record<string, unknown>;
          if (Object.keys(o).some((key) => !["id", "mode", "pattern", "color", "pan", "musicColor"].includes(key))) throw new Error("Unknown laser field");
          const id = str(o.id, "laser.id");
          if (!fixtures.some((fixture) => fixture.id === id)) throw new Error(`Not an enabled laser fixture: ${id}`);
          if (seen.has(id)) throw new Error(`Duplicate laser fixture: ${id}`);
          seen.add(id);
          for (const [key, allowed] of [["mode", ["off", "manual", "music"]], ["pattern", LASER_PATTERNS], ["color", LASER_COLORS], ["musicColor", LASER_MUSIC_COLORS]] as const) {
            if (key in o && !(allowed as readonly unknown[]).includes(o[key])) throw new Error(`Invalid laser ${key}`);
          }
          if ("pan" in o && (typeof o.pan !== "number" || !Number.isInteger(o.pan) || o.pan < LASER_PAN_MIN || o.pan > LASER_PAN_MAX)) throw new Error(`laser pan must be an integer in ${LASER_PAN_MIN}..${LASER_PAN_MAX}`);
          const { id: _id, ...patch } = o;
          patches.push({ id, patch: patch as Partial<LaserState> });
        }
      }
      // The whole command is valid before any ownership or fixture state changes occur.
      if (!host.show.state.lasers.armed) throw new Error("An operator must explicitly arm lasers first");
      if (host.show.state.stopped) throw new Error("Lighting is stopped; an operator must explicitly Start first");
      if (host.show.state.blackout) throw new Error("Blackout is active; this tool cannot clear it");
      if (host.show.state.released) throw new Error("Output is released; this tool cannot take output control");
      if (look !== null) effect(1, () => host.show.setLaserLook(look));
      else for (const { id, patch } of patches) effect(1, () => host.show.setLaser(id, patch));
      return runTool(host, "get_lasers", {}, caller, generation, remote);
    }
    case "lasers_off":
      if (!roleAllows(caller.role, "guest")) throw new Error("A control role is required to turn lasers off");
      effect(1, () => host.show.lasersOff(caller.by ? `${caller.by} via agent` : "agent"));
      return JSON.stringify({ ok: true, armed: false });
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
