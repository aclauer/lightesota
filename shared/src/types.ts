// Core domain types shared between server and web.

export type Role = "admin" | "editor" | "guest" | "viewer";

/** A channel in a fixture profile. `fn` says what the engine writes there. */
export type ChannelFn =
  | "dimmer" | "red" | "green" | "blue" | "white" | "amber" | "uv"
  | "strobe" | "fixed";

export interface ProfileChannel {
  fn: ChannelFn;
  name: string;
  /** Used when fn === "fixed": the constant byte written to this channel. */
  value?: number;
  /** For strobe: byte range mapped from 0..1 (default [11,255]); 0 writes `off` (default 0). */
  range?: [number, number];
  off?: number;
}

export interface FixtureProfile {
  id: string;
  name: string;
  manufacturer?: string;
  /** "dmx" profiles have channels; "hue" is driven over the Hue bridge API. */
  transport: "dmx" | "hue";
  channels: ProfileChannel[];
  /** Whether the fixture produces color or is intensity-only. */
  colorModel: "rgb" | "rgbw" | "rgbaw-uv" | "dimmer";
  /** Default drawing size on the stage (meters). */
  size?: number;
  shape?: "circle" | "square" | "bar";
  notes?: string;
}

export interface Fixture {
  id: string;
  name: string;
  profileId: string;
  /** DMX fixtures. 1-based start address. */
  universe?: number;
  address?: number;
  /** Hue fixtures: the light id on the bridge. */
  hueLightId?: string;
  /** Stage position (meters), rotation (degrees, clockwise), free-form tags. */
  x: number;
  y: number;
  rotation: number;
  tags: string[];
  enabled: boolean;
  /** Optional per-fixture color/intensity trim 0..1. */
  trim?: number;
}

export interface StageRoom {
  name: string;
  width: number;   // meters
  height: number;  // meters
  gridStep: number;
  /** Decorative polygons/lines drawn under fixtures (walls, desks, stage). */
  shapes: StageShape[];
}

export interface StageShape {
  id: string;
  kind: "rect" | "line" | "label";
  x: number; y: number; w?: number; h?: number; x2?: number; y2?: number;
  text?: string;
  color?: string;
}

export interface ProtectedRange {
  universe: number;
  from: number; // 1-based inclusive
  to: number;
  reason: string;
}

export interface Rig {
  room: StageRoom;
  fixtures: Fixture[];
  /** Extra profiles defined by the user (built-ins live in code). */
  customProfiles: FixtureProfile[];
  /** Channels the app must never drive (lasers, hazer). Enforced per packet. */
  protectedRanges: ProtectedRange[];
}

// ---------- Patterns ----------

export type ParamType = "number" | "color" | "boolean" | "select" | "palette";

export interface ParamDefBase {
  type: ParamType;
  label?: string;
  description?: string;
  /** Group name for the UI (e.g. "Timing", "Color"). */
  group?: string;
}
export interface NumberParam extends ParamDefBase {
  type: "number";
  default: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  /** Logarithmic slider. */
  log?: boolean;
}
export interface ColorParam extends ParamDefBase { type: "color"; default: string; }
export interface BooleanParam extends ParamDefBase { type: "boolean"; default: boolean; }
export interface SelectParam extends ParamDefBase { type: "select"; default: string; options: string[]; }
export interface PaletteParam extends ParamDefBase { type: "palette"; default: string[]; }
export type ParamDef = NumberParam | ColorParam | BooleanParam | SelectParam | PaletteParam;
export type ParamSchema = Record<string, ParamDef>;
export type ParamValues = Record<string, number | string | boolean | string[]>;

export interface PatternMeta {
  id: string;
  name: string;
  description: string;
  author?: string;
  tags: string[];
  /** Does the pattern read ctx.beat? Shown as a BPM badge in the UI. */
  usesBeat: boolean;
  builtin: boolean;
  params: ParamSchema;
  createdAt: number;
  updatedAt: number;
  /** Compile error if the saved source is currently broken. */
  error?: string;
  /** A few representative colors for thumbnails. */
  swatch?: string[];
}

export interface Pattern extends PatternMeta { source: string; }

// ---------- Show state ----------

export interface FixtureOverride {
  /** 0..1 floats. Any missing field leaves the pattern value in place. */
  r?: number; g?: number; b?: number; w?: number; a?: number; uv?: number;
  dim?: number;
  /** Replace pattern output entirely (true) or blend by `mix` (0..1). */
  mix?: number;
}

