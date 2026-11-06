import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { defaultLaserState, type Scene } from '../../../shared/src/index.js';
import { config } from '../config.js';
import { defaultRig, defaultSettings } from '../defaults.js';
import { Library } from '../library.js';
import { ShowController } from '../show.js';
import { WsHub } from './ws.js';
import { dispatchControl } from './commands.js';
import { controlState } from './control.js';
import type { AppContext } from './context.js';

function setup(t: TestContext) {
  config.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lightesota-reconcile-'));
  fs.mkdirSync(path.join(config.dataDir, 'patterns'));
  const library = new Library();
  const source = 'export default { name:"Pattern lasers", render(ctx){ctx.fill("#00ffff");}, lasers(ctx){return [{pattern:"wave",color:"cyan",spread:0.5}];} }';
  const pattern = library.savePattern({source});
  const named = library.savePattern({source:'export default {name:"Named lasers",render(ctx){ctx.fill("#fff");},lasers:"breathe"}'});
  const plain = library.savePattern({source:'export default {name:"Washes",render(ctx){ctx.fill("#fff");}}'});
  const rig = defaultRig(), settings = defaultSettings();
  const show = new ShowController(library, () => rig, () => settings);
  const internal = show.engine as any;
  t.mock.method(internal, 'ensureWorker', () => {});
  t.mock.method(internal, 'post', () => {});
  show.engine.setRig(rig);
  const ctx = {show, library, rigFile:{get:()=>rig}, settingsFile:{get:()=>settings}, output:{status:()=>({artnet:{},hue:{}})}} as unknown as AppContext;
  const command = (raw: unknown, role: 'admin'|'guest'|'editor' = 'admin', generation = show.state.generation) => dispatchControl(ctx,raw,{role,name:'test'},generation);
  function load(p = pattern) {
    show.setPattern(p.id,{},0);
    internal.onWorkerMessage({type:'loaded',slot:'a',id:p.id,params:{},usesLasers:p.usesLasers,laserLook:p.id===named.id?'breathe':null,revision:show.engine.patternRevision,generation:show.engine.patternGeneration});
  }
  const follow = () => command({type:'followPatternLasers',patternId:show.state.patternId,revision:show.engine.patternRevision});
  const frame = () => ({states:[{...defaultLaserState(),mode:'manual' as const,color:'cyan' as const}],id:show.state.patternId,revision:show.engine.patternRevision,generation:show.engine.patternGeneration});
  t.after(() => {show.stop(); library.flush();});
  return {show,library,pattern,named,plain,ctx,command,load,follow,frame,internal};
}

test('armed pattern/scene selection never delegates lasers; Follow requires the loaded revision and operator', (t) => {
  const {show,command,load,follow,frame,plain} = setup(t);
  show.armLasers(true,'operator'); load();
  show.engine.emit('lasers',frame());
  assert.equal(show.state.lasers.look,null);
  assert.ok(Object.values(show.state.lasers.fixtures).every(v=>v.mode==='off'));
  for (const role of ['guest','editor'] as const) assert.throws(()=>command({type:'followPatternLasers',patternId:show.state.patternId,revision:show.engine.patternRevision},role),/Not allowed/);
  assert.throws(()=>command({type:'followPatternLasers',patternId:show.state.patternId,revision:show.engine.patternRevision-1}),/revision/);
  follow(); show.engine.emit('lasers',frame());
  assert.equal(show.state.lasers.fixtures.l1.mode,'manual');
  load(plain); show.engine.emit('lasers',frame());
  assert.equal(show.state.lasers.fixtures.l1.mode,'off');
  assert.throws(follow,/lasers section/);
});

test('source edits, disarm, incoming patterns and manual takeover invalidate named and function Follow', (t) => {
  const {show,library,pattern,named,load,follow,frame} = setup(t);
  show.armLasers(true,'operator'); load(); follow(); const late = frame(); show.engine.emit('lasers',late);
  library.savePattern({id:pattern.id,source:pattern.source.replace('cyan','magenta')});
  assert.equal(show.state.lasers.fixtures.l1.mode,'off'); assert.equal(show.state.lasers.patternFollowing,false);
  show.engine.emit('lasers',late); assert.equal(show.state.lasers.fixtures.l1.mode,'off');
  show.patternUpdated(pattern.id); assert.throws(follow,/revision/);
  load(named); follow(); assert.equal(show.state.lasers.look,'breathe');
  show.lasersOff('operator'); show.armLasers(true,'operator');
  assert.equal(show.state.lasers.look,null); assert.ok(Object.values(show.state.lasers.fixtures).every(v=>v.mode==='off'));
  follow(); show.takeManualControl(['w1']);
  assert.equal(show.state.lasers.look,null); assert.equal(show.state.lasers.fixtures.l1.mode,'off');
  follow(); show.setLaser('l1',{mode:'manual',color:'red'});
  show.engine.emit('lasers',late); assert.equal(show.state.lasers.fixtures.l1.color,'red');
  show.stopLighting(); show.engine.emit('lasers',late); assert.equal(show.state.lasers.look,null); assert.equal(show.state.lasers.armed,false);
});

