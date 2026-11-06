import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { defaultHazeState, engineFixtures, type Scene } from "../../../shared/src/index.js";
import { config } from "../config.js";
import { defaultRig, defaultSettings, migrateRig } from "../defaults.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { OutputManager } from "../output/output.js";
import { planUniverse, renderUniverse } from "../output/dmx.js";
import type { Engine } from "../engine/engine.js";
import { dispatchControl } from "./commands.js";
import { validateRig, validateScene } from "./validate.js";
import { WsHub } from "./ws.js";
import type { AppContext } from "./context.js";

function setup(t: TestContext) {
  config.dataDir=fs.mkdtempSync(path.join(os.tmpdir(),"lightesota-haze-"));
  fs.mkdirSync(path.join(config.dataDir,"patterns"));
  const rig=defaultRig(), settings=defaultSettings(), library=new Library();
  rig.fixtures.find(f=>f.id==='h1')!.enabled=true; // Preserve Andrew's already-saved enabled fixture.
  const show=new ShowController(library,()=>rig,()=>settings);
  const ctx={show,library,rigFile:{get:()=>rig},settingsFile:{get:()=>settings}} as unknown as AppContext;
  t.after(()=>{show.stop();library.flush();});
  return {rig,show,ctx};
}

test("haze commissioning defaults closed in shared mutator; rejected messages are atomic", (t) => {
  const {show}=setup(t);
  const before=JSON.stringify(show.state);
  for(const message of [{armed:true},{armed:true,runSec:30},{runSec:30},{armed:true,fan:NaN},{armed:false,output:2}]) {
    assert.throws(()=>show.setHaze(message,'operator'));
    assert.equal(JSON.stringify(show.state),before);
  }
  // No state/import field can commission this process.
  Object.assign(show.state.haze,{commissioned:true});
  assert.throws(()=>show.setHaze({armed:true},'operator'),/commission|preview/i);
});

test("haze defaults and migrations preserve protected ranges, saved fixtures and layout", () => {
  const rig=defaultRig();
  assert.equal(rig.fixtures.find(f=>f.id==='h1')!.enabled,false);
  const old=structuredClone(rig);old.fixtures=old.fixtures.filter(f=>f.id!=='h1');
  old.protectedRanges=[{universe:0,from:51,to:52,reason:'Hazer reserved'}];
  const migrated=migrateRig(old);
  assert.deepEqual(migrated.rig.protectedRanges,old.protectedRanges);
  assert.equal(migrated.rig.fixtures.find(f=>f.id==='h1')!.enabled,false);
  const saved=structuredClone(rig);const haze=saved.fixtures.find(f=>f.id==='h1')!;
  haze.enabled=true;haze.x=2.75;haze.y=6;haze.tags=['haze','custom'];
  assert.deepEqual(migrateRig(saved).rig,saved);
  assert.deepEqual(validateRig(saved).fixtures.find(f=>f.id==='h1'),haze);
  const remapped=structuredClone(saved);remapped.fixtures.find(f=>f.id==='h1')!.address=53;
  assert.throws(()=>validateRig(remapped),/reserved|51/);
  const custom=structuredClone(saved);custom.customProfiles=[{id:'raw-haze',name:'Raw',kind:'haze',transport:'dmx',colorModel:'dimmer',channels:[{fn:'fixed',name:'Fan',value:255},{fn:'fixed',name:'Haze',value:255}]}];
  assert.throws(()=>validateRig(custom),/reserved/);
});

