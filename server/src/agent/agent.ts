import { PREVIEW, HAZE_COMMISSIONED } from "../output/policy.js";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import { HERMES_MODEL, type AgentChatMessage, type AgentConversation, type AgentEvent, type AgentToolCall, type AgentProviderStatus, type Role } from "../../../shared/src/index.js";
import { config } from "../config.js";
import { dynamicSystem, STATIC_SYSTEM } from "./prompt.js";
import { createTurnToolRunner, TOOL_DEFS, GISKARD_TOOL_DEFS, type AgentHost, type GiskardTurn } from "./tools.js";
import { streamChatCompletion, validateBaseUrl, ProviderError, type OpenAIMessage } from "./openai.js";

interface StoredConversation extends AgentConversation {
  /** Legacy Anthropic blocks stay private and are never rewritten for another provider. */
  history: Anthropic.Beta.Messages.BetaMessageParam[];
}
interface AnthropicRequest {
  tools: typeof TOOL_DEFS;
  system: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  messages: Anthropic.Beta.Messages.BetaMessageParam[];
  signal: AbortSignal;
  onText: (text: string) => void;
  onToolStart: (index: number, id: string, name: string) => void;
  onToolDelta: (index: number, partial: string) => void;
}
type AnthropicReply = Pick<Anthropic.Beta.Messages.BetaMessage, "content" | "stop_reason">;
interface AgentTestTransports {
  /** Pure in-process fake transports for offline tests; never populated by runtime config. */
  hermes?: { fetch: typeof fetch };
  anthropic?: (request: AnthropicRequest) => Promise<AnthropicReply>;
  now?: () => number;
}
type RequestStatus = "accepted" | "running" | "completed" | "failed" | "cancelled" | "expired";
interface LightingRequest {
  id: string; owner: string; status: RequestStatus; until: number; retainUntil: number;
  abort: AbortController; summary: string; tools: string[];
}

/** Bounded lighting agent. Providers have no capabilities beyond the existing tool definitions. */
export class AgentService {
  private client: Anthropic | null = null;
  private running = new Map<string, AbortController>();
  private dir = path.join(config.dataDir, "agent");
  private lastStatus: AgentProviderStatus | undefined;
  private lightingRequests = new Map<string, LightingRequest>();
  private activeLightingRequest: LightingRequest | undefined;
  private now = () => this.testTransports.now ? this.testTransports.now() : performance.now();

  constructor(private host: AgentHost, private broadcast: (ev: AgentEvent, conversationId: string | null, ownerDeviceId: string | undefined) => void, private testTransports: AgentTestTransports = {}) {
    host.show.on("lightingStopped", () => this.cancelAll());
  }

