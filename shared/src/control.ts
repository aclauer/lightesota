import type { Fixture, Rig } from "./types.js";

export const WASH_MODES = ["off", "normal", "music6", "music32"] as const;
export type WashMode = (typeof WASH_MODES)[number];
export interface WashState {
  mode: WashMode;
  /** Absolute fixture dimmer byte, before master and trim. */
  brightness: number;
  rgbw: [number, number, number, number];
  sensitivity: number;
  owner: "pattern" | "manual" | "show";
}
export type WashPatch = Partial<Pick<WashState, "mode" | "brightness" | "rgbw" | "sensitivity">>;
export function defaultWashState(): WashState {
  return { mode: "off", brightness: 25, rgbw: [0, 0, 255, 0], sensitivity: 255, owner: "manual" };
}
/** This hardware mode vocabulary belongs only to the commissioned SlimPAR 12CH profile. */
export function washFixtures(rig: Rig): Fixture[] {
  return rig.fixtures.filter((f) => f.enabled && f.profileId === "chauvet-slimpar-pro-h-12ch");
}
export function washSide(f: Fixture): "a" | "b" {
  // Historical office identities are stable; don't infer scope from user placements.
  if (/^(w[12]|wash-[12])$/i.test(f.id)) return "a";
  if (/^(w[34]|wash-[34])$/i.test(f.id)) return "b";
  return f.tags.some((t) => /^(side-b|sideb|right)$/i.test(t)) ? "b" : "a";
}
export function validateWashPatch(raw: unknown): WashPatch {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Wash patch must be an object");
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).some((k) => !["mode", "brightness", "rgbw", "sensitivity"].includes(k))) throw new Error("Unknown wash field");
  const out: WashPatch = {};
  if (p.mode !== undefined) {
    if (!(WASH_MODES as readonly unknown[]).includes(p.mode)) throw new Error("Invalid wash mode");
    out.mode = p.mode as WashMode;
  }
  const byte = (v: unknown, min: number) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > 255) throw new Error(`Expected integer ${min}..255`);
    return v;
  };
  if (p.brightness !== undefined) out.brightness = byte(p.brightness, 0);
  if (p.sensitivity !== undefined) out.sensitivity = byte(p.sensitivity, 11);
  if (p.rgbw !== undefined) {
    if (!Array.isArray(p.rgbw) || p.rgbw.length !== 4) throw new Error("RGBW must contain four bytes");
    out.rgbw = p.rgbw.map((v) => byte(v, 0)) as WashState["rgbw"];
    out.mode = "normal";
  }
  return out;
}

export const QUICK_LOOKS = [
  { id: "warm-arrival", name: "Warm Arrival" },
  { id: "cyan-magenta", name: "Cyan / Magenta sides" },
  { id: "calm-blue", name: "Calm Blue" },
  { id: "music6", name: "Fixture microphones · Music 6" },
  { id: "music32", name: "Fixture microphones · Music 32" },
  { id: "laser-duo", name: "Cyan Fan + Magenta Wave" },
] as const;
export type QuickLookId = (typeof QUICK_LOOKS)[number]["id"];
export const COORDINATED_SHOWS = [
  { id: "neon-exchange", name: "Neon Exchange" },
  { id: "call-response", name: "Call and Response" },
  { id: "build-release", name: "Build and Release" },
] as const;
export type CoordinatedShowId = (typeof COORDINATED_SHOWS)[number]["id"];
export interface CoordinatedShowParams {
  id: CoordinatedShowId;
  fixtureIds: string[];
  durationSec?: number;
  ceiling?: number;
  includeLasers?: boolean;
}
export interface CoordinatedShowState {
  id: CoordinatedShowId;
  fixtureIds: string[];
  durationSec: number;
  ceiling: number;
  includeLasers: boolean;
  startedAt: number;
  elapsedSec: number;
  source: "shared-bpm";
  phrase: number;
}
