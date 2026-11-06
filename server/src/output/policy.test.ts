import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ArtNetSender, ArtNetListener } from "./artnet.js";
import { HueBridge } from "./hue.js";
import { OutputManager } from "./output.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { defaultLasersState } from "../../../shared/src/index.js";
import type { Engine } from "../engine/engine.js";
import type { EngineFrame } from "../engine/engine.js";
import { OUTPUT_VETO } from "./policy.js";

test("preview veto is process-wide: settings cannot create any physical transport", async () => {
  assert.equal(OUTPUT_VETO, true);
  const settings = defaultSettings();
  settings.artnet.enabled = true;
  settings.artnet.upstream.enabled = true;
  settings.hue.enabled = true;
  settings.hue.bridgeIp = "invalid.example";
  settings.hue.username = "fake-test-only";
  const engine = new EventEmitter() as Engine;
  const output = new OutputManager(engine, settings, defaultRig(), () => ({ lasers: defaultLasersState(), blackout: false }));
  output.apply(settings, defaultRig());
  const status = output.status(false);
  assert.equal(status.artnet.sending, false);
  assert.equal(status.upstream.listening, false);
  assert.equal(output.hue, null);
  assert.throws(() => new ArtNetSender({ host: "invalid.example", port: 6454 }).send(0, new Uint8Array(512)), /vetoed/);
  assert.throws(() => new ArtNetListener(6454, "").start(), /vetoed/);
  const hue = new HueBridge("invalid.example", "fake-test-only", 8);
  await assert.rejects(hue.pair(), /vetoed/);
  await assert.rejects(hue.listLights(), /vetoed/);
  assert.throws(() => hue.setColor("1", 1, 1, 1, 1), /vetoed/);
  await output.blackoutAndClose();
});

test("Stop zeros stale DMX and Hue frames even when another output or preview subscriber fails", () => {
  const rig = defaultRig();
  rig.fixtures.push({id:"h1",name:"Fake Hue",profileId:"hue-color-light",hueLightId:"fake1",x:0,y:0,rotation:0,tags:[],enabled:true});
  const settings = defaultSettings(); settings.hue.enabled=true;settings.hue.username="fake-test-only";
  const engine = new EventEmitter() as Engine;
  const output = new OutputManager(engine,settings,rig,()=>({lasers:defaultLasersState(),blackout:false,stopped:true}));
  let packet: number[] = [], hueDim = -1, cancelled = false;
  // Inject in-memory transports only; the real process transports remain vetoed.
  (output as any).sender = {send(_u: number, data: Uint8Array) {packet=Array.from(data);throw new Error("fake sender failure");}};
  output.hue = {cancelPending(){cancelled=true;},setColor(_id:string,_r:number,_g:number,_b:number,dim:number){hueDim=dim;}} as unknown as HueBridge;
  output.onDmx=()=>{throw new Error("fake disconnected subscriber");};
  const frame: EngineFrame={t:0,fixtures:rig.fixtures,values:new Float32Array(rig.fixtures.length*8).fill(1),colors:[]};
  assert.doesNotThrow(()=>engine.emit("frame",frame));
  assert.ok(packet.every((v)=>v===0));assert.equal(hueDim,0);assert.equal(cancelled,true);
  assert.match(output.status(false).artnet.error!,/fake sender failure/);
});

test("release reads the shared authority state and a later Stop reacquires zero output", () => {
  const engine = new EventEmitter() as Engine;
  const state = {lasers:defaultLasersState(),blackout:false,stopped:true,released:true};
  const output = new OutputManager(engine,defaultSettings(),defaultRig(),()=>state);
  let frames=0;
  output.onDmx=(_u, data)=>{frames++;assert.ok(data.every(v=>v===0));};
  const frame: EngineFrame={t:0,fixtures:defaultRig().fixtures,values:new Float32Array(64).fill(1),colors:[]};
  engine.emit("frame",frame);assert.equal(frames,0);
  state.released=false;engine.emit("frame",frame);assert.equal(frames,1);
});
