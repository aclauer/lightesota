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

test("palette hex colors mix into finite, moving blue/cyan output", () => {
  const source = (convert: boolean) => `export default {
    params: { colors: { type: "palette", default: ["#1230ff", "#00e6ff"] } },
    render(ctx) { for (const f of ctx.fixtures) {
      const [a, b] = ctx.params.colors;
      const phase = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (f.nx * 0.85 - ctx.beat / 16));
      ctx.set(f, mix(${convert ? "hex(a), hex(b)" : "a, b"}, phase), { dim: 0.15 });
    } }
  };`;
  const fixtures = syntheticFixtures();
  const direct = new PatternInstance(compilePattern(source(false)), fixtures, {}, 1);
  const explicit = new PatternInstance(compilePattern(source(true)), fixtures, {}, 1);
  const frames: number[][] = [];
  for (let frame = 0; frame < 3; frame++) {
    direct.render(0.5, 120, frame);
    explicit.render(0.5, 120, frame);
    assert.deepEqual([...direct.out], [...explicit.out], "hex inputs must match explicit conversion");
    assert.ok(direct.out.every(Number.isFinite));
    assert.ok(direct.out[2] > 0, "the requested blue must emit, not silently become black");
    assert.ok(Math.abs(direct.out[6] - 0.15) < 1e-6);
    assert.equal(direct.out[7], 0, "no strobe");
    frames.push([...direct.out]);
  }
  assert.notDeepEqual(frames[0], frames[2], "the sweep must animate");
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

test("failed, empty and malformed laser callbacks clear intent and valid callbacks stay typed", () => {
  for (const expression of ["undefined", "[]", "[{}]", "[true]", "['nonsense']", "[{mode:'manual',color:undefined}]", "[{mode:'manual',color:()=>1}]"]) {
    const instance = new PatternInstance(compilePattern(`export default {render(){}, lasers(){return ${expression};}}`), [], {}, 1);
    instance.render(0.025, 120, 0);
    assert.ok(instance.lasers()!.every((state) => state.mode === "off"), expression);
  }
  const instance = new PatternInstance(compilePattern(`export default {render(ctx){if(ctx.frame) throw new Error('bad frame');}, lasers(){return [{color:'#00ffff', spread:1}];}}`), [], {}, 1);
  instance.render(0.025, 120, 0);
  assert.equal(instance.lasers()![0].color, "cyan");
  instance.render(0.025, 120, 0.05);
  assert.deepEqual(instance.lasers(), [], "render errors must not keep emitting lasers");
  const timeout = new PatternInstance(compilePattern(`export default {render(){}, lasers(){while(true){}}}`), [], {}, 1);
  assert.deepEqual(timeout.lasers(), []);
  assert.match(timeout.laserError!, /timed out/);
});