test("haze uses shared WS roles and generations; stale hazeOff remains a safe control action", (t) => {
  const {show,ctx}=setup(t);
  // Run the actual WS handler with an in-memory socket, no WebSocket server or listening socket.
  const hub=Object.assign(Object.create(WsHub.prototype),{ctx,clients:new Map()}) as any;
  const replies:any[]=[];
  const client={role:'admin',name:'fake operator',ws:{readyState:1,send:(s:string)=>replies.push(JSON.parse(s))}};
  const before=JSON.stringify(show.state);
  hub.onMessage(client,JSON.stringify({type:'setHaze',armed:true,reqId:'stale',generation:show.state.generation-1}));
  assert.match(replies.at(-1).text,/Stale/);
  assert.equal(JSON.stringify(show.state),before);
  for(const role of ['guest','editor','viewer']) {
    client.role=role;
    hub.onMessage(client,JSON.stringify({type:'setHaze',armed:true,reqId:role,generation:show.state.generation}));
    assert.match(replies.at(-1).text,/Not allowed/);
  }
  client.role='admin';
  hub.onMessage(client,JSON.stringify({type:'setHaze',armed:true,commissioned:true,reqId:'invalid',generation:show.state.generation}));
  assert.match(replies.at(-1).text,/Unknown/);
  for(const role of ['guest','editor','admin'] as const) {
    Object.assign(show.state.haze,{armed:true,runUntil:Date.now()+30000});
    const old=show.state.generation;
    dispatchControl(ctx,{type:'hazeOff'},{role,name:'control'},old-1);
    assert.equal(show.state.haze.armed,false);assert.equal(show.state.haze.runUntil,null);
    assert.ok(show.state.generation>old);
  }
  assert.throws(()=>dispatchControl(ctx,{type:'hazeOff'},{role:'viewer',name:'viewer'},0),/Not allowed/);
});

test("haze cannot enter ordinary writers and final bytes remain zero for a forged active run", (t) => {
  const {rig,show,ctx}=setup(t);
  assert.ok(!engineFixtures(rig).some(f=>f.id==='h1'));
  for(const cmd of [{type:'setOverride',fixtureId:'h1',override:{dim:1}},{type:'testFixture',fixtureId:'h1'},{type:'setSolo',fixtureIds:['h1']}]) {
    assert.throws(()=>dispatchControl(ctx,cmd,{role:'admin',name:'test'},show.state.generation),/ordinary/);
  }
  const scene:Scene={id:'s',name:'bad',patternId:null,params:{},master:1,bpm:null,speed:1,overrides:{h1:{dim:1}},favorite:false,hotkey:null,swatch:[],createdAt:1,updatedAt:1};
  assert.throws(()=>validateScene(scene,rig),/ordinary/);
  const engine=new EventEmitter() as Engine;
  const state={lasers:show.state.lasers,haze:{...defaultHazeState(),armed:true,fan:1,output:1,runUntil:Date.now()+30000},blackout:false,stopped:false};
  const settings=defaultSettings();settings.artnet.enabled=false;
  const output=new OutputManager(engine,settings,rig,()=>state);
  let bytes:number[]=[];output.onDmx=(_u,b)=>{bytes=Array.from(b.slice(50,52));};
  const frame={t:0,fixtures:rig.fixtures,values:new Float32Array(rig.fixtures.length*8).fill(1),colors:[]};
  engine.emit('frame',frame);assert.deepEqual(bytes,[0,0]);
  const raw=new Uint8Array(512);renderUniverse(rig,frame.fixtures,frame.values,0,planUniverse(rig,0),raw);
  assert.deepEqual(Array.from(raw.slice(50,52)),[0,0]);
});

test("Stop manual takeover release disarm mute and restart cancel haze run and late timer", (t) => {
  const {show}=setup(t);
  for(const stop of [()=>show.stopLighting(),()=>show.takeManualControl(),()=>show.setReleased(true),()=>show.lasersOff('operator'),()=>show.setBlackout(true),()=>show.setBlackout(false)]) {
    Object.assign(show.state.haze,{armed:true,runUntil:Date.now()+30000});
    stop();
    assert.equal(show.state.haze.armed,false);assert.equal(show.state.haze.runUntil,null);
    (show as any).hazeTick();
    assert.equal(show.state.haze.runUntil,null);
  }
});