export interface Transport {
  bpm: number;
  /** Server clock ms at which beat 0 occurred. */
  beatOrigin: number;
  running: boolean;
}

/** One entry in the recently-deployed list, newest first. */
export interface HistoryEntry {
  patternId: string;
  params: ParamValues;
  sceneId: string | null;
  at: number;
}

export interface ShowState {
  /** Recently deployed patterns, newest first, one entry per pattern. */
  history: HistoryEntry[];
  patternId: string | null;
  params: ParamValues;
  /** Pattern that is fading out (for the UI only). */
  outgoingPatternId: string | null;
  crossfadeMs: number;
  master: number;          // 0..1
  blackout: boolean;
  /** Speed multiplier applied to ctx.t (not to beat). */
  speed: number;
  transport: Transport;
  overrides: Record<string, FixtureOverride>;
  /** Fixture ids currently soloed (empty = none). */
  solo: string[];
  activeSceneId: string | null;
  playlist: PlaylistPlayback | null;
  /** True when a configured upstream Art-Net source is being passed through untouched. */
  released: boolean;
  /** Server time (ms) at which the show blacks out, or null. */
  sleepAt: number | null;
  /** Microphone analysis: who is sending and whether BPM follows the detected tempo. */
  audio: { active: boolean; source: string | null; followBpm: boolean; level: number; bpm: number | null };
}

/** One microphone analysis frame sent by a browser. All 0..1 except bpm. */
export interface AudioFrame { level: number; bass: number; mid: number; high: number; onset: boolean; bpm: number | null; }

export interface Scene {
  id: string;
  name: string;
  patternId: string | null;
  params: ParamValues;
  master: number;
  bpm: number | null;
  speed: number;
  overrides: Record<string, FixtureOverride>;
  favorite: boolean;
  /** 1-9 hotkey slot. */
  hotkey: number | null;
  swatch: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistStep {
  id: string;
  sceneId: string;
  /** Duration in bars (beat-synced) or seconds. */
  duration: number;
  unit: "bars" | "seconds";
  crossfadeMs?: number;
}

export interface Playlist {
  id: string;
  name: string;
  steps: PlaylistStep[];
  loop: boolean;
  shuffle: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistPlayback {
  playlistId: string;
  stepIndex: number;
  stepStartedAt: number;
  stepEndsAt: number;
  playing: boolean;
}

// ---------- Output / settings ----------

export interface ArtNetSettings {
  enabled: boolean;
  host: string;
  port: number;
  universe: number;
  fps: number;
  /** Listen for an upstream Art-Net sender (e.g. Home Assistant) and merge its frame. */
  upstream: {
    enabled: boolean;
    listenPort: number;
    /** Only accept upstream frames from this IP (empty = any). */
    allowFrom: string;
  };
}

export interface HueSettings {
  enabled: boolean;
  bridgeIp: string;
  username: string;   // app key from pairing
  /** Max commands per second sent to the bridge. */
  rateHz: number;
}

export interface AgentSettings {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** When false the agent may not auto-apply patterns. */
  allowApply: boolean;
}

export interface SharingSettings {
  guestPermission: "view" | "control" | "edit";
  /** Display name of the room/venue shown in the header. */
  venueName: string;
  /** Public URL base used in share links (auto-detected if empty). */
  publicUrl: string;
}

export interface Settings {
  artnet: ArtNetSettings;
  hue: HueSettings;
  agent: AgentSettings;
  sharing: SharingSettings;
  previewFps: number;
}

export interface OutputStatus {
  artnet: { sending: boolean; fps: number; lastSentAt: number; frames: number; error?: string };
  upstream: { listening: boolean; lastFrameAt: number; from: string; frames: number };
  hue: { connected: boolean; lights: number; lastError?: string };
  engine: { fps: number; patternError?: string; restarts: number };
  hasApiKey: boolean;
}

export interface Presence {
  id: string;
  name: string;
  role: Role;
  color: string;
  connectedAt: number;
}

/** Per-fixture rendered color, as sent to clients for the live preview. */
export interface FrameColor { r: number; g: number; b: number; w: number; dim: number; }

export interface HueLightInfo {
  id: string;
  name: string;
  type: string;
  reachable: boolean;
  on: boolean;
}