test('laser Follow, coordinated show and direct looks have one writer and Stop cannot be undone by queued work', (t) => {
  const {show,load,follow,frame,command} = setup(t);
  show.armLasers(true,'operator'); load(); follow(); show.engine.emit('lasers',frame());
  show.startCoordinatedShow({id:'neon-exchange',fixtureIds:['w1'],includeLasers:true});
  assert.equal(show.state.lasers.patternFollowing,false); assert.equal(show.state.lasers.fixtures.l1.color,'cyan');
  follow(); assert.equal(show.state.coordinatedShow?.includeLasers,false);
  show.setLaserLook('wide'); show.engine.emit('lasers',frame());
  assert.equal(show.state.lasers.look,'wide'); assert.equal(show.state.lasers.fixtures.l1.pan,80);
  const stale = show.state.generation; command({type:'stopLighting'},'guest');
  assert.throws(()=>command({type:'setLaserLook',lookId:'breathe'},'admin',stale),/Stale/);
  command({type:'lasersOff'},'guest',stale); assert.equal(show.state.lasers.armed,false);
});

test('legacy scenes and playlists reclaim ordinary scene output from manual holds without auto-following lasers', (t) => {
  const {show,library,plain,internal} = setup(t);
  const scene: Scene = {id:'old-scene',name:'Legacy',patternId:plain.id,params:{},master:1,bpm:60,speed:1,overrides:{},favorite:false,hotkey:null,swatch:[],createdAt:1,updatedAt:1};
  library.upsertScene(scene);
  library.upsertPlaylist({id:'old-playlist',name:'Legacy playlist',loop:false,shuffle:false,steps:[{id:'s',sceneId:scene.id,duration:4,unit:'bars'}],createdAt:1,updatedAt:1});
  show.setWash(['w1'],{mode:'music32',brightness:38}); show.playPlaylist('old-playlist');
  assert.equal(show.state.washes.w1.owner,'pattern');
  internal.publishFrame(new Float32Array(32).fill(1));
  assert.equal(show.engine.lastFrame!.values[6],1); assert.equal(show.state.playlist?.playlistId,'old-playlist');
  assert.equal(show.state.playlist!.stepEndsAt-show.state.playlist!.stepStartedAt,16000,'bars use the recalled scene tempo');
  assert.equal(show.state.lasers.patternFollowing,false);
});

test('master changes immediately refresh commanded brightness; temporary mute remains stale-safe', (t) => {
  const {show,ctx,command} = setup(t);
  show.setWash(['w1'],{mode:'music6',brightness:100});
  const generation=show.state.generation;
  show.setMaster(0.5);
  assert.equal(controlState(ctx).washes.w1.commandedBrightness,50);
  command({type:'setBlackout',blackout:true},'guest',generation);
  assert.equal(controlState(ctx).washes.w1.commandedBrightness,0);
  assert.throws(()=>command({type:'setBlackout',blackout:false},'guest',generation),/Stale/);
});

test('failed named pattern output revokes Follow rather than leaving its look timer running', (t) => {
  const {show,named,load,follow,frame} = setup(t);
  show.armLasers(true,'operator'); load(named); follow();
  assert.equal(show.state.lasers.look,'breathe');
  show.engine.emit('lasers',{...frame(),states:[]});
  assert.equal(show.state.lasers.patternFollowing,false); assert.equal(show.state.lasers.look,null);
  assert.ok(Object.values(show.state.lasers.fixtures).every(v=>v.mode==='off'));
});

test('diagnostic flash restores a held wash without orphaning coordinated-show ownership', async (t) => {
  const {show} = setup(t);
  show.startCoordinatedShow({id:'neon-exchange',fixtureIds:['w1']});
  const held = {...show.state.washes.w1};
  show.testFixture('w1',0.05);
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(show.state.coordinatedShow,null);
  assert.deepEqual(show.state.washes.w1,{...held,owner:'manual'});
});

