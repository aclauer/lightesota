import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

test("Hue v1/v2 writes and discovery are aborted across Stop; fresh gradient output retains TLS and v2 auth", () => {
  // Freeze a commissioned policy in a child, with HTTPS replaced before Hue is imported.
  // No server, UDP socket or real HTTPS request is created. The hardware veto is inherited.
  const script = `
    import assert from 'node:assert/strict';
    import https from 'node:https';
    import {EventEmitter} from 'node:events';
    const requests=[];
    https.request=(options,callback)=>{
      const req=new EventEmitter();
      const captured={options,callback,req,body:'',aborted:false};requests.push(captured);
      req.write=(data)=>{captured.body+=data;};req.end=()=>{};
      req.destroy=(error)=>{captured.aborted=true;queueMicrotask(()=>req.emit('error',error));};
      options.signal?.addEventListener('abort',()=>req.destroy(new Error('mock request aborted')),{once:true});
      return req;
    };
    const {HueBridge}=await import(process.env.HUE_TEST_ROOT+'/server/src/output/hue.ts');
    const tick=()=>new Promise(resolve=>setImmediate(resolve));
    const make=()=>{const hue=new HueBridge('invalid.example','fake-test-only',8);hue.ensureLoop=()=>{};return hue;};
    const respond=(request,body)=>{
      const res=new EventEmitter();res.socket={getPeerCertificate:()=>({subject:{CN:'test-bridge'}})};res.statusCode=200;
      request.callback(res);res.emit('data',Buffer.from(JSON.stringify(body)));res.emit('end');
    };
    for(const kind of ['color','gradient-discovery','bridge-discovery','gradient-write']){
      const hue=make();if(kind!=='bridge-discovery')hue.bridgeId='test-bridge';
      if(kind==='gradient-write')hue.v2=new Map([['1',{rid:'gradient-rid',points:3}]]);
      if(kind==='color')hue.setColor('1',1,0,0,0.5);else hue.setGradient('1',[[1,0,0],[0,0,1]],0.5);
      const begin=requests.length,pending=hue.flushOne();await tick();
      const request=requests[begin];assert.ok(request,kind);
      assert.ok(request.options.signal instanceof AbortSignal,kind+' needs request cancellation');
      assert.match(request.options.ca,/BEGIN CERTIFICATE/);
      assert.equal(request.options.rejectUnauthorized,undefined,'TLS verification keeps the secure default');
      if(kind!=='bridge-discovery')assert.match(request.options.checkServerIdentity('',{subject:{CN:'wrong-bridge'}}).message,/expected test-bridge/);
      hue.cancelPending();assert.equal(request.options.signal.aborted,true);await pending;
      assert.equal(request.aborted,true);assert.equal(hue.lastSent.size,0);assert.equal(hue.connected,false);
      respond(request,kind==='bridge-discovery'?{bridgeid:'test-bridge'}:{data:[{id:'gradient-rid',id_v1:'/lights/1',gradient:{points_capable:3}}]});
      await tick();assert.equal(requests.length,begin+1,'late discovery must not issue a stale write');
      hue.stop();
    }
    const hue=make();hue.bridgeId='test-bridge';hue.v2=new Map([['1',{rid:'gradient-rid',points:3}]]);
    hue.setGradient('1',[[1,0,0],[0,0,1]],0.5);
    let pending=hue.flushOne();await tick();let request=requests.at(-1),body=JSON.parse(request.body);
    assert.equal(request.options.path,'/clip/v2/resource/light/gradient-rid');
    assert.equal(request.options.headers['hue-application-key'],'fake-test-only');
    assert.equal(body.gradient.points.length,3);assert.equal(body.dimming.brightness,50);
    respond(request,{data:[]});await pending;assert.equal(hue.connected,true);assert.equal(hue.lastSent.size,1);
    hue.cancelPending();hue.setGradient('1',[[1,0,0],[0,0,1]],0);
    pending=hue.flushOne();await tick();request=requests.at(-1);body=JSON.parse(request.body);
    assert.deepEqual(body,{on:{on:false},dynamics:{duration:100}});
    respond(request,{data:[]});await pending;hue.stop();
    console.log('mock Hue cancellation and gradient transport pass');
  `;
  const stdout = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), encoding: "utf8",
    env: { ...process.env, HUE_TEST_ROOT: new URL("../../../", import.meta.url).pathname.replace(/\/$/, ""), LIGHTESOTA_PREVIEW: "0", LIGHTESOTA_OUTPUT_COMMISSIONED: "1", LIGHTESOTA_HAZE_COMMISSIONED: "0" },
  });
  assert.match(stdout, /mock Hue cancellation and gradient transport pass/);
});
