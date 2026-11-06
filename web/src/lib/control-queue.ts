import type { ClientMessage } from "@lightesota/shared";

const CONTROL_TYPES = new Set([
  "setPattern", "setParams", "setMaster", "setBlackout", "setSpeed", "setCrossfade", "setBpm", "tap", "resync", "nudge", "setOverride", "clearOverrides", "setSolo", "armLasers", "setLaser", "setLaserLook", "followPatternLasers", "lasersOff", "setReleased", "recallScene", "playPlaylist", "stopPlaylist", "playlistNext", "playlistPrev", "testFixture", "setFollowMicBpm", "setSleep", "stopLighting", "takeManualControl", "setWash", "releaseWashes", "quickLook", "startCoordinatedShow", "setHaze", "hazeOff",
]);
export const isQueuedControl = (msg: ClientMessage) => CONTROL_TYPES.has(msg.type);
export const isImmediateStop = (msg: ClientMessage) => msg.type === "stopLighting" || msg.type === "lasersOff" || msg.type === "hazeOff" || (msg.type === "setHaze" && msg.armed === false) || (msg.type === "armLasers" && !msg.armed) || (msg.type === "setBlackout" && msg.blackout) || (msg.type === "setReleased" && msg.released);

type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Entry = { msg: ClientMessage; generation: number | undefined; key: string | null; waiters: Waiter[] };

/** Only our correlated acknowledgement can carry pending gestures across a generation barrier. */
export class ControlQueue {
  private pending: Entry[] = [];
  private active: Entry | null = null;

  constructor(private request: (msg: ClientMessage) => Promise<unknown>, private generation: () => number | undefined) {}

  enqueue(msg: ClientMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const generation = msg.generation ?? this.generation();
      const key = coalesceKey(msg);
      const previous = this.pending.at(-1);
      if (key && previous?.key === key && previous.generation === generation) {
        previous.msg = msg;
        previous.waiters.push({ resolve, reject });
      } else this.pending.push({ msg, generation, key, waiters: [{ resolve, reject }] });
      this.drain();
    });
  }

  cancel(reason = "Pending controls canceled; make a new selection to continue.") {
    const error = new Error(reason);
    if (this.active) this.active.waiters.forEach((waiter) => waiter.reject(error));
    this.active = null;
    for (const entry of this.pending) entry.waiters.forEach((waiter) => waiter.reject(error));
    this.pending = [];
  }

  private drain() {
    if (this.active || !this.pending.length) return;
    const entry = this.pending.shift()!;
    if (entry.generation === undefined || entry.generation !== this.generation()) {
      entry.waiters.forEach((waiter) => waiter.reject(new Error("Stale control generation; make a new selection to continue.")));
      this.cancel();
      return;
    }
    this.active = entry;
    void this.request({ ...entry.msg, generation: entry.generation }).then((result) => {
      if (this.active !== entry) return;
      this.active = null;
      entry.waiters.forEach((waiter) => waiter.resolve(result));
      const acknowledged = (result as { generation?: unknown } | null)?.generation;
      if (typeof acknowledged !== "number" || acknowledged !== this.generation()) {
        this.cancel("Lighting changed while controls were pending; make a new selection to continue.");
        return;
      }
      for (const pending of this.pending) {
        if (pending.generation !== entry.generation && pending.generation !== acknowledged) {
          this.cancel("Lighting changed while controls were pending; make a new selection to continue.");
          return;
        }
        pending.generation = acknowledged;
      }
      this.drain();
    }, (error: Error) => {
      if (this.active !== entry) return;
      this.active = null;
      entry.waiters.forEach((waiter) => waiter.reject(error));
      this.cancel("Pending controls canceled after a failed command; make a new selection to continue.");
    });
  }
}

/** Coalesce only adjacent changes to the same fields; mode/Start/ownership commands retain order. */
function coalesceKey(msg: ClientMessage): string | null {
  switch (msg.type) {
    case "setMaster": case "setSpeed": case "setBpm": case "setCrossfade": return msg.type;
    case "setParams": return JSON.stringify([msg.type, msg.merge !== false, Object.keys(msg.params).sort()]);
    case "setWash": return msg.patch.mode === undefined ? JSON.stringify([msg.type, [...msg.fixtureIds].sort(), Object.keys(msg.patch).sort()]) : null;
    case "setLaser": return msg.state.mode === undefined ? JSON.stringify([msg.type, msg.fixtureId, Object.keys(msg.state).sort()]) : null;
    case "setHaze": return msg.armed === undefined && msg.runSec === undefined ? JSON.stringify([msg.type, Object.keys(msg).filter(k => !["type", "generation", "reqId"].includes(k)).sort()]) : null;
    case "setOverride": return msg.override ? JSON.stringify([msg.type, msg.fixtureId, Object.keys(msg.override).sort()]) : null;
    default: return null;
  }
}
