import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { nanoid } from "nanoid";
import type { AgentChatMessage, AgentConversation, AgentEvent, AgentToolCall } from "../../../shared/src/index.js";
import { config } from "../config.js";
import { dynamicSystem, STATIC_SYSTEM } from "./prompt.js";
import { runTool, TOOL_DEFS, type AgentHost } from "./tools.js";

interface StoredConversation extends AgentConversation {
  /** Raw API history, kept separately from the UI transcript. */
  history: Anthropic.Beta.Messages.BetaMessageParam[];
}

/** Chat agent that writes lighting patterns using the Claude API. */
export class AgentService {
  private client: Anthropic | null = null;
  private running = new Map<string, AbortController>();
  private dir = path.join(config.dataDir, "agent");

  constructor(private host: AgentHost, private broadcast: (ev: AgentEvent) => void) {}

  hasCredentials(): boolean {
    return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || fs.existsSync(path.join(process.env.HOME ?? "", ".config", "anthropic")));
  }

  private getClient(): Anthropic {
    if (!this.client) this.client = new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
    return this.client;
  }

  // ---- storage ----
  list() {
    const out: { id: string; title: string; updatedAt: number }[] = [];
    for (const f of fs.readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf8")) as StoredConversation;
        out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt });
      } catch { /* skip */ }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private load(id: string): StoredConversation | null {
    const f = path.join(this.dir, `${id}.json`);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, "utf8")) as StoredConversation;
  }
  private save(c: StoredConversation) {
    c.updatedAt = Date.now();
    fs.writeFileSync(path.join(this.dir, `${c.id}.json`), JSON.stringify(c));
  }
  delete(id: string) { fs.rmSync(path.join(this.dir, `${id}.json`), { force: true }); }

  create(): StoredConversation {
    const c: StoredConversation = { id: nanoid(10), title: "New conversation", messages: [], history: [], createdAt: Date.now(), updatedAt: Date.now() };
    this.save(c);
    return c;
  }

  open(id: string): AgentConversation | null {
    const c = this.load(id);
    if (!c) return null;
    const { history: _h, ...pub } = c;
    return pub;
  }

  cancel(id: string) { this.running.get(id)?.abort(); }

  // ---- chat ----
  async send(conversationId: string | null, text: string, context?: { patternId?: string | null }) {
    const conv = (conversationId ? this.load(conversationId) : null) ?? this.create();
    if (this.running.has(conv.id)) throw new Error("The agent is still working on this conversation");
    if (!this.hasCredentials()) throw new Error("No Anthropic credentials. Set ANTHROPIC_API_KEY in the server environment (see README).");

    const userMsg: AgentChatMessage = { id: nanoid(8), role: "user", text, toolCalls: [], createdAt: Date.now() };
    conv.messages.push(userMsg);
    if (conv.messages.length === 1) conv.title = text.slice(0, 48) + (text.length > 48 ? "…" : "");
    let userText = text;
    if (context?.patternId) {
      const p = this.host.library.getPattern(context.patternId);
      if (p) userText += `\n\n(The user currently has pattern "${p.name}" (id ${p.id}) selected in the editor.)`;
    }
    conv.history.push({ role: "user", content: userText });
    this.save(conv);
    this.broadcast({ type: "message", conversationId: conv.id, message: userMsg });
    this.broadcast({ type: "busy", conversationId: conv.id, busy: true });

    const abort = new AbortController();
    this.running.set(conv.id, abort);
    const settings = this.host.getSettings().agent;
    const client = this.getClient();
    const useFallbacks = /opus-5|fable-5/.test(settings.model);

    try {
      for (let iteration = 0; iteration < 12; iteration++) {
        const assistant: AgentChatMessage = { id: nanoid(8), role: "assistant", text: "", toolCalls: [], createdAt: Date.now(), streaming: true };
        conv.messages.push(assistant);
        this.broadcast({ type: "message", conversationId: conv.id, message: assistant });

        const stream = client.beta.messages.stream({
          model: settings.model,
          max_tokens: 32000,
          betas: useFallbacks ? ["server-side-fallback-2026-06-01"] : [],
          ...(useFallbacks ? { fallbacks: [{ model: "claude-opus-4-8" }] } : {}),
          output_config: { effort: settings.effort },
          system: [
            { type: "text", text: STATIC_SYSTEM, cache_control: { type: "ephemeral" } },
            { type: "text", text: dynamicSystem(this.host.getRig(), this.host.show.state, this.host.library) },
          ],
          tools: TOOL_DEFS,
          messages: conv.history,
        }, { signal: abort.signal });

        const toolById = new Map<number, AgentToolCall>();
        stream.on("text", (delta) => {
          assistant.text += delta;
          this.broadcast({ type: "delta", conversationId: conv.id, messageId: assistant.id, text: delta });
        });
        stream.on("streamEvent", (ev) => {
          if (ev.type === "content_block_start" && ev.content_block.type === "tool_use") {
            const call: AgentToolCall = { id: ev.content_block.id, name: ev.content_block.name, input: {}, partial: "" };
            toolById.set(ev.index, call);
            assistant.toolCalls.push(call);
            this.broadcast({ type: "toolStart", conversationId: conv.id, messageId: assistant.id, call });
          } else if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") {
            const call = toolById.get(ev.index);
            if (call) {
              call.partial = (call.partial ?? "") + ev.delta.partial_json;
              this.broadcast({ type: "toolDelta", conversationId: conv.id, messageId: assistant.id, callId: call.id, partial: ev.delta.partial_json });
            }
          }
        });

        let message: Anthropic.Beta.Messages.BetaMessage;
        try {
          message = await stream.finalMessage();
        } catch (e) {
          if (abort.signal.aborted) { assistant.error = "Cancelled"; break; }
          throw e;
        }

        conv.history.push({ role: "assistant", content: message.content });

        if (message.stop_reason === "refusal") {
          assistant.error = `The model declined this request${message.stop_details?.explanation ? `: ${message.stop_details.explanation}` : ""}.`;
          break;
        }
        if (message.stop_reason === "max_tokens") { assistant.error = "Response was cut off (max tokens)."; break; }

        const toolUses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
        if (toolUses.length === 0) break;
        if (message.stop_reason === "pause_turn") continue;

        const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const call = assistant.toolCalls.find((c) => c.id === tu.id) ?? { id: tu.id, name: tu.name, input: tu.input };
          call.input = tu.input;
          call.partial = undefined;
          let result: string, isError = false;
          try {
            result = runTool(this.host, tu.name, tu.input);
          } catch (e) {
            result = `Error: ${(e as Error).message}`;
            isError = true;
          }
          call.result = result.length > 4000 ? result.slice(0, 4000) + "…" : result;
          call.isError = isError;
          this.broadcast({ type: "toolEnd", conversationId: conv.id, messageId: assistant.id, callId: tu.id, result: call.result, isError });
          results.push({ type: "tool_result", tool_use_id: tu.id, content: result, is_error: isError });
        }
        conv.history.push({ role: "user", content: results });
        assistant.streaming = false;
        this.save(conv);
      }
    } catch (e) {
      const last = conv.messages[conv.messages.length - 1];
      const msg = e instanceof Anthropic.AuthenticationError ? "Anthropic rejected the API key."
        : e instanceof Anthropic.RateLimitError ? "Rate limited by the Anthropic API; try again in a moment."
        : e instanceof Anthropic.APIError ? `Anthropic API error ${e.status}: ${e.message}`
        : (e as Error).message;
      if (last?.role === "assistant") last.error = msg; else conv.messages.push({ id: nanoid(8), role: "assistant", text: "", toolCalls: [], createdAt: Date.now(), error: msg });
      // Remove any dangling tool_use without results so the next turn is valid.
      const lastHist = conv.history[conv.history.length - 1];
      if (lastHist?.role === "assistant" && Array.isArray(lastHist.content) && lastHist.content.some((b) => b.type === "tool_use")) conv.history.pop();
    } finally {
      this.running.delete(conv.id);
      for (const m of conv.messages) m.streaming = false;
      this.save(conv);
      const { history: _h, ...pub } = conv;
      this.broadcast({ type: "conversation", conversation: pub });
      this.broadcast({ type: "busy", conversationId: conv.id, busy: false });
      this.broadcast({ type: "conversations", conversations: this.list() });
    }
    return conv.id;
  }
}
