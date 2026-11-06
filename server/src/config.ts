import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Walk up from this file until the directory that holds package.json and patterns/ (works from src and dist). */
function findRepoRoot(start: string): string {
  let d = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(d, "package.json")) && fs.existsSync(path.join(d, "patterns"))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return path.resolve(start, "..", "..");
}
export const REPO_ROOT = findRepoRoot(here);

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: path.resolve(process.env.LIGHTESOTA_DATA ?? path.join(REPO_ROOT, "data")),
  builtinPatternsDir: path.join(REPO_ROOT, "patterns"),
  webDist: path.join(REPO_ROOT, "web", "dist"),
  adminTokenOverride: process.env.LIGHTESOTA_ADMIN_TOKEN,
  /** Deprecated compatibility field; authentication never depends on source address. */
  localhostIsAdmin: false, // Compatibility field: origin is never authentication, including proxies.
};

export function ensureDataDirs() {
  for (const d of ["", "patterns", "agent"]) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
}
