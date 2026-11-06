import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Repo root, whether running from src (tsx) or dist (tsc). */
export const REPO_ROOT = path.resolve(here, "..", "..");

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  dataDir: path.resolve(process.env.LIGHTESOTA_DATA ?? path.join(REPO_ROOT, "data")),
  builtinPatternsDir: path.join(REPO_ROOT, "patterns"),
  webDist: path.join(REPO_ROOT, "web", "dist"),
  adminTokenOverride: process.env.LIGHTESOTA_ADMIN_TOKEN,
  /** Lower-case names of trusted localhost origins allowed admin without a token. */
  localhostIsAdmin: (process.env.LIGHTESOTA_LOCALHOST_ADMIN ?? "1") !== "0",
};

export function ensureDataDirs() {
  for (const d of ["", "patterns", "agent"]) fs.mkdirSync(path.join(config.dataDir, d), { recursive: true });
}
