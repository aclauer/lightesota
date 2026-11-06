import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Request, Response } from "express";
import { config } from "../config.js";
import { defaultRig, defaultSettings, migrateRig } from "../defaults.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { JsonFile } from "../store.js";
import { OutputManager } from "../output/output.js";
import { Auth, parseCookies } from "./auth.js";
import { machineCommand, machineState, controlState } from "./control.js";
import { dispatchControl } from "./commands.js";
import { importData } from "./import.js";
import type { AppContext } from "./context.js";

function setup() {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lightesota-control-"));
  fs.mkdirSync(path.join(config.dataDir, "patterns"));
  fs.writeFileSync(path.join(config.dataDir, "auth.json"), JSON.stringify({ adminToken: "fake-admin-test-only", guestToken: "fake-guest-test-only" }));
  const rigFile = new JsonFile("rig.json", defaultRig), settingsFile = new JsonFile("settings.json", defaultSettings);
  const library = new Library(); library.load();
  const show = new ShowController(library, () => rigFile.get(), () => settingsFile.get());
  show.engine.setRig(rigFile.get());
  const output = new OutputManager(show.engine, settingsFile.get(), rigFile.get(), () => show.state);
  const ctx = { show, output, library, rigFile, settingsFile, auth: new Auth(() => settingsFile.get()), applyConfig() { output.apply(settingsFile.get(), rigFile.get()); show.rigChanged(); } } as AppContext;
  return ctx;
}
function response() {
  const r = { code: 200, body: undefined as any, status(n: number) { this.code = n; return this; }, json(body: unknown) { this.body = body; return this; }, setHeader() {} };
  return r;
}
function request(command?: unknown, generation?: number, authorization?: string): Request {
  return { headers: { authorization }, body: {command, generation}, socket: {remoteAddress: "127.0.0.1"}, url: "/api/control/state?t=fake-admin-test-only" } as Request;
}

test("machine REST requires Bearer even on loopback and shares validated browser state", () => {
  const ctx = setup();
  try {
    for (const header of [undefined, "Basic fake-admin-test-only", "Bearer wrong"]) {
      const r = response(); machineState(ctx, request(undefined, undefined, header), r as unknown as Response);
      assert.equal(r.code, 401);
    }
    assert.equal(ctx.auth.roleForRequest({ headers: {}, socket: {remoteAddress: "127.0.0.1"}, url: "/" } as any), "viewer");
    assert.deepEqual(parseCookies("lt_token=%ZZ; ok=value"), {ok:"value"});
    const generation = ctx.show.state.generation;
    const r = response();
    machineCommand(ctx, request({type: "setWash", fixtureIds: ["w1"], patch: {mode: "music6",brightness: 38}}, generation, "Bearer fake-guest-test-only"), r as unknown as Response);
    assert.equal(r.code, 200); assert.equal(r.body.washes.w1.mode, "music6"); assert.equal(r.body.washes.w2.mode, "off");
    assert.equal(r.body.available, false); assert.equal(r.body.ownership.status, "preview"); assert.equal(r.body.ownership.physicalState, "unverified");
    dispatchControl(ctx, {type: "setWash", fixtureIds: ["w1"], patch: {brightness: 25}}, {role: "guest",name:"browser"}, r.body.generation);
    assert.equal(controlState(ctx).washes.w1.mode, "music6");
    const stale = response(); machineCommand(ctx, request({type: "setWash", fixtureIds: ["w2"], patch:{mode:"normal"}}, generation, "Bearer fake-guest-test-only"), stale as unknown as Response);
    assert.equal(stale.code, 409); assert.equal(ctx.show.state.washes.w2.mode, "off");
    const stop = response(); machineCommand(ctx, request({type:"stopLighting"}, generation, "Bearer fake-guest-test-only"), stop as unknown as Response);
    assert.equal(stop.code, 200); assert.equal(ctx.show.state.stopped, true);
  } finally { ctx.show.stop(); ctx.library.flush(); }
});

test("guest cannot arm, choose laser presets, inject raw overrides, or use laser-inclusive quick shows", () => {
  const ctx = setup();
  try {
    for (const cmd of [
      {type:"armLasers", armed:true}, {type:"setLaser", fixtureId:"l1",state:{mode:"manual"}},
      {type:"setOverride", fixtureId:"l1",override:{dim:1}}, {type:"testFixture",fixtureId:"l1"},
      {type:"quickLook",lookId:"laser-duo"},
      {type:"startCoordinatedShow",params:{id:"neon-exchange",fixtureIds:["w1"],includeLasers:true}},
    ]) {
      const r = response(); machineCommand(ctx, request(cmd, ctx.show.state.generation, "Bearer fake-guest-test-only"), r as unknown as Response);
      assert.ok([400,403].includes(r.code));
    }
    assert.equal(ctx.show.state.lasers.armed, false);
    const malformed = response();
    machineCommand(ctx, request({type:"startCoordinatedShow"},ctx.show.state.generation,"Bearer fake-guest-test-only"),malformed as unknown as Response);
    assert.equal(malformed.code,400);
    const generation = ctx.show.state.generation;
    assert.throws(() => dispatchControl(ctx, {type:"setMaster",master:NaN}, {role:"admin",name:"test"}, generation), /finite/);
    assert.equal(ctx.show.state.generation, generation);
  } finally { ctx.show.stop(); }
});

