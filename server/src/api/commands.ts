import { LASER_COLORS, LASER_MUSIC_COLORS, LASER_PATTERNS, findProfile, requiredRole, roleAllows, type ClientMessage, type Role } from "../../../shared/src/index.js";
import type { AppContext } from "./context.js";
import { finite, object, textValue, validateOverride } from "./validate.js";

export class CommandError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const TYPES = new Set([
  "setPattern", "setParams", "setMaster", "setBlackout", "setSpeed", "setCrossfade", "setBpm", "tap", "resync", "nudge", "setOverride", "clearOverrides", "setSolo", "armLasers", "setLaser", "setLaserLook", "followPatternLasers", "lasersOff", "setReleased", "recallScene", "playPlaylist", "stopPlaylist", "playlistNext", "playlistPrev", "testFixture", "setFollowMicBpm", "setSleep", "stopLighting", "takeManualControl", "setWash", "releaseWashes", "quickLook", "startCoordinatedShow",
]);
export const isControlCommand = (v: unknown): boolean => !!v && typeof v === "object" && TYPES.has((v as {type:string}).type);
function boolean(v: unknown, label: string): boolean { if (typeof v !== "boolean") throw new CommandError(`${label} must be boolean`); return v; }
function ids(v: unknown): string[] { if (!Array.isArray(v) || v.length > 512 || !v.every((x) => typeof x === "string")) throw new CommandError("fixtureIds must be an array of ids"); return v; }

/** The single validated browser + machine command path. No physical transport calls here. */
export function dispatchControl(ctx: AppContext, raw: unknown, actor: {role: Role; name: string}, generation: unknown): void {
  const msg = object(raw, "command") as unknown as ClientMessage;
  if (!isControlCommand(msg)) throw new CommandError("Unknown control command");
  if (!roleAllows(actor.role, requiredRole(msg))) throw new CommandError("Not allowed for this role", 403);
  const show = ctx.show;
  const safeStop = msg.type === "stopLighting" || msg.type === "lasersOff" || (msg.type === "armLasers" && msg.armed === false) || (msg.type === "setBlackout" && msg.blackout === true) || (msg.type === "setReleased" && msg.released === true);
  if (!safeStop && generation !== show.state.generation) throw new CommandError("Stale control generation; refresh state and deliberately retry", 409);
  const ordinary = (id: string) => {
    const f = ctx.rigFile.get().fixtures.find((f) => f.id === id && f.enabled);
    if (!f || findProfile(f.profileId, ctx.rigFile.get().customProfiles)?.kind === "laser") throw new CommandError("Override/test must target an enabled ordinary fixture");
  };
  switch (msg.type) {
    case "stopLighting": show.stopLighting(); return;
    case "takeManualControl": show.takeManualControl(msg.fixtureIds === undefined ? undefined : ids(msg.fixtureIds)); return;
    case "setWash": show.setWash(ids(msg.fixtureIds), msg.patch); return;
    case "releaseWashes": show.releaseWashes(ids(msg.fixtureIds)); return;
    case "quickLook":
      if (msg.lookId === "laser-duo" && actor.role !== "admin") throw new CommandError("Laser looks require an operator", 403);
      show.quickLook(msg.lookId, msg.fixtureIds === undefined ? undefined : ids(msg.fixtureIds)); return;
    case "startCoordinatedShow":
      if (msg.params?.includeLasers && actor.role !== "admin") throw new CommandError("Including lasers requires an operator", 403);
      show.startCoordinatedShow(msg.params); return;
    case "setPattern":
      if (msg.patternId !== null) textValue(msg.patternId, "patternId");
      if (msg.crossfadeMs !== undefined) finite(msg.crossfadeMs, 0, 20000, "crossfade");
      show.setPattern(msg.patternId, msg.params, msg.crossfadeMs, false, actor.name); return;
    case "setParams": object(msg.params, "params"); show.setParams(msg.params, msg.merge ?? true); return;
    case "setMaster": show.setMaster(finite(msg.master, 0, 1, "master")); return;
    case "setBlackout": show.setBlackout(boolean(msg.blackout, "blackout")); return;
    case "setSpeed": show.setSpeed(finite(msg.speed, 0, 4, "speed")); return;
    case "setCrossfade": show.setCrossfade(finite(msg.crossfadeMs, 0, 20000, "crossfade")); return;
    case "setBpm": show.setBpm(finite(msg.bpm, 20, 300, "bpm")); return;
    case "tap": show.tap(); return;
    case "resync": show.resync(); return;
    case "nudge": show.nudge(finite(msg.ms, -5000, 5000, "nudge")); return;
    case "setOverride": ordinary(msg.fixtureId); show.setOverride(msg.fixtureId, msg.override === null ? null : validateOverride(msg.override)); return;
    case "clearOverrides": show.clearOverrides(); return;
    case "setSolo": ids(msg.fixtureIds).forEach(ordinary); show.setSolo(msg.fixtureIds); return;
    case "armLasers": show.armLasers(boolean(msg.armed, "armed"), actor.name); return;
    case "setLaser": {
      const s = object(msg.state, "laser state");
      if (Object.keys(s).some((k) => !["mode", "pattern", "color", "pan", "musicColor"].includes(k))) throw new CommandError("Unknown laser field");
      for (const [key, allowed] of [["mode", ["off", "manual", "music"]], ["pattern", LASER_PATTERNS], ["color", LASER_COLORS], ["musicColor", LASER_MUSIC_COLORS]] as const) {
        if (s[key] !== undefined && !(allowed as readonly unknown[]).includes(s[key])) throw new CommandError(`Invalid laser ${key}`);
      }
      if (s.pan !== undefined) finite(s.pan, 48, 80, "laser pan", true);
      show.setLaser(textValue(msg.fixtureId, "fixtureId"), msg.state); return;
    }
    case "setLaserLook": show.setLaserLook(msg.lookId === null ? null : textValue(msg.lookId, "lookId")); return;
    case "followPatternLasers": show.followPatternLasers(textValue(msg.patternId, "patternId"), finite(msg.revision, 0, Number.MAX_SAFE_INTEGER, "revision", true)); return;
    case "lasersOff": show.lasersOff(actor.name); return;
    case "setReleased": show.setReleased(boolean(msg.released, "released")); return;
    case "recallScene":
      if (msg.crossfadeMs !== undefined) finite(msg.crossfadeMs, 0, 20000, "crossfade");
      show.recallScene(textValue(msg.sceneId, "sceneId"), msg.crossfadeMs, actor.name); return;
    case "playPlaylist":
      if (msg.stepIndex !== undefined) finite(msg.stepIndex, 0, 1000, "stepIndex", true);
      show.playPlaylist(textValue(msg.playlistId, "playlistId"), msg.stepIndex); return;
    case "stopPlaylist": show.stopPlaylist(); return;
    case "playlistNext": show.playlistNext(); return;
    case "playlistPrev": show.playlistPrev(); return;
    case "testFixture": ordinary(msg.fixtureId); show.testFixture(msg.fixtureId, msg.seconds === undefined ? 2 : finite(msg.seconds, 0.5, 10, "seconds")); return;
    case "setFollowMicBpm": show.setFollowMicBpm(boolean(msg.on, "follow microphone BPM")); return;
    case "setSleep": show.setSleep(msg.minutes === null ? null : finite(msg.minutes, 0.01, 1440, "minutes")); return;
    default: throw new CommandError("Unknown control command");
  }
}
