import { BUILTIN_PROFILES, HERMES_MODEL, findProfile, validateWashPatch, type Fixture, type FixtureProfile, type Rig, type Settings, type Scene, type Playlist, type FixtureOverride } from "../../../shared/src/index.js";

export function object(v: unknown, label: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${label} must be an object`);
  return v as Record<string, unknown>;
}
export function finite(v: unknown, lo: number, hi: number, label: string, integer = false): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) throw new Error(`${label} must be a finite ${integer ? "integer" : "number"} in ${lo}..${hi}`);
  return v;
}
export function textValue(v: unknown, label: string, max = 200): string {
  if (typeof v !== "string" || v.length > max) throw new Error(`${label} must be a string of at most ${max} characters`);
  return v;
}
export function idValue(v: unknown): string {
  const id = textValue(v, "id", 100);
  if (!/^[\w-]+$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid id");
  return id;
}
function array(v: unknown, label: string, max = 512): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new Error(`${label} must be an array (max ${max})`);
  return v;
}
function bool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${label} must be boolean`);
  return v;
}
export function validateOverride(raw: unknown): FixtureOverride {
  const v = object(raw, "override");
  for (const k of Object.keys(v)) {
    if (!["r", "g", "b", "w", "a", "uv", "dim", "mix"].includes(k)) throw new Error(`Unknown override field ${k}`);
    finite(v[k], 0, 1, k);
  }
  return { ...v } as FixtureOverride;
}
export function validateAudio(raw: unknown): import("../../../shared/src/index.js").AudioFrame {
  const a = object(raw, "audio");
  for (const key of ["level", "bass", "mid", "high"]) finite(a[key], 0, 1, `audio ${key}`);
  bool(a.onset, "audio onset"); if (a.bpm !== null) finite(a.bpm, 20, 300, "audio BPM");
  return { level: a.level as number, bass: a.bass as number, mid: a.mid as number, high: a.high as number, onset: a.onset as boolean, bpm: a.bpm as number | null };
}
function validateProfile(raw: unknown): FixtureProfile {
  const p = object(raw, "profile");
  const id = idValue(p.id);
  if (BUILTIN_PROFILES.some((b) => b.id === id)) throw new Error("Custom profiles cannot shadow a built-in profile");
  if (p.kind && p.kind !== "light") throw new Error("Custom laser/haze profiles are reserved");
  if (!["dmx", "hue"].includes(p.transport as string) || !["rgb", "rgbw", "rgbaw-uv", "dimmer"].includes(p.colorModel as string)) throw new Error("Invalid profile transport/color model");
  const channels = array(p.channels, "channels").map((raw) => {
    const c = object(raw, "channel");
    if (!["dimmer", "red", "green", "blue", "white", "amber", "uv", "strobe", "fixed"].includes(c.fn as string)) throw new Error("Invalid channel function");
    textValue(c.name, "channel name");
    if (c.value !== undefined) finite(c.value, 0, 255, "fixed byte", true);
    if (c.off !== undefined) finite(c.off, 0, 255, "off byte", true);
    if (c.range !== undefined) {
      const range = array(c.range, "range", 2);
      if (range.length !== 2) throw new Error("Invalid channel range");
      finite(range[0], 0, 255, "range", true); finite(range[1], range[0] as number, 255, "range", true);
    }
    return { ...c };
  });
  if (p.transport === "dmx" && !channels.length) throw new Error("Empty DMX profile");
  if (p.size !== undefined) finite(p.size, 0.01, 200, "profile size");
  return { ...p, id, name: textValue(p.name, "profile name"), channels } as unknown as FixtureProfile;
}
/** Transactional validation: no IO and no mutations before the entire graph is accepted. */
export function validateRig(raw: unknown): Rig {
  const input = object(raw, "rig");
  const room = object(input.room, "room");
  const shapes = array(room.shapes ?? [], "room shapes", 200).map((raw) => {
    const s = object(raw, "shape"); idValue(s.id);
    if (!["rect", "line", "label"].includes(s.kind as string)) throw new Error("Invalid room shape");
    for (const key of ["x", "y", "w", "h", "x2", "y2"]) if (s[key] !== undefined) finite(s[key], -1000, 1000, `shape ${key}`);
    return { ...s };
  });
  const customProfiles = array(input.customProfiles ?? [], "profiles", 100).map(validateProfile);
  if (new Set(customProfiles.map((p) => p.id)).size !== customProfiles.length) throw new Error("Duplicate profile id");
  const rig: Rig = {
    room: { name: textValue(room.name, "room name", 100), width: finite(room.width, 1, 200, "room width"), height: finite(room.height, 1, 200, "room height"), gridStep: finite(room.gridStep, 0.1, 10, "grid step"), shapes: shapes as unknown as Rig["room"]["shapes"] },
    fixtures: [], customProfiles,
    protectedRanges: array(input.protectedRanges ?? [], "protected ranges").map((raw) => {
      const r = object(raw, "protected range");
      return { universe: finite(r.universe, 0, 32767, "universe", true), from: finite(r.from, 1, 512, "range start", true), to: finite(r.to, r.from as number, 512, "range end", true), reason: textValue(r.reason, "range reason") };
    }),
  };
  const ids = new Set<string>(); const occupied = new Map<string, string>();
  for (const raw of array(input.fixtures, "fixtures")) {
    const f = object(raw, "fixture"); const id = idValue(f.id);
    if (ids.has(id)) throw new Error(`Duplicate fixture id ${id}`); ids.add(id);
    const profileId = textValue(f.profileId, "profile id"); const p = findProfile(profileId, customProfiles);
    if (!p) throw new Error(`Unknown profile ${profileId}`);
    const fx: Fixture = { id, profileId, name: textValue(f.name, "fixture name"), enabled: bool(f.enabled, "enabled"), x: finite(f.x, -1000, 1000, "fixture x"), y: finite(f.y, -1000, 1000, "fixture y"), rotation: finite(f.rotation, -360, 360, "rotation"), tags: array(f.tags, "tags", 12).map((t) => textValue(t, "tag", 80)) };
    if (f.trim !== undefined) fx.trim = finite(f.trim, 0, 1, "trim");
    if (p.transport === "dmx") {
      fx.universe = finite(f.universe ?? 0, 0, 32767, "universe", true);
      fx.address = finite(f.address, 1, 513 - p.channels.length, "address", true);
      const end = fx.address + p.channels.length - 1;
      const laser = p.id === "chauvet-scorpion-dual-rgb-ils-10ch";
      const haze = p.id === "chauvet-hurricane-haze-4d-2ch";
      if (haze && fx.address !== 51) throw new Error("Haze address is reserved at 51 with the fixed built-in 2CH profile");
      if (laser && ![31, 41].includes(fx.address)) throw new Error("Laser addresses are reserved at 31 and 41");
      if (!laser && !haze && fx.address <= 52 && end >= 31) throw new Error("Channels 31–52 are reserved for guarded lasers and uncommissioned haze");
      for (let c = fx.address; c <= end; c++) {
        const key = `${fx.universe}:${c}`;
        if (occupied.has(key)) throw new Error(`Fixture overlap: ${id} and ${occupied.get(key)} at ${c}`);
        occupied.set(key, id);
      }
      if (fx.enabled && !haze && rig.protectedRanges.some((r) => r.universe === fx.universe && r.from <= end && r.to >= fx.address!)) throw new Error(`Fixture ${id} overlaps a protected range`);
    } else if (f.hueLightId !== undefined) fx.hueLightId = textValue(f.hueLightId, "Hue light id", 100);
    rig.fixtures.push(fx);
  }
  // Preserve explicit protected ranges. The immutable process gate also protects haze.
  return rig;
}
export function validateSettings(raw: unknown): Settings {
  const s = structuredClone(object(raw, "settings")) as unknown as Settings;
  object(s.artnet, "Art-Net"); object(s.artnet.upstream, "upstream"); object(s.hue, "Hue"); object(s.agent, "agent"); object(s.sharing, "sharing");
  bool(s.artnet.enabled, "Art-Net enabled"); textValue(s.artnet.host, "Art-Net host", 255);
  finite(s.artnet.port, 1, 65535, "Art-Net port", true); finite(s.artnet.universe, 0, 32767, "universe", true); finite(s.artnet.fps, 5, 60, "fps");
  bool(s.artnet.upstream.enabled, "upstream enabled"); finite(s.artnet.upstream.listenPort, 1, 65535, "upstream port", true); textValue(s.artnet.upstream.allowFrom, "upstream source");
  // Stored legacy configuration may be retained for rollback; the output authority ignores it.
  bool(s.hue.enabled, "Hue enabled"); textValue(s.hue.bridgeIp, "Hue IP"); textValue(s.hue.username, "Hue username", 1024); finite(s.hue.rateHz, 1, 50, "Hue rate");
  for (const key of Object.keys(s.agent)) if (!["provider", "model", "effort", "anthropic", "allowApply", "guestAccess", "guestIntervalSec", "guestTotalPerHour"].includes(key)) throw new Error(`Unknown agent field ${key}`);
  if (!["hermes", "anthropic"].includes(s.agent.provider)) throw new Error("Invalid agent provider");
  if (!textValue(s.agent.model, "model").trim()) throw new Error("Agent model is required");
  if (!["low", "medium", "high", "xhigh", "max"].includes(s.agent.effort)) throw new Error("Invalid effort");
  if (s.agent.provider === "hermes" && (s.agent.model !== HERMES_MODEL || s.agent.effort !== "max")) throw new Error(`Hermes requires ${HERMES_MODEL} with max reasoning`);
  if (s.agent.anthropic !== undefined) {
    const saved = object(s.agent.anthropic, "Anthropic rollback");
    for (const key of Object.keys(saved)) if (!["model", "effort"].includes(key)) throw new Error(`Unknown agent rollback field ${key}`);
    if (!textValue(saved.model, "Anthropic model").trim()) throw new Error("Anthropic model is required");
    if (!["low", "medium", "high", "xhigh", "max"].includes(saved.effort as string)) throw new Error("Invalid Anthropic effort");
  }
  bool(s.agent.allowApply, "allow apply"); bool(s.agent.guestAccess, "guest access"); finite(s.agent.guestIntervalSec, 1, 86400, "guest interval"); finite(s.agent.guestTotalPerHour, 1, 10000, "guest limit");
  if (!["view", "control", "edit"].includes(s.sharing.guestPermission)) throw new Error("Invalid guest permission");
  textValue(s.sharing.venueName, "venue"); textValue(s.sharing.publicUrl, "public URL", 2048); finite(s.previewFps, 5, 40, "preview fps");
  return s;
}
export function validateScene(raw: unknown, rig: Rig): Scene {
  const s = structuredClone(object(raw, "scene")) as unknown as Scene;
  idValue(s.id); textValue(s.name, "scene name"); if (s.patternId !== null) idValue(s.patternId);
  object(s.params, "scene params"); finite(s.master, 0, 1, "master"); finite(s.speed, 0, 4, "speed"); if (s.bpm !== null) finite(s.bpm, 20, 300, "bpm");
  for (const [id, ov] of Object.entries(object(s.overrides, "overrides"))) {
    const f = rig.fixtures.find((f) => f.id === id); if (!f || ["laser", "haze"].includes(findProfile(f.profileId, rig.customProfiles)?.kind ?? "")) throw new Error("Scene override must target an ordinary fixture");
    s.overrides[id] = validateOverride(ov);
  }
  if (s.washes !== undefined) for (const [id, wash] of Object.entries(object(s.washes, "scene washes"))) {
    const f = rig.fixtures.find((f) => f.id === id);
    if (f?.profileId !== "chauvet-slimpar-pro-h-12ch") throw new Error("Scene wash must target a 12CH wash fixture");
    const w = object(wash, "wash");
    if (!["pattern", "manual", "show"].includes(w.owner as string)) throw new Error("Invalid wash owner");
    const { owner: _owner, ...patch } = w;
    validateWashPatch(patch);
    for (const key of ["mode", "brightness", "rgbw", "sensitivity"]) if (w[key] === undefined) throw new Error(`Missing wash ${key}`);
  }
  bool(s.favorite, "favorite"); if (s.hotkey !== null) finite(s.hotkey, 1, 9, "hotkey", true);
  array(s.swatch ?? [], "swatch", 32).forEach((v) => textValue(v, "swatch color")); finite(s.createdAt, 0, Number.MAX_SAFE_INTEGER, "createdAt"); finite(s.updatedAt, 0, Number.MAX_SAFE_INTEGER, "updatedAt");
  return s;
}
export function validatePlaylist(raw: unknown): Playlist {
  const p = structuredClone(object(raw, "playlist")) as unknown as Playlist;
  idValue(p.id); textValue(p.name, "playlist name"); bool(p.loop, "loop"); bool(p.shuffle, "shuffle");
  for (const raw of array(p.steps, "playlist steps", 1000)) {
    const s = object(raw, "step"); idValue(s.id); idValue(s.sceneId); finite(s.duration, 0.01, 86400, "duration");
    if (!["bars", "seconds"].includes(s.unit as string)) throw new Error("Invalid duration unit"); if (s.crossfadeMs !== undefined) finite(s.crossfadeMs, 0, 20000, "crossfade");
  }
  finite(p.createdAt, 0, Number.MAX_SAFE_INTEGER, "createdAt"); finite(p.updatedAt, 0, Number.MAX_SAFE_INTEGER, "updatedAt");
  return p;
}
