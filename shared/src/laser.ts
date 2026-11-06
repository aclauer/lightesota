import type { Fixture, FixtureProfile, Rig } from "./types.js";
import { findProfile } from "./profiles.js";

/**
 * Lasers: Chauvet Scorpion Dual RGB ILS in 10-channel mode.
 *
 * The app never lets a pattern or a person write raw laser channels. Every frame sent to a
 * laser is built here from a small vocabulary of presets the laser operator approved on site
 * (2026-11-05): manual fan/wave at tilt 64 (the level beam, the lowest approved angle), zoom 53,
 * pan within 48..80, six fixed colors, no strobe; or the fixture's own sound-active color modes.
 * Anything else encodes as all zeros, which is the Scorpion's dark, still state.
 */

export const LASER_COLORS = ["red", "green", "blue", "yellow", "magenta", "cyan"] as const;
export type LaserColor = (typeof LASER_COLORS)[number];
export const LASER_COLOR_BYTE: Record<LaserColor, number> = { red: 40, green: 55, blue: 70, yellow: 86, magenta: 102, cyan: 118 };
export const LASER_COLOR_CSS: Record<LaserColor, string> = { red: "#ff2a2a", green: "#2aff5a", blue: "#3a6cff", yellow: "#ffe02a", magenta: "#ff2ad6", cyan: "#2af0ff" };

export const LASER_PATTERNS = ["fan", "wave"] as const;
export type LaserPattern = (typeof LASER_PATTERNS)[number];
export const LASER_PATTERN_BYTE: Record<LaserPattern, number> = { fan: 155, wave: 123 };
export const LASER_PATTERN_LABEL: Record<LaserPattern, string> = { fan: "Fan (flat line)", wave: "Wave (zigzag)" };

export const LASER_MUSIC_COLORS = ["multicolor", ...LASER_COLORS] as const;
export type LaserMusicColor = (typeof LASER_MUSIC_COLORS)[number];
/** Channel 1 sound-active modes; the laser picks its own patterns and positions in these. */
export const LASER_MUSIC_BYTE: Record<LaserMusicColor, number> = { multicolor: 137, red: 154, green: 171, blue: 188, yellow: 205, magenta: 222, cyan: 239 };

export const LASER_PAN_MIN = 48;
export const LASER_PAN_MAX = 80;
export const LASER_PAN_CENTER = 64;
/** Operator-approved lowest beam angle. Never lower. */
export const LASER_TILT = 64;
export const LASER_ZOOM = 53;
export const LASER_CHANNELS = 10;

export type LaserMode = "off" | "manual" | "music";

export interface LaserState {
  mode: LaserMode;
  pattern: LaserPattern;
  color: LaserColor;
  /**
   * Channel 6 ("pan" on the Scorpion), clamped to LASER_PAN_MIN..LASER_PAN_MAX. On the dual-mirror
   * unit this is the spread: the two fans move toward each other at low values and apart at high ones.
   */
  pan: number;
  musicColor: LaserMusicColor;
}

export interface LasersState {
  /** Software arm. False after every server start; nothing is emitted while false. */
  armed: boolean;
  /** Server time the lasers were armed, for the UI. */
  armedAt: number | null;
  /** Who armed them (display name). */
  armedBy: string | null;
  fixtures: Record<string, LaserState>;
  /** Active look id (see LASER_LOOKS) or null when lasers are set by hand. */
  look: string | null;
}

export function defaultLaserState(): LaserState {
  return { mode: "off", pattern: "fan", color: "green", pan: LASER_PAN_CENTER, musicColor: "multicolor" };
}

export function defaultLasersState(): LasersState {
  return { armed: false, armedAt: null, armedBy: null, fixtures: {}, look: null };
}

export function isLaserProfile(p: FixtureProfile | undefined): boolean {
  return p?.kind === "laser";
}

export function isLaserFixture(f: Fixture, rig: Rig): boolean {
  return isLaserProfile(findProfile(f.profileId, rig.customProfiles));
}

/** Fixtures the pattern engine drives: enabled and not a laser. Frames are indexed in this order. */
export function engineFixtures(rig: Rig): Fixture[] {
  return rig.fixtures.filter((f) => f.enabled && !isLaserFixture(f, rig));
}

/** Enabled lasers in rig order. */
export function laserFixtures(rig: Rig): Fixture[] {
  return rig.fixtures.filter((f) => f.enabled && isLaserFixture(f, rig));
}

/** Clamp and normalize whatever a client sent into a valid LaserState. Unknown values fall back to defaults. */
export function sanitizeLaserState(input: unknown, base: LaserState = defaultLaserState()): LaserState {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, allowed: readonly T[], dflt: T): T => (typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : dflt);
  const pan = typeof o.pan === "number" && Number.isFinite(o.pan) ? Math.round(o.pan) : base.pan;
  return {
    mode: pick(o.mode, ["off", "manual", "music"] as const, base.mode),
    pattern: pick(o.pattern, LASER_PATTERNS, base.pattern),
    color: pick(o.color, LASER_COLORS, base.color),
    pan: Math.max(LASER_PAN_MIN, Math.min(LASER_PAN_MAX, pan)),
    musicColor: pick(o.musicColor, LASER_MUSIC_COLORS, base.musicColor),
  };
}

/**
 * The 10 bytes for one laser. All zeros unless the rig is armed, not blacked out, and the laser
 * is in an approved mode. Every byte comes from the tables above; there is no path to an arbitrary value.
 */
