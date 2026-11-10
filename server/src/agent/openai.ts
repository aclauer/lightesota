import { PREVIEW } from "../output/policy.js";

export { HERMES_MODEL } from "../../../shared/src/types.js";
export const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:8645/v1";

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Private provider context. reasoning_content must never enter the public transcript. */
export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
}

export interface OpenAIToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown>; strict?: boolean };
}

export interface OpenAIToolDelta {
  index: number;
  /** Accumulated identifiers; providers can fragment these as well as arguments. */
  id: string;
  name: string;
  /** Only the new argument fragment. This is never executable input. */
  arguments: string;
}

export interface StreamChatOptions {
  baseUrl?: string;
  proxyKey?: string;
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAIToolDefinition[];
  maxTokens: number;
  reasoningEffort?: string;
  thinking?: { type: "enabled" };
  signal?: AbortSignal;
  onText?: (text: string) => void;
  onToolDelta?: (delta: OpenAIToolDelta) => void;
  /** Entire request/stream deadline, at most ten minutes. */
  timeoutMs?: number;
  /** Dependency injection for pure fake transport tests. Never wired to saved config. */
  fetch?: typeof fetch;
}

export interface OpenAIResult {
  message: OpenAIMessage;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  finishReason: "stop" | "tool_calls";
}

export type ProviderErrorCode = "configuration" | "preview" | "unreachable" | "authentication" | "rate_limit"
  | "http" | "protocol" | "cancelled" | "timeout" | "truncated" | "refused";

