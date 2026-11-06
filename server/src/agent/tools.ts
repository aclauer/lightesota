import type Anthropic from "@anthropic-ai/sdk";
import { findProfile, type ParamValues, type Rig, type Settings } from "@lightesota/shared";
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
        params: { type: ["object", "null"], additionalProperties: true, description: "Param values to set (others keep defaults)" },
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
    input_schema: { type: "object", properties: { params: { type: "object", additionalProperties: true } }, required: ["params"], additionalProperties: false },
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
];

const str = (v: unknown, name: string) => { if (typeof v !== "string") throw new Error(`${name} must be a string`); return v; };
const num = (v: unknown, name: string) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`); return v; };
const obj = (v: unknown, name: string): Record<string, unknown> => { if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${name} must be an object`); return v as Record<string, unknown>; };

/** Execute a tool call. Throws on invalid input or failure; the caller turns that into an error result. */
export function runTool(host: AgentHost, name: string, rawInput: unknown): string {
  const input = (typeof rawInput === "object" && rawInput !== null ? rawInput : {}) as Record<string, unknown>;
  switch (name) {
    case "get_rig": {
      const rig = host.getRig();
      return JSON.stringify({
        room: rig.room,
        fixtures: rig.fixtures.filter((f) => f.enabled).map((f) => {
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
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
