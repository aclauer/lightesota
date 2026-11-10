import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentService } from "./agent.js";
import type { AgentHost } from "./tools.js";
import { Library } from "../library.js";
import { ShowController } from "../show.js";
import { defaultRig, defaultSettings } from "../defaults.js";
import { config } from "../config.js";
import type { AgentEvent } from "../../../shared/src/index.js";
import { WsHub } from "../api/ws.js";

const owner = { deviceId: "device-alice", name: "Alice" };
const context = { owner, by: owner.name, role: "editor" as const };
const model = "deepseek/deepseek-v4.1-flash-1017";
function fixture(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lt-agent-"));
  config.dataDir = dir;
  fs.mkdirSync(path.join(dir, "patterns")); fs.mkdirSync(path.join(dir, "agent"));
  const library = new Library(); library.load();
  const rig = defaultRig(), settings = defaultSettings();
  settings.agent = { ...settings.agent, provider: "hermes", model, effort: "max" };
  const show = new ShowController(library, () => rig, () => settings);
  const engine = show.engine as unknown as { ensureWorker(): void; post(message: unknown): void };
  t.mock.method(engine, "ensureWorker", () => {}); t.mock.method(engine, "post", () => {});
  show.engine.setRig(rig);
  t.after(() => { show.stop(); library.flush(); fs.rmSync(dir, { recursive: true, force: true }); });
  const host: AgentHost = { library, show, getRig: () => rig, getSettings: () => settings, onPatternSaved: () => {} };
  const events: {event: AgentEvent; id: string | null; owner?: string}[] = [];
  // WebSockets serialize immediately; references would conceal missing final tool fields.
  const broadcast = (event: AgentEvent, id: string | null, owner?: string) => events.push({event:structuredClone(event), id, owner});
  return { dir, host, settings, show, events, broadcast };
}
const sse = (delta: object, finish: string) => new Response([
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`,
  "data: [DONE]\n\n",
].join(""), { headers: {"content-type": "text/event-stream"} });
const call = (name: string, input: unknown) => ({ tool_calls: [{index: 0, id: "tool-one", type: "function", function: {name, arguments: JSON.stringify(input)}}] });

test("Hermes streams text, runs existing tools, echoes hidden thinking in the result round and pins request", async (t) => {
  const f = fixture(t), requests: any[] = [];
  const transport: typeof fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return requests.length === 1
      ? sse({content: "Checking the show. ", reasoning_content: "private reasoning sentinel", ...call("get_show_state", {})}, "tool_calls")
      : sse({content: "Lighting is stopped."}, "stop");
  };
  const agent = new AgentService(f.host, f.broadcast, { hermes: { fetch: transport } });
  const id = await agent.send(null, "What is active?", context);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.model, model); assert.equal(request.max_tokens, 32000);
    assert.equal(request.reasoning_effort, "max"); assert.deepEqual(request.thinking, {type:"enabled"});
    assert.ok(request.tools.every((x: any) => x.type === "function"));
  }
  assert.ok(requests[1].messages.some((m: any) => m.reasoning_content === "private reasoning sentinel"));
  assert.ok(requests[1].messages.some((m: any) => m.role === "tool" && m.tool_call_id === "tool-one" && JSON.parse(m.content).stopped));
  const pub = agent.open(id)!;
  assert.equal(pub.messages.at(-1)?.text, "Lighting is stopped.");
  assert.ok(f.events.some(x => x.event.type === "toolEnd"));
  assert.ok(f.events.some(x => x.event.type === "message" && x.event.message.toolCalls[0]?.name === "get_show_state" && x.event.message.toolCalls[0]?.result));
  assert.ok(f.events.every(x => x.owner === owner.deviceId));
  assert.ok(!JSON.stringify(f.events).includes("private reasoning sentinel"));
  assert.ok(!fs.readFileSync(path.join(f.dir, "agent", `${id}.json`), "utf8").includes("private reasoning sentinel"));
});

test("cancel and durable Stop defeat a late completed model tool without renewing authority", async (t) => {
  for (const stop of [false, true]) {
    const f = fixture(t);
    let finish!: (response: Response) => void;
    const transport: typeof fetch = async () => new Promise<Response>(resolve => { finish = resolve; });
    const agent = new AgentService(f.host, f.broadcast, { hermes: {fetch: transport} });
    const conv = agent.create(owner);
    const sending = agent.send(conv.id, "Set master", context);
    await new Promise(resolve => setImmediate(resolve));
    if (stop) f.show.stopLighting(); else agent.cancel(conv.id);
    const before = structuredClone(f.show.state);
    finish(sse(call("set_master", {level: 0.88}), "tool_calls"));
    await sending;
    assert.deepEqual(f.show.state, before);
    assert.equal(agent.open(conv.id)?.messages.at(-1)?.streaming, false);
  }
});

test("durable Stop aborts inference even when an output frame subscriber throws", async (t) => {
  const f = fixture(t);
  let signal: AbortSignal | undefined;
  let finish!: (response: Response) => void;
  const agent = new AgentService(f.host, f.broadcast, {hermes: {fetch: async (_url, init) => {
    signal = init?.signal as AbortSignal;
    return new Promise<Response>(resolve => { finish = resolve; });
  }}});
  const sending = agent.send(null, "Check the show", context);
  await new Promise(resolve => setImmediate(resolve));
  const broken = () => { throw new Error("output subscriber failed"); };
  f.show.engine.on("frame", broken);
  try {
    assert.throws(() => f.show.stopLighting(), /output subscriber failed/);
    assert.equal(signal?.aborted, true);
  } finally {
    f.show.engine.off("frame", broken);
    agent.cancelAll();
    finish(sse({content: "Late response"}, "stop"));
    await sending;
  }
});

test("one inference turn keeps its original generation across multiple provider rounds", async (t) => {
  const f = fixture(t); let count = 0;
  const transport: typeof fetch = async () => {
    count++;
    return count <= 2 ? sse(call("set_master", {level: count === 1 ? 0.4 : 0.9}), "tool_calls") : sse({content:"Done"}, "stop");
  };
  const agent = new AgentService(f.host, f.broadcast, {hermes:{fetch:transport}});
  const id = await agent.send(null, "Adjust twice", context);
  assert.equal(count, 3); assert.equal(f.show.state.master, 0.4);
  assert.match(agent.open(id)!.messages[2].toolCalls[0].result!, /Stale/);
});

test("browser conversation context cannot supply the internal Giskard capability", async t => {
  const f = fixture(t); let round = 0;
  f.show.quickLook("calm-blue", ["w1"]); f.show.armLasers(true, "Operator");
  const agent = new AgentService(f.host, f.broadcast, { hermes: { fetch: async () => ++round === 1
    ? sse(call("set_lasers", { look: "tight", lasers: null }), "tool_calls") : sse({ content: "Refused." }, "stop") } });
  const untrustedContext = { ...context, role: "guest" as const, giskard: { generation: f.show.state.generation } };
  const id = await agent.send(null, "Use lasers", untrustedContext);
  assert.equal(agent.open(id)!.messages[1].toolCalls[0].isError, true);
  assert.match(agent.open(id)!.messages[1].toolCalls[0].result!, /admin/);
  assert.equal(f.show.state.lasers.look, null);
  assert.ok(Object.values(f.show.state.lasers.fixtures).every(l => l.mode === "off"));
});

test("provider errors have no fallback or secret body leakage, and a tool loop stops at twelve rounds", async (t) => {
  const f = fixture(t); let count = 0;
  const agent = new AgentService(f.host, f.broadcast, {hermes:{fetch:async () => {count++; return sse(call("get_show_state", {}), "tool_calls");}}});
  const id = await agent.send(null, "Keep reading", context);
  assert.equal(count, 12); assert.match(agent.open(id)!.messages.at(-1)!.error!, /limit|12/);
  let failures = 0;
  const failing = new AgentService(f.host, f.broadcast, {hermes:{fetch:async () => {failures++; return new Response("sensitive upstream body", {status:401});}}});
  const failedId = await failing.send(null, "Test failure", context);
  assert.equal(failures, 1);
  assert.ok(!JSON.stringify(failing.open(failedId)).includes("sensitive upstream body"));
  assert.ok(failing.open(failedId)?.messages.at(-1)?.error);
});

test("legacy private history stays intact; Hermes and explicit rollback use recent text without replaying old tools", async (t) => {
  const f = fixture(t), requests: any[] = [];
  const history = [{role:"assistant",content:[{type:"thinking",thinking:"legacy private",signature:"signature"},{type:"tool_use",id:"old-tool",name:"set_master",input:{level:1}}]}];
  const stored = {id:"legacy",title:"Existing",ownerDeviceId:owner.deviceId,ownerName:owner.name,createdAt:1,updatedAt:2,
    messages:[{id:"m1",role:"user",text:"Old request",toolCalls:[],createdAt:1},{id:"m2",role:"assistant",text:"Old answer",toolCalls:[],createdAt:2}],history};
  fs.writeFileSync(path.join(f.dir,"agent","legacy.json"),JSON.stringify(stored));
  const agent = new AgentService(f.host,f.broadcast,{hermes:{fetch:async (_url,init) => {requests.push(JSON.parse(String(init?.body))); return sse({content:"Recent Hermes answer"},"stop");}},
    anthropic:async request => {requests.push(request); request.onText("Rollback answer"); return {content:[{type:"text",text:"Rollback answer",citations:null}],stop_reason:"end_turn"};}});
  await agent.send("legacy","New request",context);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,"agent","legacy.json"),"utf8")).history,history);
  assert.ok(!JSON.stringify(requests[0]).includes("legacy private"));
  assert.ok(!JSON.stringify(requests[0]).includes("old-tool"));
  f.settings.agent.provider="anthropic"; f.settings.agent.model="claude-opus-4-8";
  await agent.send("legacy","Rollback request",context);
  assert.ok(JSON.stringify(requests[1].messages).includes("Recent Hermes answer"));
  assert.ok(!JSON.stringify(requests[1].messages).includes("old-tool"));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.dir,"agent","legacy.json"),"utf8")).history[0],history[0]);
  assert.ok(!JSON.stringify(agent.open("legacy")).includes("legacy private"));
  assert.deepEqual(agent.list("device-bob"),[]);
  assert.equal(agent.list("device-bob",true).length,1);
  await assert.rejects(agent.send("legacy","Unauthorized",{...context,owner:{deviceId:"device-bob",name:"Bob"}}),/belongs/);
});

test("preview has no production provider transport even when configuration exists", async (t) => {
  const f = fixture(t), agent = new AgentService(f.host, f.broadcast);
  assert.equal(agent.hasCredentials(),false);
  await assert.rejects(agent.send(null,"No provider requests",context),/preview/);
  assert.equal(agent.list(owner.deviceId).length,0);
});

test("WebSocket conversation checks and serialized events isolate owners and explicitly viewing admins", (t) => {
  const f=fixture(t), agent=new AgentService(f.host,f.broadcast);
  const conv=agent.create(owner);
  const received=new Map<string,any[]>();
  const client=(id:string,deviceId:string,role:"editor"|"admin") => {
    const messages:any[]=[]; received.set(id,messages);
    return {id,deviceId,role,name:id,openConv:null,listAll:false,ws:{readyState:1,send:(data:string)=>messages.push(JSON.parse(data))}};
  };
  const alice=client("alice",owner.deviceId,"editor"),bob=client("bob","device-bob","editor");
  const admin=client("admin","device-admin","admin"),idleAdmin=client("idle-admin","device-idle","admin");
  // Invoke production routing over fake clients; no server, WebSocket or network is started.
  const hub=Object.assign(Object.create(WsHub.prototype),{ctx:{agent,settingsFile:{get:()=>f.settings}},clients:new Map([alice,bob,admin,idleAdmin].map(c=>[c.id,c]))});
  assert.throws(()=>hub.handleAgent(bob,{type:"open",conversationId:conv.id}),/belongs/);
  hub.handleAgent(admin,{type:"open",conversationId:conv.id});
  received.get("admin")!.length=0;
  hub.agentEvent({type:"delta",conversationId:conv.id,messageId:"test",text:"private to owner"},conv.id,owner.deviceId);
  assert.equal(received.get("alice")!.length,1); assert.equal(received.get("admin")!.length,1);
  assert.equal(received.get("bob")!.length,0); assert.equal(received.get("idle-admin")!.length,0);
  hub.handleAgent(bob,{type:"list",all:true});
  assert.deepEqual(received.get("bob")![0].event.conversations,[]);
});

test("invalid Hermes model/effort fail before transport; errors never invoke the rollback provider",async(t)=>{
  const f=fixture(t); let hermes=0,anthropic=0;
  const agent=new AgentService(f.host,f.broadcast,{hermes:{fetch:async()=>{hermes++;throw new Error("private connection detail");}},anthropic:async()=>{anthropic++;return {content:[],stop_reason:"end_turn"};}});
  f.settings.agent.effort="high";
  await assert.rejects(agent.send(null,"Weak effort",context),/max reasoning/);
  f.settings.agent.effort="max"; f.settings.agent.model="deepseek/other";
  await assert.rejects(agent.send(null,"Wrong model",context),/max reasoning/);
  assert.equal(hermes,0);assert.equal(anthropic,0);
  f.settings.agent.model=model;
  const id=await agent.send(null,"Network failure",context);
  assert.equal(hermes,1);assert.equal(anthropic,0);
  assert.ok(!JSON.stringify(agent.open(id)).includes("private connection detail"));
});