export function laserBytes(state: LaserState | undefined, armed: boolean, blackout: boolean): number[] {
  const out = new Array<number>(LASER_CHANNELS).fill(0);
  if (!state || !armed || blackout || state.mode === "off") return out;
  if (state.mode === "music") {
    out[0] = LASER_MUSIC_BYTE[state.musicColor] ?? 0;
    return out;
  }
  // manual
  const pan = Math.max(LASER_PAN_MIN, Math.min(LASER_PAN_MAX, Math.round(state.pan)));
  out[0] = 0;                                   // mode: manual
  out[1] = LASER_PATTERN_BYTE[state.pattern];   // pattern
  out[2] = LASER_COLOR_BYTE[state.color];       // color
  out[3] = 0;                                   // strobe: none
  out[4] = LASER_ZOOM;                          // zoom
  out[5] = pan;                                 // pan
  out[6] = LASER_TILT;                          // tilt: approved level beam
  out[7] = 0; out[8] = 0; out[9] = 0;           // no rolling
  return out;
}

/** True when the state would put light out of the laser (for the UI and the plan). */
export function laserIsOn(state: LaserState | undefined, armed: boolean, blackout: boolean): boolean {
  return laserBytes(state, armed, blackout).some((b) => b !== 0);
}

/** A representative CSS color for the plan. */
export function laserCss(state: LaserState | undefined): string {
  if (!state) return "#888";
  if (state.mode === "music") return state.musicColor === "multicolor" ? "#ffffff" : LASER_COLOR_CSS[state.musicColor];
  return LASER_COLOR_CSS[state.color];
}

// ---------- Looks: named combinations of approved presets, some animated ----------

/**
 * A look assigns a LaserState to each armed laser, optionally as a function of time and beat.
 * Everything a look returns still goes through sanitizeLaserState, so a look can only ever
 * pick from the approved tables above. Motion is limited to stepping pan inside its window and
 * switching between approved colors; tilt, zoom and strobe never move.
 */
export interface LaserLook {
  id: string;
  name: string;
  description: string;
  /** Does the look change over time (pan sweep or beat colors)? */
  animated: boolean;
  /** `i` is the laser's index among the enabled lasers, `n` the count. */
  at: (t: number, beat: number, i: number, n: number) => LaserState;
}

const manual = (pattern: LaserPattern, color: LaserColor, pan = LASER_PAN_CENTER): LaserState => ({ mode: "manual", pattern, color, pan: Math.round(pan), musicColor: "multicolor" });
const music = (musicColor: LaserMusicColor): LaserState => ({ mode: "music", pattern: "fan", color: "green", pan: LASER_PAN_CENTER, musicColor: musicColor });
/** Triangle wave between LASER_PAN_MIN and LASER_PAN_MAX with the given period, phase in 0..1. */
const sweep = (t: number, periodSec: number, phase = 0) => {
  const u = ((t / periodSec + phase) % 1 + 1) % 1;
  const tri = u < 0.5 ? u * 2 : 2 - u * 2;
  return LASER_PAN_MIN + tri * (LASER_PAN_MAX - LASER_PAN_MIN);
};
const beatColor = (beat: number, offset = 0): LaserColor => LASER_COLORS[(Math.floor(beat) + offset) % LASER_COLORS.length];

export const LASER_LOOKS: LaserLook[] = [
  { id: "twin-green", name: "Twin green", description: "Both lasers: the certified green line, centered.", animated: false, at: () => manual("fan", "green") },
  { id: "red-green", name: "Red / green", description: "Green on the first laser, red on the second.", animated: false, at: (_t, _b, i) => manual("fan", i % 2 ? "red" : "green") },
  { id: "tight", name: "Tight pair", description: "Both lasers with their two fans pulled close together, cyan.", animated: false, at: () => manual("fan", "cyan", LASER_PAN_MIN) },
  { id: "wide", name: "Wide pair", description: "Both lasers with their two fans spread as far apart as allowed, magenta.", animated: false, at: () => manual("fan", "magenta", LASER_PAN_MAX) },
  { id: "waves", name: "Yellow waves", description: "Both lasers on the zigzag wave, yellow, centered.", animated: false, at: () => manual("wave", "yellow") },
  { id: "breathe", name: "Breathe", description: "Cyan waves slowly opening and closing over 16 s, both lasers together.", animated: true, at: (t) => manual("wave", "cyan", sweep(t, 16)) },
  { id: "scissors", name: "Scissors", description: "Green fans scissoring open and shut every 10 s, one laser opening while the other closes.", animated: true, at: (t, _b, i) => manual("fan", "green", sweep(t, 10, i % 2 ? 0.5 : 0)) },
  { id: "beat-colors", name: "Beat colors", description: "Lines step through the six colors on every beat, the second laser one color ahead.", animated: true, at: (_t, b, i) => manual("fan", beatColor(b, i)) },
  { id: "beat-waves", name: "Beat waves", description: "Waves that change color each beat and snap between narrow and wide each bar.", animated: true, at: (_t, b, i) => manual("wave", beatColor(b, i * 3), LASER_PAN_CENTER + (Math.floor(b / 4) % 2 ? 8 : -8) * (i % 2 ? -1 : 1)) },
  { id: "sound-multi", name: "Sound: multicolor", description: "Both lasers in their own sound-active multicolor mode.", animated: false, at: () => music("multicolor") },
  { id: "sound-cold", name: "Sound: cold", description: "Sound-active, cyan on the first laser and blue on the second.", animated: false, at: (_t, _b, i) => music(i % 2 ? "blue" : "cyan") },
  { id: "sound-warm", name: "Sound: warm", description: "Sound-active, red and yellow.", animated: false, at: (_t, _b, i) => music(i % 2 ? "yellow" : "red") },
];

export function findLaserLook(id: string | null | undefined): LaserLook | undefined {
  return id ? LASER_LOOKS.find((l) => l.id === id) : undefined;
}
