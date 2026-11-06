import { test } from "node:test";
import assert from "node:assert/strict";
import { compilePattern, PatternInstance, syntheticFixtures, testPattern, OUT_STRIDE } from "./sandbox.js";

const SOLID = `export default { name: "Solid", params: { color: { type: "color", default: "#ff0000" } }, render(ctx) { ctx.fill(ctx.params.color, { dim: 0.5 }); } };`;

test("compiles an ES-module style pattern and renders", () => {
  const r = testPattern(SOLID);
  assert.equal(r.compiled.name, "Solid");
  assert.equal(r.litFixtures, r.fixtureCount);
  assert.deepEqual(Object.keys(r.compiled.params), ["color"]);
});

test("rejects syntax errors and missing render", () => {
  assert.throws(() => compilePattern("export default { name: 'x', render(ctx) { ctx.fill( } }"), /Syntax error/);
  assert.throws(() => compilePattern("module.exports = { name: 'x' }"), /render/);
});

test("validates param schemas", () => {
  assert.throws(() => compilePattern(`export default { params: { bad: { type: "number", min: 5, max: 1 } }, render() {} }`), /bad number range/);
  assert.throws(() => compilePattern(`export default { params: { bad: { type: "wat" } }, render() {} }`), /unknown type/);
});

test("render timeout disables the pattern instead of hanging", () => {
  const compiled = compilePattern(`export default { render() { while (true) {} } }`);
  const inst = new PatternInstance(compiled, syntheticFixtures(), {}, 1);
  inst.timeoutMs = 50;
  const t0 = Date.now();
  inst.render(0.025, 120, 0);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(inst.disabled);
  assert.match(inst.error ?? "", /took longer/);
});

test("sandbox has no access to node globals", () => {
  const r = testPattern(`export default { render(ctx) { ctx.state.p = typeof process; ctx.state.r = typeof require; ctx.fill([typeof process === "undefined" ? 1 : 0, typeof require === "undefined" ? 1 : 0, 0]); } };`);
  assert.equal(r.swatch[0], "#ffff00");
});

test("NaN output is sanitized", () => {
  const compiled = compilePattern(`export default { render(ctx) { ctx.fill([NaN, 2, -1]); } };`);
  const inst = new PatternInstance(compiled, syntheticFixtures(), {}, 1);
  inst.render(0.025, 120, 0);
  assert.deepEqual([...inst.out.slice(0, 3)], [0, 1, 0]);
  assert.equal(inst.out.length, syntheticFixtures().length * OUT_STRIDE);
});
