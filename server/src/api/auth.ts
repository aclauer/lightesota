import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Role, Settings } from "../../../shared/src/index.js";
import { config } from "../config.js";
import { JsonFile } from "../store.js";

interface AuthData { adminToken: string; guestToken: string; }

const gen = () => randomBytes(12).toString("base64url");

export class Auth {
  private file = new JsonFile<AuthData>("auth.json", () => ({ adminToken: gen(), guestToken: gen() }));
  constructor(private getSettings: () => Settings) {}

  get adminToken() { return config.adminTokenOverride ?? this.file.get().adminToken; }
  get guestToken() { return this.file.get().guestToken; }
  regenerateGuest() { this.file.update((d) => ({ ...d, guestToken: gen() })); return this.guestToken; }
  regenerateAdmin() { this.file.update((d) => ({ ...d, adminToken: gen() })); return this.adminToken; }

  roleForToken(token: string | undefined, remoteAddress: string | undefined): Role {
    // A dedicated integration credential never becomes a browser/admin credential,
    // even if an operator accidentally reuses its value in the older auth store.
    if (token && isGiskardToken(token)) return "viewer";
    if (token && equalToken(token, this.adminToken)) return "admin";
    if (token && equalToken(token, this.guestToken)) {
      const p = this.getSettings().sharing.guestPermission;
      return p === "edit" ? "editor" : p === "control" ? "guest" : "viewer";
    }
    return "viewer";
  }

  /** Machine API never accepts query/cookie tokens or tokenless loopback privileges. */
  roleForBearer(req: IncomingMessage): Role | null {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match || isGiskardToken(match[1]) || !(equalToken(match[1], this.adminToken) || equalToken(match[1], this.guestToken))) return null;
    return this.roleForToken(match[1], undefined);
  }

  roleForRequest(req: IncomingMessage): Role {
    const cookies = parseCookies(req.headers.cookie);
    // Share-link exchange remains browser-only; never treat loopback/proxy origin as admin.
    const token = cookies["lt_token"];
    return this.roleForToken(token, undefined);
  }
}

function isGiskardToken(token: string): boolean {
  const dedicated = process.env.LIGHTESOTA_GISKARD_TOKEN;
  return !!dedicated && equalToken(token, dedicated);
}

function equalToken(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function isLoopback(addr: string | undefined) {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (["__proto__", "constructor", "prototype"].includes(key)) continue;
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* Malformed cookies grant no privileges. */ }
  }
  return out;
}
