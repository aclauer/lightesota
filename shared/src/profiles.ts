import type { FixtureProfile } from "./types.js";

/**
 * Built-in fixture profiles.
 *
 * SlimPAR Pro H USB 12-channel values for channels 8-12 follow what was tested on the
 * office rig on 2026-11-05 (program 0 = normal, sensitivity 32, dimmer speed 52).
 */
export const BUILTIN_PROFILES: FixtureProfile[] = [
  {
    id: "chauvet-slimpar-pro-h-12ch",
    name: "Chauvet SlimPAR Pro H USB (12-CH)",
    manufacturer: "Chauvet DJ",
    transport: "dmx",
    colorModel: "rgbaw-uv",
    shape: "circle",
    size: 0.35,
    channels: [
      { fn: "dimmer", name: "Dimmer" },
      { fn: "red", name: "Red" },
      { fn: "green", name: "Green" },
      { fn: "blue", name: "Blue" },
      { fn: "amber", name: "Amber" },
      { fn: "white", name: "White" },
      { fn: "uv", name: "UV" },
      { fn: "fixed", name: "Color macro", value: 0 },
      { fn: "strobe", name: "Strobe", range: [11, 255], off: 0 },
      { fn: "fixed", name: "Program", value: 0 },
      { fn: "fixed", name: "Sound sensitivity", value: 32 },
      { fn: "fixed", name: "Dimmer speed", value: 52 },
    ],
    notes: "Menu: 12CH. Set address with DMX unplugged. dIM = OFF.",
  },
  {
    id: "chauvet-slimpar-pro-h-7ch",
    name: "Chauvet SlimPAR Pro H USB (7-CH)",
    manufacturer: "Chauvet DJ",
    transport: "dmx",
    colorModel: "rgbaw-uv",
    shape: "circle",
    size: 0.35,
    channels: [
      { fn: "dimmer", name: "Dimmer" },
      { fn: "red", name: "Red" },
      { fn: "green", name: "Green" },
      { fn: "blue", name: "Blue" },
      { fn: "amber", name: "Amber" },
      { fn: "white", name: "White" },
      { fn: "uv", name: "UV" },
    ],
  },
  {
    id: "chauvet-saber-spot-ww-1ch",
    name: "Chauvet Saber Spot WW (1CH)",
    manufacturer: "Chauvet DJ",
    transport: "dmx",
    colorModel: "dimmer",
    shape: "square",
    size: 0.2,
    channels: [{ fn: "dimmer", name: "Dimmer" }],
    notes: "Warm white pinspot. NO DMX = Blackout means it is dark without signal.",
  },
  {
    id: "chauvet-scorpion-dual-rgb-ils-10ch",
    name: "Chauvet Scorpion Dual RGB ILS (10-CH laser)",
    manufacturer: "Chauvet DJ",
    transport: "dmx",
    colorModel: "rgb",
    kind: "laser",
    apertures: 2,
    apertureSpreadMin: 10,
    apertureSpreadMax: 70,
    shape: "square",
    size: 0.3,
    // Address planning only. The output stage writes these ten channels from the approved laser
    // presets (shared/src/laser.ts); patterns never touch them and "fixed 0" is the dark state.
    channels: [
      { fn: "fixed", name: "Mode", value: 0 },
      { fn: "fixed", name: "Pattern", value: 0 },
      { fn: "fixed", name: "Color", value: 0 },
      { fn: "fixed", name: "Strobe", value: 0 },
      { fn: "fixed", name: "Zoom", value: 0 },
      { fn: "fixed", name: "Pan", value: 0 },
      { fn: "fixed", name: "Tilt", value: 0 },
      { fn: "fixed", name: "Rolling X", value: 0 },
      { fn: "fixed", name: "Rolling Y", value: 0 },
      { fn: "fixed", name: "Rolling Z", value: 0 },
    ],
    notes: "Operator-only. Menu: DMX address 031 / 041, never Auto, Sound, ILS, Slave or Test. Controlled from the Lasers card on Live after arming.",
  },
  {
    id: "chauvet-hurricane-haze-4d-2ch",
    name: "Chauvet Hurricane Haze 4D (2-CH hazer)",
    manufacturer: "Chauvet DJ",
    transport: "dmx",
    colorModel: "dimmer",
    kind: "haze",
    shape: "square",
    size: 0.3,
    channels: [
      { fn: "fixed", name: "Blower speed", value: 0 },
      { fn: "fixed", name: "Haze volume", value: 0 },
    ],
    notes: "Operator-only. Address d051. Controlled from the Haze card on Live after arming; every run auto-stops. Keeps emitting a little while fluid is in the line.",
  },
  {
    id: "generic-rgb-3ch",
    name: "Generic RGB (3-CH)",
    transport: "dmx",
    colorModel: "rgb",
    shape: "circle",
    size: 0.3,
    channels: [
      { fn: "red", name: "Red" },
      { fn: "green", name: "Green" },
      { fn: "blue", name: "Blue" },
    ],
  },
  {
    id: "generic-rgbw-4ch",
    name: "Generic RGBW (4-CH)",
    transport: "dmx",
    colorModel: "rgbw",
    shape: "circle",
    size: 0.3,
    channels: [
      { fn: "red", name: "Red" },
      { fn: "green", name: "Green" },
      { fn: "blue", name: "Blue" },
      { fn: "white", name: "White" },
    ],
  },
  {
    id: "generic-dimmer-rgb-4ch",
    name: "Generic Dimmer + RGB (4-CH)",
    transport: "dmx",
    colorModel: "rgb",
    shape: "circle",
    size: 0.3,
    channels: [
      { fn: "dimmer", name: "Dimmer" },
      { fn: "red", name: "Red" },
      { fn: "green", name: "Green" },
      { fn: "blue", name: "Blue" },
    ],
  },
  {
    id: "generic-dimmer-1ch",
    name: "Generic Dimmer (1-CH)",
    transport: "dmx",
    colorModel: "dimmer",
    shape: "square",
    size: 0.2,
    channels: [{ fn: "dimmer", name: "Dimmer" }],
  },
  {
    id: "hue-color-light",
    name: "Philips Hue color light / strip",
    manufacturer: "Signify",
    transport: "hue",
    colorModel: "rgb",
    shape: "bar",
    size: 1.0,
    channels: [],
    notes: "Driven through the Hue Bridge REST API; updates are rate limited.",
  },
];

export function profileFootprint(p: FixtureProfile): number {
  return p.transport === "dmx" ? p.channels.length : 0;
}

export function findProfile(id: string, custom: FixtureProfile[] = []): FixtureProfile | undefined {
  return custom.find((p) => p.id === id) ?? BUILTIN_PROFILES.find((p) => p.id === id);
}
