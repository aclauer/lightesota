// Color math shared by the engine, the preview and the pattern sandbox. All channels 0..1.

export type RGB = [number, number, number];

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
export const fract = (x: number) => x - Math.floor(x);
export const wrap = (x: number, n: number) => ((x % n) + n) % n;

export function hsv(h: number, s = 1, v = 1): RGB {
  h = fract(h);
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}

export function hsl(h: number, s: number, l: number): RGB {
  h = fract(h);
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    t = fract(t);
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

export function rgbToHsv([r, g, b]: RGB): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hex(s: string): RGB {
  let h = s.trim().replace(/^#/, "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [0, 0, 0];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function toHex([r, g, b]: RGB): string {
  const c = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Blend numeric RGB or the hex colors returned by color/palette parameters. */
export function mix(a: RGB | string, b: RGB | string, t: number): RGB {
  if (typeof a === "string") a = hex(a);
  if (typeof b === "string") b = hex(b);
  t = clamp01(t);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function scale(c: RGB, k: number): RGB {
  return [c[0] * k, c[1] * k, c[2] * k];
}

/** Sample a palette (array of hex strings) at t in 0..1, looping smoothly. */
export function paletteAt(colors: string[], t: number): RGB {
  if (colors.length === 0) return [0, 0, 0];
  if (colors.length === 1) return hex(colors[0]);
  const x = fract(t) * colors.length;
  const i = Math.floor(x);
  const f = x - i;
  return mix(hex(colors[i]), hex(colors[(i + 1) % colors.length]), f);
}

export const luminance = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

export const PALETTES: Record<string, string[]> = {
  rainbow: ["#ff0040", "#ff8000", "#ffff00", "#00ff40", "#00c0ff", "#4000ff", "#ff00c0"],
  sunset: ["#ff4e00", "#ff9a00", "#ffd000", "#ff2d95", "#6a00ff"],
  ocean: ["#00163a", "#0052a3", "#00a3c4", "#2ee6d6", "#b7fff5"],
  forest: ["#0b3d0b", "#1f7a1f", "#58b000", "#b5e300", "#f4ff9a"],
  candy: ["#ff6ad5", "#c774e8", "#ad8cff", "#8795e8", "#94d0ff"],
  fire: ["#1a0000", "#8a0a00", "#ff3b00", "#ff9d00", "#ffe680"],
  ice: ["#001a33", "#0066cc", "#66ccff", "#e6f7ff", "#ffffff"],
  neon: ["#ff00ff", "#00ffff", "#ffff00", "#00ff00"],
  warm: ["#ffb060", "#ff8a3d", "#ffd59a", "#ff6a00"],
  mono: ["#ffffff"],
};
