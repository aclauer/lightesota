import type Anthropic from "@anthropic-ai/sdk";
import {
  engineFixtures, findProfile, laserFixtures, laserIsOn, roleAllows, LASER_LOOKS, LASER_COLORS, LASER_PATTERNS, LASER_MUSIC_COLORS, LASER_PAN_MIN, LASER_PAN_MAX,
  type LaserState, type ParamValues, type Rig, type Role, type Settings,
} from "../../../shared/src/index.js";
import type { Library } from "../library.js";
import type { ShowController } from "../show.js";

export interface AgentHost {
  library: Library;
  show: ShowController;
  getRig: () => Rig;
  getSettings: () => Settings;
  /** Called after a pattern is saved so live clients refresh and a live pattern reloads. */
  onPatternSaved: (id: string) => void;
}

/** Who is talking to the agent on this turn; gates the laser tools. */
export interface ToolCaller { role: Role; by: string }

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
    description: "Laser status: armed or not, each laser's current preset, and the list of available looks. Lasers are operator-only fixtures with a fixed preset vocabulary; patterns cannot drive them.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
  {
    name: "set_lasers",
    description: "Turn the lasers on with a look or per-laser presets (arms them if needed). Only works when the person asking is an admin. Use look for a named combination, or lasers for per-laser settings; pass null for the one you are not using.",
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
    description: "Turn every laser off and disarm them. Anyone may do this.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  },
];

const str = (v: unknown, name: string) => { if (typeof v !== "string") throw new Error(`${name} must be a string`); return v; };
const num = (v: unknown, name: string) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`); return v; };
const obj = (v: unknown, name: string): Record<string, unknown> => {
  if (typeof v === "string") { try { v = JSON.parse(v); } catch { throw new Error(`${name} must be a JSON object`); } }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${name} must be an object`);
  return v as Record<string, unknown>;
};

/** Execute a tool call. Throws on invalid input or failure; the caller turns that into an error result. */
export function runTool(host: AgentHost, name: string, rawInput: unknown, caller: ToolCaller = { role: "admin", by: "" }): string {
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
      return JSON.stringify({ patternId: s.patternId, params: s.params, bpm: s.transport.bpm, master: s.master, blackout: s.blackout, speed: s.speed, activeSceneId: s.activeSceneId });
    }
    case "list_patterns":
      return JSON.stringify(host.library.listPatterns().map((p) => ({ id: p.id, name: p.name, description: p.description, tags: p.tags, usesBeat: p.usesBeat, builtin: p.builtin, params: Object.keys(p.params), error: p.error })));
    case "read_pattern": {
      const p = host.library.getPattern(str(input.id, "id"));
      if (!p) throw new Error(`No pattern with id ${String(input.id)}`);
      return p.source;
    }
    case "write_pattern": {
      const source = str(input.source, "source");
      const id = input.id == null ? undefined : str(input.id, "id");
      const saved = host.library.savePattern({ id, source });
      host.onPatternSaved(saved.id);
      return JSON.stringify({ ok: true, id: saved.id, name: saved.name, params: saved.params, usesBeat: saved.usesBeat, swatch: saved.swatch, note: id && id !== saved.id ? "built-in was copied to a new user pattern" : undefined });
    }
    case "apply_pattern": {
      if (!host.getSettings().agent.allowApply) throw new Error("Applying patterns from the agent is disabled in settings");
      const id = str(input.id, "id");
      const params = input.params == null ? undefined : (obj(input.params, "params") as ParamValues);
      const fade = input.crossfadeMs == null ? undefined : num(input.crossfadeMs, "crossfadeMs");
      host.show.setPattern(id, params, fade);
      return JSON.stringify({ ok: true, params: host.show.state.params });
    }
    case "set_params":
      if (!host.getSettings().agent.allowApply) throw new Error("Changing the live show from the agent is disabled in settings");
      host.show.setParams(obj(input.params, "params") as ParamValues, true);
      return JSON.stringify({ ok: true, params: host.show.state.params });
    case "set_bpm":
      host.show.setBpm(num(input.bpm, "bpm"));
      return JSON.stringify({ ok: true, bpm: host.show.state.transport.bpm });
    case "set_master":
      host.show.setMaster(num(input.level, "level"));
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
        callerMayControl: roleAllows(caller.role, "admin"),
        lasers: laserFixtures(rig).map((f) => ({ id: f.id, name: f.name, on: laserIsOn(L.fixtures[f.id], L.armed, host.show.state.blackout), ...(L.fixtures[f.id] ?? {}) })),
        looks: LASER_LOOKS.map((l) => ({ id: l.id, name: l.name, description: l.description, animated: l.animated })),
        vocabulary: { patterns: LASER_PATTERNS, colors: LASER_COLORS, musicColors: LASER_MUSIC_COLORS, pan: [LASER_PAN_MIN, LASER_PAN_MAX], note: "pan is the spread of the unit's two mirrored fans (low = together, high = apart), not a direction; tilt, zoom and strobe are fixed by the operator and cannot be changed" },
      });
    }
    case "set_lasers": {
      if (!roleAllows(caller.role, "admin")) throw new Error(`Only an admin can turn the lasers on${caller.by ? ` (${caller.by} is not one)` : ""}. Anyone can turn them off with lasers_off.`);
      if (!host.getSettings().agent.allowApply) throw new Error("Changing the live show from the agent is disabled in settings");
      const rig = host.getRig();
      if (laserFixtures(rig).length === 0) throw new Error("No enabled laser fixtures in the rig");
      if (host.show.state.blackout) host.show.setBlackout(false);
      if (!host.show.state.lasers.armed) host.show.armLasers(true, caller.by ? `${caller.by} via agent` : "agent");
      const look = input.look == null ? null : str(input.look, "look");
      if (look) host.show.setLaserLook(look);
      if (input.lasers != null) {
        const list = typeof input.lasers === "string" ? JSON.parse(input.lasers) : input.lasers;
        if (!Array.isArray(list)) throw new Error("lasers must be a JSON array");
        for (const item of list) {
          const o = obj(item, "laser");
          const id = str(o.id, "laser.id");
          const { id: _id, ...patch } = o;
          host.show.setLaser(id, patch as Partial<LaserState>);
        }
      }
      if (!look && input.lasers == null) throw new Error("Give a look or a lasers array");
      return runTool(host, "get_lasers", {}, caller);
    }
    case "lasers_off":
      host.show.lasersOff(caller.by ? `${caller.by} via agent` : "agent");
      return JSON.stringify({ ok: true, armed: false });
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