test('commanded state follows final packing and output gates rather than staged laser or blocked wash intent', (t) => {
  const {show,ctx} = setup(t);
  show.setWash(['w1'],{mode:'music6',brightness:100});
  show.armLasers(true,'operator'); show.setLaser('l1',{mode:'manual',color:'cyan'});
  assert.equal(controlState(ctx).lasers.fixtures.l1.mode,'manual');
  const rig=ctx.rigFile.get();
  rig.protectedRanges.push({universe:0,from:101,to:112,reason:'test protected wash'});
  assert.equal(controlState(ctx).washes.w1.commandedBrightness,0);
  assert.equal(controlState(ctx).washes.w1.commandedMode,'off');
  show.state.released=true;
  assert.equal(controlState(ctx).lasers.fixtures.l1.mode,'off');
  assert.equal(controlState(ctx).lasers.fixtures.l1.requestedMode,'manual');
});

test('the output frame observes the current typed laser result, including Off on failure', (t) => {
  const {show,load,follow,frame,internal} = setup(t);
  show.armLasers(true,'operator'); load(); follow(); show.engine.emit('lasers',frame());
  const observed: string[]=[];
  show.engine.once('frame',()=>observed.push(show.state.lasers.fixtures.l1.mode));
  internal.onWorkerMessage({type:'frame',buf:new Float32Array(32),errorA:'render failed',errorB:null,renderMs:0,logs:[],lasers:[],revision:show.engine.patternRevision,generation:show.engine.patternGeneration});
  assert.equal(observed[0],'off','the same output frame must see Off, without one stale laser frame');
});

test('shared laser writers refuse muted or released Starts atomically and drafts cannot restart', (t) => {
  const {show,command,load,follow} = setup(t);
  for (const gate of ['blackout','released'] as const) {
    for (const write of [
      () => show.setLaser('l1',{mode:'manual',color:'cyan'}),
      () => show.setLaserLook('breathe'),
      () => show.quickLook('laser-duo'),
      () => show.startCoordinatedShow({id:'neon-exchange',fixtureIds:['w1'],includeLasers:true}),
      () => show.followPatternLasers(show.state.patternId ?? '', show.engine.patternRevision),
    ]) {
      show.stopLighting(); load();
      if (gate==='blackout') show.setBlackout(true); else show.setReleased(true);
      show.armLasers(true,'operator');
      const before=JSON.stringify(show.state);
      assert.throws(write,/mute|release/i);
      assert.equal(JSON.stringify(show.state),before,'rejection cannot mutate washes, presets, ownership or generation');
      show.setLaser('l1',{pan:70});
      assert.equal(show.state.lasers.fixtures.l1.mode,'off');
      command(gate==='blackout'?{type:'setBlackout',blackout:false}:{type:'setReleased',released:false});
      assert.equal(show.state.lasers.armed,false);
      assert.equal(show.state.lasers.look,null);
      assert.ok(Object.values(show.state.lasers.fixtures).every(v=>v.mode==='off'));
      show.setBlackout(false);
    }
  }
});


test('actual WS handler refuses gated laser Starts and guests cannot restore laser intent on unmute', (t) => {
  const {show,ctx}=setup(t);
  const replies:any[]=[];
  const hub=Object.assign(Object.create(WsHub.prototype),{ctx,clients:new Map()}) as any;
  const client={role:'guest',name:'test',ws:{readyState:1,send:(text:string)=>replies.push(JSON.parse(text))}};
  const ws=(cmd:object,role='guest')=>{client.role=role;hub.onMessage(client,JSON.stringify({...cmd,reqId:'test',generation:show.state.generation}));return replies.at(-1);};
  ws({type:'setBlackout',blackout:true});ws({type:'armLasers',armed:true},'admin');
  for(const cmd of [{type:'setLaser',fixtureId:'l1',state:{mode:'manual'}},{type:'setLaserLook',lookId:'breathe'},{type:'quickLook',lookId:'laser-duo'},{type:'startCoordinatedShow',params:{id:'neon-exchange',fixtureIds:['w1'],includeLasers:true}}]) {
    const before=JSON.stringify(show.state);
    assert.match(ws(cmd,'admin').text,/mute|release/);assert.equal(JSON.stringify(show.state),before);
    assert.match(ws(cmd).text,/Not allowed/);assert.equal(JSON.stringify(show.state),before);
  }
  assert.equal(ws({type:'setBlackout',blackout:false}).type,'ack');
  assert.equal(show.state.lasers.armed,false);assert.equal(show.state.lasers.look,null);
});
