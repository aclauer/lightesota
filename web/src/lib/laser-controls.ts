import type { PatternMeta, ShowState } from "@lightesota/shared";

/** UI explanation for the same explicit operator actions enforced by the command dispatcher. */
export function laserStartDisabledReason(show: ShowState, connected: boolean, admin: boolean): string | null {
  if (!connected) return "Reconnect before starting lasers.";
  if (!admin) return "An operator with admin access must start lasers.";
  if (!show.lasers.armed) return "Arm lasers before starting a preset, look or pattern layer.";
  if (show.blackout) return "Release temporary blackout before starting lasers.";
  if (show.released) return "Reacquire Lightesota output before starting lasers.";
  return null;
}

export function patternFollowDisabledReason(show: ShowState, pattern: PatternMeta | undefined, connected: boolean, admin: boolean): string | null {
  const reason = laserStartDisabledReason(show, connected, admin);
  if (reason) return reason;
  if (show.stopped || !pattern) return "Start a live pattern before following its laser layer.";
  if (pattern.error) return "Fix the live pattern error before following its laser layer.";
  if (!pattern.usesLasers) return "The live pattern has no laser section.";
  if (show.lasers.patternId !== pattern.id || show.lasers.patternRevision == null) return "Wait for the current pattern source to finish loading.";
  return null;
}