/** Deliberately has no raw cause, URL, request, headers, or upstream response body. */
export class ProviderError extends Error {
  constructor(public readonly code: ProviderErrorCode, message: string, public readonly status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

const configError = () => new ProviderError("configuration", "Invalid inference broker configuration. Use loopback HTTP or an explicitly configured HTTPS endpoint without credentials or query parameters.");
const protocolError = () => new ProviderError("protocol", "The inference broker returned an invalid or incomplete response. No tool calls were applied.");

export function validateBaseUrl(value = DEFAULT_HERMES_BASE_URL): string {
  let url: URL;
  try { url = new URL(value); } catch { throw configError(); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !url.hostname
    || !(url.protocol === "https:" || (url.protocol === "http:" && loopback))) throw configError();
  return url.toString().replace(/\/+$/, "");
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const MAX_STREAM_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_CHARS = 1024 * 1024;
const MAX_TOOL_CALLS = 64;

/** Interrupt even an injected transport which does not honor AbortSignal. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ProviderError("cancelled", "Cancelled"));
    if (signal.aborted) { operation.catch(() => {}); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

/** Small OpenAI chat-completions adapter. It never executes tools or retries a request. */
export async function streamChatCompletion(options: StreamChatOptions): Promise<OpenAIResult> {
  if (PREVIEW && !options.fetch) throw new ProviderError("preview", "Agent provider connections are disabled in preview");
  const baseUrl = validateBaseUrl(options.baseUrl);
  // Verified Nous direct inference closes its HTTP stream after finish_reason,
  // without [DONE]. Other brokers retain the stricter terminator requirement.
  const acceptsFinishedEof = baseUrl === "https://inference-api.nousresearch.com/v1";
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60 * 1000
    || !options.model.trim() || (options.proxyKey !== undefined && !/^[\x21-\x7e]+$/.test(options.proxyKey))) throw configError();

  const abort = new AbortController();
  let timedOut = false;
  const externalAbort = () => abort.abort();
  options.signal?.addEventListener("abort", externalAbort, { once: true });
  if (options.signal?.aborted) abort.abort();
  const deadline = setTimeout(() => { timedOut = true; abort.abort(); }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let phase: "fetch" | "stream" = "fetch";
  const checkAbort = () => { if (abort.signal.aborted) throw new ProviderError("cancelled", "Cancelled"); };

  try {
    checkAbort();
    const transport = options.fetch ?? globalThis.fetch;
    const pendingResponse = transport(`${baseUrl}/chat/completions`, {
      method: "POST", redirect: "error", signal: abort.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...(options.proxyKey ? { Authorization: `Bearer ${options.proxyKey}` } : {}) },
      body: JSON.stringify({ model: options.model, messages: options.messages, stream: true,
        max_tokens: options.maxTokens, ...(options.tools?.length ? { tools: options.tools } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
        ...(options.thinking ? { thinking: options.thinking } : {}) }),
    });
    // Release a response that arrives after cancellation, even when a test transport ignores abort.
    void pendingResponse.then((response) => { if (abort.signal.aborted) void response.body?.cancel().catch(() => {}); }, () => {});
    const response = await abortable(pendingResponse, abort.signal);
    checkAbort();
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status === 401 || status === 403) throw new ProviderError("authentication", "The inference broker rejected authentication. Check the proxy key and the broker's company account session.", status);
      if (status === 429) throw new ProviderError("rate_limit", "The inference broker is rate limited. Try again later.", status);
      throw new ProviderError("http", `The inference broker returned HTTP ${status}. Check its service status.`, status);
    }
    if (response.redirected || !response.body || !/^text\/event-stream(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
      void response.body?.cancel().catch(() => {});
      throw protocolError();
    }
    phase = "stream";
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "", reasoning = "", finishReason: string | null = null, finished = false, cleanEof = false, refused = false;
    let lineBuffer = "", dataLines: string[] = [], eventChars = 0, bytes = 0;
    const toolCalls = new Map<number, OpenAIToolCall>();

    const parseEvent = () => {
      if (!dataLines.length) return;
      const data = dataLines.join("\n");
      dataLines = []; eventChars = 0;
      if (finished) throw protocolError();
      if (data === "[DONE]") { finished = true; return; }
      let parsed: unknown;
      try { parsed = JSON.parse(data); } catch { throw protocolError(); }
      if (!isRecord(parsed) || parsed.error || !Array.isArray(parsed.choices) || parsed.choices.length > 1) throw protocolError();
      if (!parsed.choices.length) return; // Optional usage-only chunk.
      const choice: unknown = parsed.choices[0];
      if (!isRecord(choice) || choice.index !== 0 || !isRecord(choice.delta)) throw protocolError();
      const delta = choice.delta;
      if (finishReason !== null && (Object.keys(delta).length || choice.finish_reason != null)) {
        // Nous can repeat its terminal choice. Accept only the same reason and
        // observed inert delta fields; never append content or tool fragments.
        if (!acceptsFinishedEof || choice.finish_reason !== finishReason
          || !Object.entries(delta).every(([key, value]) =>
            (key === "role" && value === "assistant") || (key === "content" && value === "")
            || (key === "reasoning" && value === null))) throw protocolError();
        return;
      }
      if (delta.refusal != null) {
        if (typeof delta.refusal !== "string") throw protocolError();
        refused ||= delta.refusal.length > 0;
      }
      if (delta.content != null) {
        if (typeof delta.content !== "string") throw protocolError();
        checkAbort(); text += delta.content;
        if (delta.content) options.onText?.(delta.content);
      }
      if (delta.reasoning_content != null) {
        if (typeof delta.reasoning_content !== "string") throw protocolError();
        reasoning += delta.reasoning_content;
      }
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls)) throw protocolError();
        for (const part of delta.tool_calls) {
          if (!isRecord(part) || !Number.isInteger(part.index) || (part.index as number) < 0 || (part.index as number) >= MAX_TOOL_CALLS
            || (part.type !== undefined && part.type !== "function") || (part.id !== undefined && typeof part.id !== "string")
            || (part.function !== undefined && !isRecord(part.function))) throw protocolError();
          const index = part.index as number;
          const fn = (part.function ?? {}) as Record<string, unknown>;
          if ((fn.name !== undefined && typeof fn.name !== "string") || (fn.arguments !== undefined && typeof fn.arguments !== "string")) throw protocolError();
          const call = toolCalls.get(index) ?? { id: "", type: "function", function: { name: "", arguments: "" } };
          call.id += (part.id as string | undefined) ?? "";
          call.function.name += (fn.name as string | undefined) ?? "";
          call.function.arguments += (fn.arguments as string | undefined) ?? "";
          if (call.id.length > 256 || call.function.name.length > 128 || call.function.arguments.length > MAX_EVENT_CHARS) throw protocolError();
          toolCalls.set(index, call);
          checkAbort(); options.onToolDelta?.({ index, id: call.id, name: call.function.name, arguments: (fn.arguments as string | undefined) ?? "" });
        }
      }
      if (choice.finish_reason != null) {
        if (typeof choice.finish_reason !== "string") throw protocolError();
        finishReason = choice.finish_reason;
      }
    };

