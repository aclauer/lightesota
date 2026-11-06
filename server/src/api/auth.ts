import { randomBytes } from "node:crypto";
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
    if (token && token === this.adminToken) return "admin";
    if (token && token === this.guestToken) {
      const p = this.getSettings().sharing.guestPermission;
      return p === "edit" ? "editor" : p === "control" ? "guest" : "viewer";
    }
    if (config.localhostIsAdmin && isLoopback(remoteAddress)) return "admin";
    return "viewer";
  }

  roleForRequest(req: IncomingMessage): Role {
    const cookies = parseCookies(req.headers.cookie);
    const url = new URL(req.url ?? "/", "http://x");
    const token = url.searchParams.get("t") ?? cookies["lt_token"];
    return this.roleForToken(token ?? undefined, req.socket.remoteAddress);
  }
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
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
