import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

// Each child freezes its policy at module load. No sockets, server or provider are created:
// settings disable transports, and final packets are observed only through an in-memory sink.
test('haze process gates cannot override preview/whole output veto; commissioned timed runs still use guarded bytes', () => {
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import os from 'node:os';
    import path from 'node:path';
    const root=process.env.HAZE_TEST_ROOT;
    const {config}=await import(root+'/server/src/config.ts');
    const {defaultRig,defaultSettings}=await import(root+'/server/src/defaults.ts');
    const {Library}=await import(root+'/server/src/library.ts');
    const {ShowController}=await import(root+'/server/src/show.ts');
    const {OutputManager}=await import(root+'/server/src/output/output.ts');
    const {HAZE_VETO}=await import(root+'/server/src/output/policy.ts');
    const {dispatchControl}=await import(root+'/server/src/api/commands.ts');
    config.dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'haze-policy-'));
    fs.mkdirSync(path.join(config.dataDir,'patterns'));
    const rig=defaultRig(),settings=defaultSettings(),library=new Library();
    rig.fixtures.find(f=>f.id==='h1').enabled=true;
    rig.protectedRanges=[]; // Deliberate future test fixture; no saved protections are migrated away.
    settings.artnet.enabled=false;settings.hue.enabled=false;
    const show=new ShowController(library,()=>rig,()=>settings);
    const output=new OutputManager(show.engine,settings,rig,()=>show.state);
    const ctx={show,rigFile:{get:()=>rig},settingsFile:{get:()=>settings}};
    let bytes=[];output.onDmx=(_u,b)=>{bytes=Array.from(b.slice(50,52));};
    show.engine.setRig(rig);
    const frozen=HAZE_VETO;
    process.env.LIGHTESOTA_HAZE_COMMISSIONED=frozen?'1':'0';
    assert.equal(HAZE_VETO,frozen,'policy is fixed for the process');
    try {
      if (HAZE_VETO) {
        assert.throws(()=>show.setHaze({armed:true,runSec:30},'test'),/commission|preview/i);
        Object.assign(show.state.haze,{armed:true,fan:1,output:1,runUntil:Date.now()+30000});
        show.state.stopped=false;show.engine.refresh();
        assert.deepEqual(bytes,[0,0]);
      } else {
        assert.throws(()=>show.setHaze({runSec:30},'test'),/Arm/);
        for(const bad of [{armed:true,fan:NaN},{armed:true,output:2},{armed:true,runSec:1201},{armed:'yes'},{armed:false,runSec:30}]) {
          const before=JSON.stringify(show.state);assert.throws(()=>show.setHaze(bad,'test'));assert.equal(JSON.stringify(show.state),before);
        }
        for(const gate of ['blackout','released']) {
          show.state[gate]=true;const before=JSON.stringify(show.state);
          assert.throws(()=>show.setHaze({armed:true,runSec:30},'test'),/mute|release/);
          assert.equal(JSON.stringify(show.state),before);show.state[gate]=false;
        }
        rig.protectedRanges=[{universe:0,from:51,to:52,reason:'explicit protection'}];
        assert.throws(()=>show.setHaze({armed:true},'test'),/unprotected/);
        rig.protectedRanges=[];output.apply(settings,rig);
        show.setHaze({armed:true,fan:0.6,output:0.4},'test');assert.deepEqual(bytes,[0,0]);
        show.setHaze({runSec:30},'test');assert.deepEqual(bytes,[153,102]);
        const stale=show.state.generation;
        show.setBlackout(true);show.setBlackout(false);assert.deepEqual(bytes,[0,0]);
        assert.throws(()=>dispatchControl(ctx,{type:'setHaze',armed:true,runSec:30},{role:'admin',name:'test'},stale),/Stale/);
        show.setHaze({armed:true,runSec:30},'test');
        const realNow=Date.now;const expiry=show.state.haze.runUntil;
        Date.now=()=>expiry+1;try{show.hazeTick();}finally{Date.now=realNow;}
        assert.equal(show.state.haze.runUntil,null);assert.equal(show.state.haze.armed,false);assert.deepEqual(bytes,[0,0]);
        show.setHaze({armed:true,runSec:30},'test');
        show.file.set(show.state);show.file.flush();
        const restarted=new ShowController(library,()=>rig,()=>settings);
        assert.equal(restarted.state.haze.armed,false);assert.equal(restarted.state.haze.runUntil,null);restarted.stop();
      }
    } finally {show.stop();await output.blackoutAndClose();library.flush();}
    console.log('fake haze gates and bytes pass');
  `;
  for(const [preview,whole,haze] of [['0','0','0'],['0','1','0'],['1','1','1'],['0','0','1'],['0','1','1']]) {
    const stdout=execFileSync(process.execPath,['--import','tsx','--input-type=module','-e',script],{
      cwd:process.cwd(),encoding:'utf8',env:{...process.env,HAZE_TEST_ROOT:new URL('../../../',import.meta.url).pathname.replace(/\/$/,''),LIGHTESOTA_PREVIEW:preview,LIGHTESOTA_OUTPUT_COMMISSIONED:whole,LIGHTESOTA_HAZE_COMMISSIONED:haze},
    });
    assert.match(stdout,/fake haze gates and bytes pass/);
  }
});
