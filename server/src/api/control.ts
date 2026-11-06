import type { Request, Response } from "express";
import type { AppContext } from "./context.js";
import { OUTPUT_VETO, PREVIEW, HAZE_VETO, HAZE_DISABLED_REASON } from "../output/policy.js";
import { CommandError, dispatchControl } from "./commands.js";
import { defaultLaserState, laserBytes, laserFixtures } from "../../../shared/src/index.js";

import { planUniverse, renderUniverse } from "../output/dmx.js";

export function controlState(ctx: AppContext) {
  const s = ctx.show.state;
  const enabled = ctx.settingsFile.get().artnet.enabled || ctx.settingsFile.get().hue.enabled;
  const output = ctx.output.status(false);
  const settings = ctx.settingsFile.get();
  const failed = (settings.artnet.enabled && !!output.artnet.error) || (settings.hue.enabled && !!output.hue.lastError);
  const status = PREVIEW ? "preview" : OUTPUT_VETO ? "uncommissioned" : s.released ? "released" : "commanding";
  const frame = ctx.show.engine.lastFrame;
  const rig = ctx.rigFile.get(), universe = settings.artnet.universe;
  const plan = planUniverse(rig, universe), packed = new Uint8Array(512);
  const muted = s.stopped || s.blackout || s.released;
  if (frame && !muted) renderUniverse(rig, frame.fixtures, frame.values, universe, plan, packed, s.washes);
  const blocked = new Set(plan.blocked.map((entry) => entry.fixtureId));
  const washes = Object.fromEntries(Object.entries(s.washes).map(([id, wash]) => {
    const i = frame?.fixtures.findIndex((f) => f.id === id) ?? -1;
    const fixture = rig.fixtures.find((f) => f.id === id);
    const address = fixture?.address ?? 0;
    const commandedBrightness = fixture?.enabled && (fixture.universe ?? 0) === universe && address > 0 && !blocked.has(id) ? packed[address - 1] : 0;
    const commandedMode = commandedBrightness === 0 ? "off" : wash.owner === "pattern" ? "normal" : wash.mode;
    if (wash.owner !== "pattern" || i < 0) return [id, { ...wash, commandedMode, commandedBrightness }];
    const rgbw = Array.from(frame!.values.slice(i * 8, i * 8 + 4), (v) => Math.round(Math.max(0, Math.min(1, v)) * 255));
    return [id, { ...wash, rgbw, brightness: commandedBrightness, commandedBrightness, commandedMode, mode: commandedBrightness > 0 ? "normal" : "off" }];
  }));
  return {
    generation: s.generation, controlledAt: s.controlledAt, stopped: s.stopped,
    washes, lasers: { ...s.lasers, fixtures: Object.fromEntries(laserFixtures(rig).map((f) => {
      const requested = s.lasers.fixtures[f.id] ?? defaultLaserState();
      const admitted = !muted && (f.universe ?? 0) === universe && [31, 41].includes(f.address ?? 0) && !blocked.has(f.id);
      const emitting = admitted && laserBytes(requested, s.lasers.armed, s.blackout).some((byte) => byte !== 0);
      return [f.id, { ...requested, requestedMode: requested.mode, mode: emitting ? requested.mode : "off" }];
    })) }, blackout: s.blackout,
    haze: { ...s.haze, commissioned: !HAZE_VETO, disabledReason: HAZE_DISABLED_REASON },
    master: s.master, coordinatedShow: s.coordinatedShow,
    rig: ctx.rigFile.get(),
    available: !OUTPUT_VETO && !s.released && enabled && !failed,
    // Availability describes the control/output path, not observed fixture light or reachability.
    ownership: { authority: "lightesota", status, physicalState: "unverified", legacySenderRetired: false },
  };
}
export function machineState(ctx: AppContext, req: Request, res: Response) {
  if (!ctx.auth.roleForBearer(req)) return res.status(401).json({ error: "Bearer authentication required" });
  res.setHeader("Cache-Control", "no-store");
  return res.json(controlState(ctx));
}
export function machineCommand(ctx: AppContext, req: Request, res: Response) {
  const role = ctx.auth.roleForBearer(req);
  if (!role) return res.status(401).json({ error: "Bearer authentication required" });
  try {
    dispatchControl(ctx, req.body?.command, { role, name: "machine client" }, req.body?.generation);
    res.setHeader("Cache-Control", "no-store");
    return res.json(controlState(ctx));
  } catch (e) {
    return res.status(e instanceof CommandError ? e.status : 400).json({ error: (e as Error).message, generation: ctx.show.state.generation });
  }
}
