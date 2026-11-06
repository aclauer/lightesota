import type { Fixture, FixtureProfile, Rig } from "./types.js";
import { findProfile } from "./profiles.js";

/**
 * Hazer: Chauvet Hurricane Haze 4D, 2 channels (1 blower speed, 2 haze volume, 0..255 low to high).
 * Like the lasers it never goes through patterns: an admin arms it, sets fan and output, and every
 * run has a deadline after which the output drops to zero on its own.
 */
export interface HazeState {
  armed: boolean;
  armedBy: string | null;
  /** 0..1 blower speed and haze volume. */
  fan: number;
  output: number;
  /** Server time (ms) the output stops by itself, or null when not running. */
  runUntil: number | null;
}

export type HazePatch = Partial<Pick<HazeState, "armed" | "fan" | "output">> & { runSec?: number };

export const HAZE_MAX_RUN_SEC = 20 * 60;

export function defaultHazeState(): HazeState {
  return { armed: false, armedBy: null, fan: 0.5, output: 0.3, runUntil: null };
}

export function isHazeProfile(p: FixtureProfile | undefined): boolean {
  return p?.kind === "haze";
}

export function hazeFixtures(rig: Rig): Fixture[] {
  return rig.fixtures.filter((f) => f.enabled && isHazeProfile(findProfile(f.profileId, rig.customProfiles)));
}

export function sanitizeHaze(input: unknown, base: HazeState): HazeState {
  const o = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const n01 = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d);
  return { ...base, fan: n01(o.fan, base.fan), output: n01(o.output, base.output) };
}

/** True while a run is in progress. */
export function hazeRunning(h: HazeState, now = Date.now()): boolean {
  return h.armed && h.runUntil !== null && h.runUntil > now;
}

/** The two bytes. Zero unless armed, running and not blacked out. */
export function hazeBytes(h: HazeState | undefined, blackout: boolean, now = Date.now()): [number, number] {
  if (!h || blackout || !hazeRunning(h, now)) return [0, 0];
  return [Math.round(h.fan * 255), Math.round(h.output * 255)];
}

/** Validate the complete operator command before any arm, level or ownership mutation. */
export function validateHazePatch(raw: unknown): HazePatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Haze command must be an object");
  const patch = raw as Record<string, unknown>;
  if (Object.keys(patch).some(key => !["armed", "fan", "output", "runSec"].includes(key))) throw new Error("Unknown haze field");
  if (patch.armed !== undefined && typeof patch.armed !== "boolean") throw new Error("Haze armed must be boolean");
  for (const [key, max] of [["fan", 1], ["output", 1], ["runSec", HAZE_MAX_RUN_SEC]] as const) {
    const value = patch[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max)) throw new Error(`Haze ${key} must be finite in 0..${max}`);
  }
  if (patch.armed === false && (patch.runSec as number) > 0) throw new Error("Cannot disarm and start haze together");
  return { ...patch } as HazePatch;
}
