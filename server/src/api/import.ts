import { testPattern } from "../engine/sandbox.js";
import type { AppContext } from "./context.js";
import { object, idValue, textValue, validateRig, validateSettings, validateScene, validatePlaylist } from "./validate.js";
import { deepMerge } from "../store.js";

/** Prepare every record before the first saved byte or runtime change. No show state is imported. */
export function prepareImport(ctx: AppContext, raw: unknown) {
  const body = object(raw, "import");
  if (body.version !== undefined && body.version !== 1) throw new Error("Unsupported import version");
  const list = (v: unknown, label: string) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.length > 1000) throw new Error(`Invalid ${label} list`);
    return v;
  };
  const rig = validateRig(body.rig ?? ctx.rigFile.get());
  const settings = validateSettings(deepMerge(ctx.settingsFile.get(), body.settings));
  const ids = new Set<string>();
  const patterns = list(body.patterns, "patterns").map((raw) => {
    const p = object(raw, "pattern");
    const id = idValue(p.id);
    if (ids.has(id) || ctx.library.getPattern(id)?.builtin || id.startsWith("builtin-")) throw new Error("Duplicate or reserved imported pattern id");
    ids.add(id);
    const source = textValue(p.source, "pattern source", 1000000);
    const prepared = testPattern(source);
    return { id, source, prepared };
  });
  const scenes = list(body.scenes, "scenes").map((s) => validateScene(s, rig));
  const playlists = list(body.playlists, "playlists").map(validatePlaylist);
  for (const items of [scenes, playlists]) if (new Set(items.map((v) => v.id)).size !== items.length) throw new Error("Duplicate imported id");
  for (const s of scenes) if (s.patternId && !ids.has(s.patternId) && !ctx.library.getPattern(s.patternId)) throw new Error(`Missing pattern for scene ${s.id}`);
  const sceneIds = new Set([...ctx.library.scenes, ...scenes].map((s) => s.id));
  for (const p of playlists) for (const step of p.steps) if (!sceneIds.has(step.sceneId)) throw new Error(`Missing scene ${step.sceneId}`);
  return { rig, settings, patterns, scenes, playlists };
}
export function importData(ctx: AppContext, raw: unknown) {
  const data = prepareImport(ctx, raw);
  ctx.show.stopLighting();
  for (const p of data.patterns) ctx.library.savePattern(p, true, p.prepared);
  for (const s of data.scenes) ctx.library.upsertScene(s);
  for (const p of data.playlists) ctx.library.upsertPlaylist(p);
  ctx.rigFile.set(data.rig);
  ctx.settingsFile.set(data.settings);
  ctx.applyConfig();
}
