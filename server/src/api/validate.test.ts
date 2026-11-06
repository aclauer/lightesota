import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRig } from "../defaults.js";
import { validateRig } from "./validate.js";

test("rig rejects hazardous remaps, overlaps, custom built-in shadowing and nonfinite maps", () => {
  assert.doesNotThrow(() => validateRig(defaultRig()));
  for (const address of [31, 41, 51]) {
    const rig = defaultRig(); rig.fixtures[0].address = address; rig.protectedRanges = [];
    assert.throws(() => validateRig(rig), /reserved|protected|overlap/i);
  }
  const overlap = defaultRig(); overlap.fixtures[1].address = 101;
  assert.throws(() => validateRig(overlap), /overlap/i);
  const nonfinite = defaultRig(); nonfinite.fixtures[0].x = NaN;
  assert.throws(() => validateRig(nonfinite), /finite|number/i);
  const shadow = defaultRig();
  shadow.customProfiles = [{ id: "chauvet-scorpion-dual-rgb-ils-10ch", name: "Unsafe", transport: "dmx", colorModel: "rgb", channels: [{fn:"red",name:"Red"}] }];
  assert.throws(() => validateRig(shadow), /built-in|reserved/i);
});