    const parseLines = (chunk: string, eof = false) => {
      lineBuffer += chunk;
      let start = 0;
      for (let n = 0; n < lineBuffer.length; n++) {
        const char = lineBuffer[n];
        if (char !== "\n" && char !== "\r") continue;
        // A CRLF pair can straddle byte chunks; do not create a spurious blank line.
        if (char === "\r" && n === lineBuffer.length - 1 && !eof) break;
        const line = lineBuffer.slice(start, n);
        if (char === "\r" && lineBuffer[n + 1] === "\n") n++;
        start = n + 1;
        if (line === "") parseEvent();
        else if (line === "data" || line.startsWith("data:")) {
          const value = line === "data" ? "" : line.slice(5).replace(/^ /, "");
          eventChars += value.length;
          if (eventChars > MAX_EVENT_CHARS) throw protocolError();
          dataLines.push(value);
        }
      }
      lineBuffer = lineBuffer.slice(start);
      if (lineBuffer.length > MAX_EVENT_CHARS) throw protocolError();
    };

    while (!finished) {
      const next = await abortable(reader.read(), abort.signal);
      checkAbort();
      if (next.done) { parseLines(decoder.decode(), true); cleanEof = true; break; }
      bytes += next.value.byteLength;
      if (bytes > MAX_STREAM_BYTES) throw protocolError();
      parseLines(decoder.decode(next.value, { stream: true }));
    }
    checkAbort();
    if (refused || finishReason === "content_filter" || finishReason === "refusal") throw new ProviderError("refused", "The model declined this request. No tool calls were applied.");
    if (finishReason === "length") throw new ProviderError("truncated", "The model response reached its token limit. No tool calls were applied.");
    if ((!finished && !(acceptsFinishedEof && cleanEof)) || (finishReason !== "stop" && finishReason !== "tool_calls") || lineBuffer.trim() || dataLines.length
      || (finishReason === "tool_calls") !== (toolCalls.size > 0)) throw protocolError();

    const calls = [...toolCalls.entries()].sort(([a], [b]) => a - b);
    const ids = new Set<string>();
    const validated = calls.map(([index, call], expectedIndex) => {
      if (index !== expectedIndex || !call.id || !/^[A-Za-z0-9_-]+$/.test(call.id) || ids.has(call.id)
        || !/^[A-Za-z0-9_-]+$/.test(call.function.name)) throw protocolError();
      ids.add(call.id);
      let input: unknown;
      try { input = JSON.parse(call.function.arguments); } catch { throw protocolError(); }
      if (!isRecord(input)) throw protocolError();
      return { id: call.id, name: call.function.name, input };
    });
    checkAbort();
    return { message: { role: "assistant", content: text || null,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(calls.length ? { tool_calls: calls.map(([, call]) => call) } : {}),
    }, toolCalls: validated, finishReason };
  } catch (error) {
    if (timedOut) throw new ProviderError("timeout", "The inference broker timed out. Check its connection and try again.");
    if (abort.signal.aborted) throw new ProviderError("cancelled", "Cancelled");
    if (error instanceof ProviderError) throw error;
    throw phase === "fetch" ? new ProviderError("unreachable", "The inference broker could not be reached. Start the configured Hermes subscription proxy and check its address.") : protocolError();
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener("abort", externalAbort);
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* outstanding read cancelled above */ } }
  }
}