  status(): AgentProviderStatus {
    const settings = this.host.getSettings().agent;
    const provider = settings.provider;
    const model = provider === "hermes" ? HERMES_MODEL : settings.model;
    const base = {provider, model, reasoning: provider === "hermes" ? "max (thinking enabled)" : `${settings.effort} (adaptive thinking)`};
    if (PREVIEW) return {...base, state:"preview", message:"Preview blocks provider requests and physical output."};
    if (provider === "hermes") {
      try { validateBaseUrl(process.env.LIGHTESOTA_HERMES_BASE_URL ?? "http://127.0.0.1:8645/v1"); }
      catch { return {...base, state:"missing", message:"Set LIGHTESOTA_HERMES_BASE_URL to a loopback HTTP or trusted HTTPS subscription proxy."}; }
    } else if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      return {...base, state:"missing", message:"Explicit Anthropic rollback needs ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN on the server."};
    }
    if (this.lastStatus?.provider === provider && this.lastStatus.model === model && this.lastStatus.reasoning === base.reasoning) return {...this.lastStatus};
    return {...base, state:"configured", message:provider === "hermes" ? "Hermes endpoint configured; connectivity and company subscription have not been tested. Start the separate Nous subscription proxy." : "Anthropic credentials configured; connectivity has not been tested."};
  }

  /** Compatibility boolean only; the UI uses status() and never treats this as connectivity. */
  hasCredentials(): boolean { return !["missing", "preview"].includes(this.status().state); }

  private async anthropic(request: AnthropicRequest): Promise<AnthropicReply> {
    if (this.testTransports.anthropic) return this.testTransports.anthropic(request);
    if (PREVIEW) throw new Error("Agent provider connections are disabled in preview");
    if (!this.client) this.client = new Anthropic({ maxRetries: 0, timeout: 600_000 });
    const stream = this.client.beta.messages.stream({
      model: request.model,
      max_tokens: 32000,
      betas: ["thinking-binding-controls-2026-08-01"],
      thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } } as unknown as Anthropic.Beta.Messages.BetaThinkingConfigParam,
      output_config: { effort: request.effort },
      system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
      tools: request.tools,
      messages: request.messages,
    }, { signal: request.signal });
    stream.on("text", request.onText);
    stream.on("streamEvent", ev => {
      if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") request.onToolStart(ev.index, ev.content_block.id, ev.content_block.name);
      else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") request.onToolDelta(ev.index, ev.delta.partial_json);
    });
    return stream.finalMessage();
  }

  // ---- storage ----
  list(deviceId: string, all = false) {
    const out: { id: string; title: string; updatedAt: number; ownerName?: string; mine: boolean }[] = [];
    for (const f of fs.readdirSync(this.dir).filter(f => f.endsWith(".json"))) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as StoredConversation;
        const mine = c.ownerDeviceId === deviceId;
        if (mine || all) out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, ownerName: c.ownerName, mine });
      } catch { /* skip unreadable conversations */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  ownerOf(id: string): string | undefined { return this.load(id)?.ownerDeviceId; }
  private file(id: string) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("Invalid conversation id");
    return path.join(this.dir, `${id}.json`);
  }
  private load(id: string): StoredConversation | null {
    const file = this.file(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, "utf8")) as StoredConversation;
  }
  private save(c: StoredConversation) {
    c.updatedAt = Date.now();
    fs.writeFileSync(this.file(c.id), JSON.stringify(c));
  }
  delete(id: string) { this.cancel(id); fs.rmSync(this.file(id), { force: true }); }
  create(owner?: { deviceId: string; name: string }): StoredConversation {
    const c: StoredConversation = { id: nanoid(10), title: "New conversation", ownerDeviceId: owner?.deviceId, ownerName: owner?.name, messages: [], history: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.save(c); return c;
  }
  private publicConversation(c: StoredConversation): AgentConversation {
    return {id:c.id,title:c.title,ownerDeviceId:c.ownerDeviceId,ownerName:c.ownerName,messages:c.messages,createdAt:c.createdAt,updatedAt:c.updatedAt};
  }
  open(id: string): AgentConversation | null { const c = this.load(id); return c ? this.publicConversation(c) : null; }
  cancel(id: string) { this.running.get(id)?.abort(); }
  cancelAll() {
    const job = this.activeLightingRequest;
    if (job && ["accepted", "running"].includes(job.status)) { job.status = "cancelled"; job.abort.abort(); }
    for (const abort of this.running.values()) abort.abort();
  }

  /** One volatile request, no queue or restart recovery. Its pre-inference lease is never renewed. */
  requestLighting(prompt: string, owner: string, generation: number, remainingMs: number) {
    if (HAZE_COMMISSIONED) throw new Error("Giskard requests require haze disabled at process start");
    if (this.activeLightingRequest) throw new Error("A lighting request is already running");
    if (!prompt.trim() || Buffer.byteLength(prompt) > 4096 || !Number.isFinite(remainingMs) || remainingMs <= 0 || remainingMs > 120000) throw new Error("Invalid lighting request");
    this.host.show.assertGeneration(generation);
    const now = this.now();
    for (const [id, job] of this.lightingRequests) if (now >= job.retainUntil) this.lightingRequests.delete(id);
    if (this.lightingRequests.size >= 64) throw new Error("Lighting request status capacity reached");
    const job: LightingRequest = { id: nanoid(24), owner, status: "accepted", until: now + remainingMs,
      retainUntil: now + remainingMs + 300000, abort: new AbortController(), summary: "", tools: [] };
    this.lightingRequests.set(job.id, job); this.activeLightingRequest = job;
    const assertLive = () => {
      if (this.now() >= job.until) { job.status = "expired"; job.abort.abort(); }
      job.abort.signal.throwIfAborted();
    };
    const timer = setTimeout(() => { job.status = "expired"; job.abort.abort(); }, remainingMs); timer.unref();
    // Admission returns before any inference. The signal/deadline still guards this queued start.
    void Promise.resolve().then(async () => {
      assertLive(); job.status = "running";
      const id = await this.send(null, prompt, { role: "guest", by: "Giskard", owner: { deviceId: `giskard-${owner}`, name: "Giskard" } },
        { generation, assertLive, signal: job.abort.signal, progress: name => { if (job.tools.length < 32) job.tools.push(name); } });
      assertLive();
      const messages = this.open(id)?.messages;
      job.status = !messages || messages.some(m => m.error || m.toolCalls.some(t => t.isError)) ? "failed" : "completed";
      job.summary = job.status === "completed" ? (messages!.at(-1)?.text ?? "").slice(0, 2000) : "Request did not complete cleanly; earlier effects may remain. Read current state before a fresh request.";
    }).catch(() => {
      if (!job.abort.signal.aborted) job.status = "failed";
      job.summary = "Request ended without confirmed completion; earlier effects may remain. Never resubmit this request.";
    }).finally(() => { clearTimeout(timer); this.activeLightingRequest = undefined; });
    return this.lightingRequestStatus(owner, job.id);
  }

  lightingRequestStatus(owner: string, id?: string) {
    const job = id ? this.lightingRequests.get(id) : [...this.lightingRequests.values()].reverse().find(j => j.owner === owner);
    if (!job || job.owner !== owner || this.now() >= job.retainUntil) return { status: "unknown" as const };
    if (["accepted", "running"].includes(job.status) && this.now() >= job.until) { job.status = "expired"; job.abort.abort(); }
    return { id: job.id, status: job.status, summary: job.summary, tools: [...job.tools], remainingMs: Math.max(0, Math.floor(job.until - this.now())), physicalOutput: "unverified" as const };
  }

  async send(conversationId: string | null, text: string, context?: { patternId?: string | null; by?: string; owner?: { deviceId: string; name: string }; role?: Role },
    giskard?: GiskardTurn & { signal: AbortSignal; progress(name: string): void }) {
    const settings = {...this.host.getSettings().agent};
    if (settings.provider !== "hermes" && settings.provider !== "anthropic") throw new Error("Choose a supported agent provider in Settings.");
    const injected = settings.provider === "hermes" ? !!this.testTransports.hermes : !!this.testTransports.anthropic;
    if (PREVIEW && !injected) throw new Error("Agent provider connections are disabled in preview");
    if (settings.provider === "hermes" && (settings.model !== HERMES_MODEL || settings.effort !== "max")) throw new Error("Hermes requires deepseek/deepseek-v4.1-flash-1017 with max reasoning.");
    if (!injected && !this.hasCredentials()) throw new Error(this.status().message);
    // Capture exactly once, before any inference. Retries/rounds never renew authority.
    const runTurnTool = createTurnToolRunner(this.host, {role:context?.role ?? "viewer",by:context?.by ?? ""}, giskard);
    runTurnTool.assertActive();
    const tools = giskard ? GISKARD_TOOL_DEFS : TOOL_DEFS;
    const system = STATIC_SYSTEM + (giskard ? "\nThis is a fresh authorized Giskard lighting request. Use only the supplied remote capabilities. Pattern saves always create new copies: use the returned ID. apply_pattern is an explicit whole-rig ordinary Start (also releases manual wash/Hue overrides and solo selection), never blackout/release or laser Follow. Existing master remains; inspect state before changing it. Typed laser presets require prior manual arming. Haze is disabled. Report tool errors or incomplete work honestly, and never claim physical verification. Authority expires with the original Slack lease; do not retry stale work." : "");
    const existing = conversationId ? this.load(conversationId) : null;
    if (conversationId && !existing) throw new Error("Conversation not found");
    if (existing && context?.role !== "admin" && (!context?.owner || existing.ownerDeviceId !== context.owner.deviceId)) throw new Error("That conversation belongs to someone else");
    const conv = existing ?? this.create(context?.owner);
    if (this.running.has(conv.id)) throw new Error("The agent is still working on this conversation");
    if (!conv.ownerDeviceId && context?.owner) { conv.ownerDeviceId = context.owner.deviceId; conv.ownerName = context.owner.name; }
    const owner = conv.ownerDeviceId;
    if (!existing) this.broadcast({type:"conversation",conversation:this.publicConversation(conv)},conv.id,owner);

    // Previous turns are text only for BOTH providers. Old tool calls cannot be replayed,
    // and explicit rollback sees text from recent Hermes turns without touching old blocks.
    const transcript = conv.messages.filter(m => m.text).map(m => ({role:m.role,content:m.by && m.role === "user" ? `[${m.by}] ${m.text}` : m.text}));
    const userMsg: AgentChatMessage = {id:nanoid(8),role:"user",by:context?.by,text,toolCalls:[],createdAt:Date.now()};
    conv.messages.push(userMsg);
    if (conv.messages.length === 1) conv.title = text.slice(0,48) + (text.length > 48 ? "…" : "");
    let userText = context?.by ? `[${context.by}] ${text}` : text;
    if (context?.patternId) {
      const pattern = this.host.library.getPattern(context.patternId);
      if (pattern) userText += `\n\n(The user currently has pattern "${pattern.name}" (id ${pattern.id}) selected in the editor.)`;
    }
    const hermesHistory: OpenAIMessage[] = [{role:"system",content:system},...transcript,{role:"user",content:userText}];
    const anthropicHistory: Anthropic.Beta.Messages.BetaMessageParam[] = [...transcript,{role:"user",content:userText}];
    if (settings.provider === "anthropic") conv.history.push({role:"user",content:userText});
    this.save(conv);
    const abort = new AbortController(); this.running.set(conv.id,abort);
    const cancelRemote = () => abort.abort();
    giskard?.signal.addEventListener("abort", cancelRemote, { once: true });
    if (giskard?.signal.aborted) cancelRemote();
    this.broadcast({type:"message",conversationId:conv.id,message:userMsg},conv.id,owner);
    this.broadcast({type:"busy",conversationId:conv.id,busy:true},conv.id,owner);
    const statusBase = {provider:settings.provider,model:settings.model,reasoning:settings.provider === "hermes" ? "max (thinking enabled)" : `${settings.effort} (adaptive thinking)`};
    try {
      for (let iteration=0; iteration<12; iteration++) {
        abort.signal.throwIfAborted();
        runTurnTool.assertActive();
        const assistant: AgentChatMessage = {id:nanoid(8),role:"assistant",text:"",toolCalls:[],createdAt:Date.now(),streaming:true};
        conv.messages.push(assistant);
        this.broadcast({type:"message",conversationId:conv.id,message:assistant},conv.id,owner);
        const onText = (delta: string) => {
          if (abort.signal.aborted) return;
          assistant.text += delta;
          this.broadcast({type:"delta",conversationId:conv.id,messageId:assistant.id,text:delta},conv.id,owner);
        };
        const byIndex = new Map<number,AgentToolCall>();
        const onToolStart = (index: number,id: string,name: string) => {
          if (abort.signal.aborted) return;
          const call: AgentToolCall = {id,name,input:{},partial:""};
          byIndex.set(index,call); assistant.toolCalls.push(call);
          this.broadcast({type:"toolStart",conversationId:conv.id,messageId:assistant.id,call},conv.id,owner);
        };
        const onToolDelta = (index: number,partial: string) => {
          if (abort.signal.aborted) return;
          const call = byIndex.get(index);
          if (call) {
            call.partial = (call.partial ?? "") + partial;
            this.broadcast({type:"toolDelta",conversationId:conv.id,messageId:assistant.id,callId:call.id,partial},conv.id,owner);
          }
        };
        const state = dynamicSystem(this.host.getRig(),this.host.show.state,this.host.library);
        let toolUses: {id:string;name:string;input:unknown}[];
        if (settings.provider === "hermes") {
          hermesHistory.push({role:"system",content:state});
          const reply = await streamChatCompletion({
            baseUrl:this.testTransports.hermes ? "http://127.0.0.1:8645/v1" : process.env.LIGHTESOTA_HERMES_BASE_URL ?? "http://127.0.0.1:8645/v1",
            proxyKey:this.testTransports.hermes ? undefined : process.env.LIGHTESOTA_HERMES_PROXY_KEY || undefined,
            fetch:this.testTransports.hermes?.fetch,
            model:HERMES_MODEL,maxTokens:32000,reasoningEffort:"max",thinking:{type:"enabled"},messages:hermesHistory,
            tools:tools.map(tool => ({type:"function",function:{name:tool.name,description:tool.description,parameters:tool.input_schema,strict:true}})),
            signal:abort.signal,onText,
            onToolDelta: delta => {
              // Stream identifiers may themselves be fragmented. Use a stable UI-only id.
              if (!byIndex.has(delta.index)) onToolStart(delta.index,`hermes-${assistant.id}-${delta.index}`,delta.name);
              const call=byIndex.get(delta.index);
              if (call) call.name=delta.name;
              if (delta.arguments) onToolDelta(delta.index,delta.arguments);
            },
          });
          abort.signal.throwIfAborted();
          hermesHistory.push(reply.message); toolUses = reply.toolCalls;
        } else {
          const stateMessage = {role:"system" as const,content:state};
          anthropicHistory.push(stateMessage); conv.history.push(stateMessage);
          const reply = await this.anthropic({model:settings.model,effort:settings.effort,tools,system,messages:anthropicHistory,signal:abort.signal,onText,onToolStart,onToolDelta});
          abort.signal.throwIfAborted();
          const message = {role:"assistant" as const,content:reply.content};
          anthropicHistory.push(message); conv.history.push(message);
          if (reply.stop_reason !== "end_turn" && reply.stop_reason !== "tool_use") throw new Error("The provider returned an incomplete or refused response; no tools were run.");
          toolUses = reply.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
          if (toolUses.length && reply.stop_reason !== "tool_use") throw new Error("The provider returned incomplete tool calls; no tools were run.");
          if (toolUses.some(t => !t.id || !t.name || !t.input || typeof t.input !== "object" || Array.isArray(t.input))) throw new Error("The provider returned invalid tool arguments; no tools were run.");
        }
        this.lastStatus = {...statusBase,state:"usable",message:"The latest provider response completed successfully; this does not verify physical output."};
        runTurnTool.assertActive();
        if (!toolUses.length) { assistant.streaming=false; break; }
        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const [index,tu] of toolUses.entries()) {
          abort.signal.throwIfAborted();
          if (settings.provider === "hermes" ? !byIndex.has(index) : !assistant.toolCalls.some(c => c.id === tu.id)) onToolStart(index,tu.id,tu.name);
          const call = settings.provider === "hermes" ? byIndex.get(index)! : assistant.toolCalls.find(c => c.id === tu.id)!;
          call.name=tu.name; call.input=tu.input; call.partial=undefined;
          let result: string, isError=false;
          try { result=runTurnTool(tu.name,tu.input); }
          catch (e) { result=`Error: ${(e as Error).message}`; isError=true; }
          call.result = result.length > 4000 ? result.slice(0,4000)+"…" : result; call.isError=isError;
          if (!isError) giskard?.progress(tu.name);
          this.broadcast({type:"toolEnd",conversationId:conv.id,messageId:assistant.id,callId:call.id,result:call.result,isError},conv.id,owner);
          hermesHistory.push({role:"tool",tool_call_id:tu.id,content:result});
          results.push({type:"tool_result",tool_use_id:tu.id,content:result,is_error:isError});
        }
        if (settings.provider === "anthropic") {
          const resultMessage = {role:"user" as const,content:results};
          anthropicHistory.push(resultMessage); conv.history.push(resultMessage);
        }
        assistant.streaming=false;
        if (iteration === 11) assistant.error="Agent stopped at the 12-round tool limit. Send a fresh request to continue.";
        // Final names/inputs may differ from streamed fragments; keep existing event vocabulary.
        this.broadcast({type:"message",conversationId:conv.id,message:assistant},conv.id,owner);
        this.save(conv);
      }
    } catch (error) {
      // Transport messages, headers, URLs and upstream bodies never reach clients or saved history.
      const message = abort.signal.aborted ? "Cancelled"
        : error instanceof ProviderError ? error.message
        : error instanceof Anthropic.AuthenticationError ? "Anthropic rejected the configured credentials. Check the explicit rollback setup."
        : error instanceof Anthropic.RateLimitError ? "Anthropic rate limit reached; retry later."
        : error instanceof Anthropic.APIError ? "Anthropic request failed. Check the rollback service configuration."
        : "Agent request did not complete. Check provider setup and retry with a fresh request.";
      if (!abort.signal.aborted) this.lastStatus={...statusBase,state:error instanceof ProviderError && !["configuration","unreachable","timeout","preview","cancelled"].includes(error.code) ? "reachable" : "error",message};
      const last=conv.messages.at(-1);
      if (last?.role === "assistant") last.error=message;
      else conv.messages.push({id:nanoid(8),role:"assistant",text:"",toolCalls:[],createdAt:Date.now(),error:message});
    } finally {
      giskard?.signal.removeEventListener("abort", cancelRemote);
      this.running.delete(conv.id);
      for (const message of conv.messages) message.streaming=false;
      // A delete during inference must not resurrect the conversation.
      if (fs.existsSync(this.file(conv.id))) {
        this.save(conv);
        this.broadcast({type:"conversation",conversation:this.publicConversation(conv)},conv.id,owner);
      }
      this.broadcast({type:"busy",conversationId:conv.id,busy:false},conv.id,owner);
      this.broadcast({type:"conversations",conversations:[],all:false},conv.id,owner);
    }
    return conv.id;
  }
}
