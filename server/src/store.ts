import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/** Tiny JSON file store with debounced writes. */
export class JsonFile<T> {
  private timer: NodeJS.Timeout | null = null;
  private value: T;
  private full: string;
  constructor(private file: string, fallback: () => T, migrate?: (raw: unknown) => T) {
    const full = path.join(config.dataDir, file);
    this.full = full;
    if (fs.existsSync(full)) {
      try {
        const raw = JSON.parse(fs.readFileSync(full, "utf8"));
        this.value = migrate ? migrate(raw) : (raw as T);
      } catch (e) {
        console.warn(`[store] ${file} unreadable (${(e as Error).message}); using defaults`);
        fs.copyFileSync(full, full + ".broken-" + Date.now());
        this.value = fallback();
      }
    } else {
      this.value = fallback();
      this.flush();
    }
  }
  get(): T { return this.value; }
  set(v: T) { this.value = v; this.save(); }
  update(fn: (v: T) => T) { this.set(fn(this.value)); }
  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 150);
  }
  flush() {
    if (this.timer) clearTimeout(this.timer); this.timer = null;
    const full = this.full;
    const tmp = full + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.value, null, 2));
    fs.renameSync(tmp, full);
  }
}

export function deepMerge<T>(base: T, patch: unknown): T {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return (patch === undefined ? base : (patch as T));
  if (base === null || typeof base !== "object" || Array.isArray(base)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (["__proto__", "constructor", "prototype"].includes(k)) throw new Error("Reserved configuration key");
    out[k] = deepMerge((base as Record<string, unknown>)[k], v);
  }
  return out as T;
}
