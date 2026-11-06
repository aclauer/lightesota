import assert from "node:assert/strict";
import test from "node:test";
import { defaultLasersState, type PatternMeta, type ShowState } from "@lightesota/shared";
import { laserStartDisabledReason, patternFollowDisabledReason } from "../src/lib/laser-controls.js";

test("laser looks and Follow expose disabled reasons and require the current loaded pattern revision", () => {
  const pattern = { id: "palette", usesLasers: true } as PatternMeta;
  const show = { patternId: pattern.id, stopped: false, blackout: false, released: false, lasers: { ...defaultLasersState(), patternId: pattern.id, patternRevision: 7 } } as ShowState;
  assert.match(laserStartDisabledReason(show, true, true)!, /Arm lasers/);
  assert.match(patternFollowDisabledReason(show, pattern, true, true)!, /Arm lasers/);
  show.lasers.armed = true;
  assert.equal(patternFollowDisabledReason(show, pattern, true, true), null);
  assert.match(patternFollowDisabledReason(show, pattern, true, false)!, /operator/);
  assert.match(laserStartDisabledReason(show, false, true)!, /Reconnect/);
  show.blackout = true;
  assert.match(patternFollowDisabledReason(show, pattern, true, true)!, /blackout/);
  show.blackout = false;
  show.released = true;
  assert.match(laserStartDisabledReason(show, true, true)!, /Reacquire/);
  show.released = false;
  show.stopped = true;
  assert.match(patternFollowDisabledReason(show, pattern, true, true)!, /Start a live pattern/);
  show.stopped = false;
  show.lasers.patternId = "previous-pattern";
  assert.match(patternFollowDisabledReason(show, pattern, true, true)!, /finish loading/);
  show.lasers.patternId = pattern.id;
  show.lasers.patternRevision = null;
  assert.match(patternFollowDisabledReason(show, pattern, true, true)!, /finish loading/);
});
