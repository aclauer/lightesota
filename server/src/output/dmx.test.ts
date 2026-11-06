import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rig } from "@lightesota/shared";
import { planUniverse, renderUniverse } from "./dmx.js";
import { OUT_STRIDE } from "../engine/sandbox.js";
import { buildArtDmx, parseArtDmx } from "./artnet.js";

const rig = (): Rig => ({
  room: { name: "t", width: 10, height: 8, gridStep: 0.5, shapes: [] },
  customProfiles: [],
  protectedRanges: [{ universe: 0, from: 31, to: 52, reason: "lasers" }],
  fixtures: [
    { id: "w1", name: "Wash 1", profileId: "chauvet-slimpar-pro-h-12ch", universe: 0, address: 101, x: 0, y: 0, rotation: 0, tags: [], enabled: true },
    { id: "s1", name: "Spot 1", profileId: "chauvet-saber-spot-ww-1ch", universe: 0, address: 29, x: 0, y: 0, rotation: 0, tags: [], enabled: true },
    { id: "bad", name: "On laser", profileId: "generic-rgb-3ch", universe: 0, address: 30, x: 0, y: 0, rotation: 0, tags: [], enabled: true },
  ],
});

test("plan blocks fixtures overlapping protected ranges", () => {
  const plan = planUniverse(rig(), 0);
  assert.deepEqual(plan.blocked.map((b) => b.fixtureId), ["bad"]);
  assert.equal(plan.owned[100], 1);
  assert.equal(plan.owned[28], 1);
  assert.equal(plan.owned[29], 0);
  for (let c = 30; c < 52; c++) assert.equal(plan.protectedMask[c], 1);
});

test("renders wash channels with dimmer carrying intensity and fixed channels set", () => {
  const r = rig();
  const plan = planUniverse(r, 0);
  const fixtures = r.fixtures.filter((f) => f.enabled);
  const values = new Float32Array(fixtures.length * OUT_STRIDE);
  // wash: red, dim 0.5, strobe 0.5
  values.set([1, 0, 0, 0, 0, 0, 0.5, 0.5], 0);
  // spot: color white dim 1 -> intensity = max(rgb)*dim
  values.set([1, 1, 1, 0, 0, 0, 1, 0], OUT_STRIDE);
  // bad fixture: full white, must not appear
  values.set([1, 1, 1, 0, 0, 0, 1, 0], OUT_STRIDE * 2);
  const out = new Uint8Array(512);
  renderUniverse(r, fixtures, values, 0, plan, out);
  assert.deepEqual([...out.slice(100, 112)], [128, 255, 0, 0, 0, 0, 0, 0, 133, 0, 32, 52]);
  assert.equal(out[28], 255);
  assert.equal(out[29], 0);
  assert.equal(out[30], 0);
  assert.equal(out[31], 0);
});

test("Art-Net packet round trip", () => {
  const data = new Uint8Array(512); data[0] = 255; data[511] = 7;
  const pkt = buildArtDmx(3, data, 42);
  assert.equal(pkt.length, 530);
  assert.equal(pkt.toString("ascii", 0, 7), "Art-Net");
  const parsed = parseArtDmx(pkt)!;
  assert.equal(parsed.universe, 3);
  assert.equal(parsed.data[0], 255);
  assert.equal(parsed.data[511], 7);
  assert.equal(parseArtDmx(Buffer.from("nope")), null);
});
