import type { FrameColor } from "@lightesota/shared";

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Display color of a fixture: color times intensity, white added. */
export function frameToCss(c: FrameColor | undefined): string {
  if (!c) return "rgb(0,0,0)";
  const k = c.dim;
  const r = Math.min(1, c.r * k + c.w * k), g = Math.min(1, c.g * k + c.w * k), b = Math.min(1, c.b * k + c.w * k);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

export function frameLuma(c: FrameColor | undefined): number {
  if (!c) return 0;
  return Math.min(1, (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b + c.w) * c.dim);
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function hexToRgb01(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgb01ToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}