test("invalid import is fully rejected before library, settings, rig or show mutation", () => {
  const ctx = setup();
  try {
    ctx.show.setWash(["w1"],{mode:"music32",brightness:38});
    const before = JSON.stringify({rig:ctx.rigFile.get(),settings:ctx.settingsFile.get(),show:ctx.show.state,patterns:ctx.library.listPatterns(),scenes:ctx.library.scenes});
    const source = 'export default {name:"Imported",render(ctx){ctx.fill("#ff0000");}};';
    const invalid = {version:1,rig:defaultRig(),settings:{artnet:{enabled:false}},patterns:[{id:"safe-import",source},{id:"broken",source:"invalid code!"}]};
    assert.throws(() => importData(ctx, invalid));
    assert.equal(JSON.stringify({rig:ctx.rigFile.get(),settings:ctx.settingsFile.get(),show:ctx.show.state,patterns:ctx.library.listPatterns(),scenes:ctx.library.scenes}), before);
    assert.equal(fs.existsSync(path.join(config.dataDir,"patterns","safe-import.js")), false);
    const rig = defaultRig(); rig.fixtures[0].address = 51; rig.protectedRanges=[];
    assert.throws(() => importData(ctx,{rig}), /reserved/);
    importData(ctx, {version:1,patterns:[{id:"safe-import",source}],settings:{artnet:{enabled:true,upstream:{enabled:true}},hue:{enabled:true,bridgeIp:"invalid.example",username:"fake-test-only"}}, show:{stopped:false,lasers:{armed:true}}});
    assert.ok(ctx.library.getPattern("safe-import"));
    assert.equal(ctx.show.state.stopped,true); assert.equal(ctx.show.state.lasers.armed,false);
    assert.equal(ctx.output.status(false).artnet.sending,false); assert.equal(ctx.output.status(false).upstream.listening,false); assert.equal(ctx.output.hue,null);
  } finally {ctx.show.stop();ctx.library.flush();}
});

test("side migration changes only exact historical tags, never user placement or custom tags", () => {
  const rig = defaultRig(); rig.fixtures[1].tags=["wash","right","front"];rig.fixtures[1].x=2.75;rig.fixtures[1].y=5.5;
  rig.fixtures[2].tags=["wash","left","back","custom"];
  const migrated = migrateRig(rig);
  assert.deepEqual(migrated.rig.fixtures[1].tags,["wash","left","front"]);
  assert.equal(migrated.rig.fixtures[1].x,2.75);assert.equal(migrated.rig.fixtures[1].y,5.5);
  assert.deepEqual(migrated.rig.fixtures[2].tags,["wash","left","back","custom"]);
  assert.equal(migrateRig(migrated.rig).changed,false);
});

test("guest unmute cannot activate admin laser intent staged through REST while muted", () => {
  const ctx = setup();
  const post = (command: unknown, admin = false) => {
    const r = response(); machineCommand(ctx, request(command, ctx.show.state.generation, `Bearer fake-${admin ? "admin" : "guest"}-test-only`), r as unknown as Response); return r;
  };
  try {
    ctx.show.setWash(["w1"], {mode:"music6", brightness:38});
    assert.equal(post({type:"setBlackout",blackout:true}).code,200);
    assert.equal(post({type:"armLasers",armed:true},true).code,200);
    const before=JSON.stringify(ctx.show.state);
    const staged=post({type:"setLaser",fixtureId:"l1",state:{mode:"manual",color:"cyan"}},true);
    const afterStaging=JSON.stringify(ctx.show.state);
    assert.equal(post({type:"setBlackout",blackout:false}).code,200);
    assert.equal(controlState(ctx).lasers.fixtures.l1?.mode ?? "off","off","guest unmute must not activate the staged REST preset");
    assert.equal(staged.code,400,"emitting intent must be refused before guest unmute");
    assert.equal(afterStaging,before,"refusal must be atomic");
    assert.equal(ctx.show.state.lasers.armed,false);
    assert.equal(ctx.show.state.lasers.fixtures.l1?.mode ?? "off","off");
    assert.equal(controlState(ctx).washes.w1.commandedBrightness,38,"wash mute remains reversible");
    assert.equal(post({type:"setLaser",fixtureId:"l1",state:{mode:"manual"}}).code,403);
    assert.equal(post({type:"armLasers",armed:true},true).code,200);
    assert.equal(post({type:"setLaser",fixtureId:"l1",state:{mode:"manual",color:"cyan"}},true).code,200);
    assert.equal(controlState(ctx).lasers.fixtures.l1.mode,"manual","fresh operator Start works after unmute");
  } finally { ctx.show.stop(); ctx.library.flush(); }
});
