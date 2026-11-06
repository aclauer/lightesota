import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { nanoid } from "nanoid";
import type { Pattern, PatternMeta, Playlist, Scene } from "../../shared/src/index.js";
import { config } from "./config.js";
import { JsonFile } from "./store.js";
import { compilePattern, testPattern } from "./engine/sandbox.js";

interface LibraryEvents { patterns: []; scenes: []; playlists: []; }

/**
 * Patterns are JavaScript files: built-ins in /patterns, user patterns in data/patterns.
 * Metadata is derived by compiling the source. Scenes and playlists are JSON.
 */
export class Library extends EventEmitter<LibraryEvents> {
  private patterns = new Map<string, Pattern>();
  private scenesFile = new JsonFile<Scene[]>("scenes.json", () => []);
  private playlistsFile = new JsonFile<Playlist[]>("playlists.json", () => []);
  private order: string[] = [];

  load() {
    this.patterns.clear();
    this.loadDir(config.builtinPatternsDir, true);
    this.loadDir(path.join(config.dataDir, "patterns"), false);
    this.order = [...this.patterns.keys()];
  }

  private loadDir(dir: string, builtin: boolean) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js")).sort()) {
      const id = (builtin ? "builtin-" : "") + file.replace(/\.js$/, "");
      const full = path.join(dir, file);
      const source = fs.readFileSync(full, "utf8");
      const stat = fs.statSync(full);
      this.patterns.set(id, this.describe(id, source, builtin, stat.birthtimeMs || stat.mtimeMs, stat.mtimeMs));
    }
  }

  private describe(id: string, source: string, builtin: boolean, createdAt: number, updatedAt: number): Pattern {
    try {
      const t = testPattern(source);
      return {
        id, name: t.compiled.name, description: t.compiled.description, tags: t.compiled.tags,
        usesBeat: t.compiled.usesBeat, builtin, params: t.compiled.params, createdAt, updatedAt,
        swatch: t.swatch, source,
      };
    } catch (e) {
      let name = id;
      try { name = compilePattern(source).name; } catch { /* keep id */ }
      const m = /name\s*:\s*["'`]([^"'`]+)["'`]/.exec(source);
      if (m) name = m[1];
      return { id, name, description: "", tags: [], usesBeat: false, builtin, params: {}, createdAt, updatedAt, error: (e as Error).message, source };
    }
  }

  listPatterns(): PatternMeta[] {
    return this.order.map((id) => this.patterns.get(id)!).filter(Boolean).map(({ source: _s, ...meta }) => meta);
  }
  getPattern(id: string): Pattern | undefined { return this.patterns.get(id); }

  /** Validate and save. Built-ins are copied to a user pattern on first edit. */
  savePattern(input: { id?: string; name?: string; source: string }): Pattern {
    const test = testPattern(input.source); // throws on error
    let id = input.id;
    const existing = id ? this.patterns.get(id) : undefined;
    if (!id || !existing || existing.builtin) {
      const base = slug(test.compiled.name || input.name || "pattern");
      id = `${base}-${nanoid(6)}`;
    }
    const now = Date.now();
    const file = path.join(config.dataDir, "patterns", `${id}.js`);
    fs.writeFileSync(file, input.source);
    const pattern: Pattern = {
      id, name: test.compiled.name, description: test.compiled.description, tags: test.compiled.tags,
      usesBeat: test.compiled.usesBeat, builtin: false, params: test.compiled.params,
      createdAt: existing && !existing.builtin ? existing.createdAt : now, updatedAt: now, swatch: test.swatch, source: input.source,
    };
    this.patterns.set(id, pattern);
    if (!this.order.includes(id)) this.order.push(id);
    this.emit("patterns");
    return pattern;
  }

  deletePattern(id: string) {
    const p = this.patterns.get(id);
    if (!p) return false;
    if (p.builtin) throw new Error("Built-in patterns cannot be deleted (duplicate and edit instead)");
    fs.rmSync(path.join(config.dataDir, "patterns", `${id}.js`), { force: true });
    this.patterns.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.emit("patterns");
    return true;
  }

  duplicatePattern(id: string): Pattern {
    const p = this.patterns.get(id);
    if (!p) throw new Error("Pattern not found");
    const src = p.source.replace(/(name\s*:\s*["'`])([^"'`]+)(["'`])/, (_m, a, n, c) => `${a}${n} copy${c}`);
    return this.savePattern({ source: src });
  }

  // ---- scenes ----
  get scenes(): Scene[] { return this.scenesFile.get(); }
  upsertScene(scene: Scene) {
    const list = this.scenes.filter((s) => s.id !== scene.id);
    const idx = this.scenes.findIndex((s) => s.id === scene.id);
    if (idx >= 0) list.splice(idx, 0, scene); else list.push(scene);
    this.scenesFile.set(list);
    this.emit("scenes");
  }
  deleteScene(id: string) { this.scenesFile.set(this.scenes.filter((s) => s.id !== id)); this.emit("scenes"); }
  reorderScenes(ids: string[]) {
    const map = new Map(this.scenes.map((s) => [s.id, s]));
    const out = ids.map((id) => map.get(id)).filter((s): s is Scene => !!s);
    for (const s of this.scenes) if (!ids.includes(s.id)) out.push(s);
    this.scenesFile.set(out);
    this.emit("scenes");
  }

  // ---- playlists ----
  get playlists(): Playlist[] { return this.playlistsFile.get(); }
  upsertPlaylist(pl: Playlist) {
    const list = this.playlists.filter((p) => p.id !== pl.id);
    const idx = this.playlists.findIndex((p) => p.id === pl.id);
    if (idx >= 0) list.splice(idx, 0, pl); else list.push(pl);
    this.playlistsFile.set(list);
    this.emit("playlists");
  }
  deletePlaylist(id: string) { this.playlistsFile.set(this.playlists.filter((p) => p.id !== id)); this.emit("playlists"); }

  flush() { this.scenesFile.flush(); this.playlistsFile.flush(); }
}

export function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "pattern";
}
