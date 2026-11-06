import { randomBytes } from "node:crypto";
import type { DeviceInfo, Role } from "../../../shared/src/index.js";
import { JsonFile } from "../store.js";

export const DEVICE_COOKIE = "lt_device";
export const newDeviceId = () => "d" + randomBytes(9).toString("base64url");

/** Known browsers: one record per device id cookie. Names and attribution hang off this. */
export class DeviceStore {
  private file = new JsonFile<Record<string, DeviceInfo>>("devices.json", () => ({}));
  get(id: string): DeviceInfo | undefined { return this.file.get()[id]; }
  touch(id: string, patch: Partial<DeviceInfo> & { role?: Role }): DeviceInfo {
    const all = this.file.get();
    const prev = all[id];
    const now = Date.now();
    const next: DeviceInfo = { id, name: prev?.name ?? "", firstSeen: prev?.firstSeen ?? now, lastSeen: now, lastRole: patch.role ?? prev?.lastRole ?? "viewer", visits: (prev?.visits ?? 0) + (patch.visits ?? 0), ...(patch.name !== undefined ? { name: patch.name } : {}) };
    all[id] = next;
    this.file.set(all);
    return next;
  }
  list(): DeviceInfo[] { return Object.values(this.file.get()).sort((a, b) => b.lastSeen - a.lastSeen); }
  forget(id: string) { const all = this.file.get(); delete all[id]; this.file.set(all); }
}
