import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HERMES_MODEL, ProviderError, streamChatCompletion, validateBaseUrl,
  type OpenAIMessage, type StreamChatOptions,
} from "./openai.js";

const encoder = new TextEncoder();
const packet = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\r\n\r\n`;
const done = "data: [DONE]\r\n\r\n";
const defaults = {
  model: HERMES_MODEL, messages: [{ role: "user", content: "A blue glow" }] as OpenAIMessage[],
  maxTokens: 32000, reasoningEffort: "max", thinking: { type: "enabled" as const },
};

function response(source: string, fragmentBytes = 0): Response {
  const bytes = encoder.encode(source);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      const size = fragmentBytes || bytes.length;
      for (let n = 0; n < bytes.length; n += size) controller.enqueue(bytes.slice(n, n + size));
      controller.close();
    },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
}

function run(source: string, options: Partial<StreamChatOptions> = {}) {
  return streamChatCompletion({ ...defaults, fetch: async () => response(source), ...options });
}

test("fragmented SSE and UTF-8 preserve text, indexed tool calls, and private thinking in the tool-result round", async () => {
  const requests: { url: string; options: RequestInit; body: Record<string, unknown> }[] = [];
  const text: string[] = [];
  const tools: unknown[] = [];
  const first = ": keepalive\r\n\r\n" + packet({ reasoning_content: "Private reasoning 🧠" })
    + packet({ content: "Blue 🌊" })
    + packet({ tool_calls: [{ index: 1, id: "call_", type: "function", function: { name: "get_", arguments: "{" } }] })
    + packet({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "set_master", arguments: '{"level":' } }] })
    + packet({ tool_calls: [{ index: 1, id: "b", function: { name: "rig", arguments: "}" } }, { index: 0, function: { arguments: "0.4}" } }] })
    + packet({}, "tool_calls") + done;
  const transport: typeof fetch = async (input, options) => {
    requests.push({ url: String(input), options: options!, body: JSON.parse(String(options!.body)) });
    return response(requests.length === 1 ? first : packet({ content: "Done" }, "stop") + done, 1);
  };
  const result = await streamChatCompletion({ ...defaults, fetch: transport, proxyKey: "local-key", onText: (s) => text.push(s), onToolDelta: (delta) => tools.push(delta) });
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.message.content, "Blue 🌊");
  assert.equal(result.message.reasoning_content, "Private reasoning 🧠");
  assert.deepEqual(text, ["Blue 🌊"]);
  assert.equal(tools.length, 4);
  assert.deepEqual(result.toolCalls, [{ id: "call_a", name: "set_master", input: { level: 0.4 } }, { id: "call_b", name: "get_rig", input: {} }]);
  const followup = await streamChatCompletion({ ...defaults, fetch: transport, messages: [...defaults.messages, result.message,
    { role: "tool", tool_call_id: "call_a", content: "ok" }, { role: "tool", tool_call_id: "call_b", content: "{}" }] });
  assert.equal(followup.message.content, "Done");
  assert.equal(requests[0].url, "http://127.0.0.1:8645/v1/chat/completions");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(new Headers(requests[0].options.headers).get("authorization"), "Bearer local-key");
  assert.equal(requests[0].body.model, "deepseek/deepseek-v4.1-flash-1017");
  assert.equal(requests[0].body.reasoning_effort, "max");
  assert.deepEqual(requests[0].body.thinking, { type: "enabled" });
  assert.equal(requests[0].body.max_tokens, 32000);
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual((requests[1].body.messages as OpenAIMessage[])[1], result.message);
});

test("SSE supports LF, comments, multiline data and usage after the final reason", async () => {
  const source = ': hello\n\ndata: {"choices":\ndata: [{"index":0,"delta":{"content":"Ready"},"finish_reason":"stop"}]}\n\n'
    + 'data: {"choices":[],"usage":{"completion_tokens":1}}\n\ndata: [DONE]\n\n';
  const result = await run(source);
  assert.equal(result.message.content, "Ready");
  assert.deepEqual(result.toolCalls, []);
});

test("a token-budgeted fragmented completion can exceed 4 MiB without exposing thinking or completing before DONE", async () => {
  const tokenCount = 12000;
  const event = (delta: unknown, finish_reason: string | null = null) =>
    `data: ${JSON.stringify({ id: "chatcmpl-long-completion", object: "chat.completion.chunk", created: 1794000000,
      model: HERMES_MODEL, system_fingerprint: "fp_fixture", choices: [{ index: 0, delta, logprobs: null, finish_reason }], usage: null })}\r\n\r\n`;
  const call = { index: 0, id: "call_final", type: "function", function: { name: "set_master", arguments: '{"level":0.4}' } };
  // Each reasoning/text delta is one token; conservatively reserve a token per ASCII
  // character in the final tool call. This stays below the pinned 32,000-token budget.
  assert.ok(2 * tokenCount + JSON.stringify(call).length < defaults.maxTokens);
  const bytes = encoder.encode(event({ role: "assistant", content: "" })
    + event({ reasoning_content: " think" }).repeat(tokenCount)
    + event({ content: " blue" }).repeat(tokenCount)
    + event({ tool_calls: [call] }, "tool_calls"));
  assert.ok(bytes.length > 4 * 1024 * 1024 && bytes.length < 64 * 1024 * 1024);
  let offset = 0;
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let atTerminator!: () => void;
  const awaitingDone = new Promise<void>((resolve) => { atTerminator = resolve; });
  const text: string[] = [];
  const deltas: unknown[] = [];
  let completed = false;
  const result = streamChatCompletion({ ...defaults, onText: (value) => text.push(value), onToolDelta: (delta) => deltas.push(delta),
    fetch: async (_url, options) => {
      assert.equal(JSON.parse(String(options!.body)).max_tokens, 32000);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { body = controller; },
        pull(controller) {
          if (offset === bytes.length) { atTerminator(); return; }
          // Split SSE lines and JSON envelopes across transport chunks.
          const end = Math.min(offset + 997, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        },
      }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  void result.then(() => { completed = true; }, () => {});
  await Promise.race([awaitingDone, result]);
  assert.equal(completed, false, "a complete tool fragment is not an executable result before DONE");
  assert.deepEqual(text, Array<string>(tokenCount).fill(" blue"));
  assert.deepEqual(deltas, [{ index: 0, id: "call_final", name: "set_master", arguments: '{"level":0.4}' }]);
  body.enqueue(encoder.encode(done));
  body.close();
  const complete = await result;
  assert.equal(complete.finishReason, "tool_calls");
  assert.equal(complete.message.content, " blue".repeat(tokenCount));
  assert.equal(complete.message.reasoning_content, " think".repeat(tokenCount));
  assert.deepEqual(complete.toolCalls, [{ id: "call_final", name: "set_master", input: { level: 0.4 } }]);
});

test("incomplete, malformed, truncated and refused tool responses never produce executable calls", async () => {
  const tool = (args: string, id = "call", name = "set_master") => packet({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }] });
  const invalid = [
    tool('{"level":') + packet({}, "tool_calls") + done,
    tool("[]") + packet({}, "tool_calls") + done,
    tool("null") + packet({}, "tool_calls") + done,
    tool('{"level":0.5}') + packet({}, "length") + done,
    tool('{"level":0.5}') + packet({}, "content_filter") + done,
    tool('{"level":0.5}') + packet({ refusal: "No" }, "tool_calls") + done,
    tool('{"level":0.5}') + done,
    tool('{"level":0.5}') + packet({}, "tool_calls"),
    tool('{"level":0.5}') + packet({}, "stop") + done,
    tool("{}", "", "set_master") + packet({}, "tool_calls") + done,
    tool("{}", "call", "") + packet({}, "tool_calls") + done,
    packet({}, "tool_calls") + done,
    'data: {broken}\n\n' + done,
    'data: {"error":{"message":"upstream secret"}}\n\n' + done,
  ];
  for (const source of invalid) {
    await assert.rejects(run(source), (error: unknown) => error instanceof ProviderError && !error.message.includes("upstream secret"));
  }
});

test("duplicate call IDs, noncontiguous indices and post-finish deltas fail closed", async () => {
  const call = (index: number) => ({ index, id: "same", type: "function", function: { name: "get_rig", arguments: "{}" } });
  for (const source of [
    packet({ tool_calls: [call(0), call(1)] }, "tool_calls") + done,
    packet({ tool_calls: [call(1)] }, "tool_calls") + done,
    packet({}, "stop") + packet({ content: "late" }) + done,
    packet({ tool_calls: [{ ...call(0), type: "custom" }] }, "tool_calls") + done,
  ]) await assert.rejects(run(source), ProviderError);
});

test("invalid UTF-8 and oversized stream events are rejected", async () => {
  await assert.rejects(streamChatCompletion({ ...defaults, fetch: async () => new Response(new Uint8Array([0xc3, 0x28]),
    { headers: { "content-type": "text/event-stream" } }) }), ProviderError);
  await assert.rejects(run(packet({ content: "x".repeat(1024 * 1024) }, "stop") + done), ProviderError);
});

test("the total stream limit rejects excess bytes even when each SSE event is small", async () => {
  // Reuse one 512 KiB comment chunk; never allocate a 64 MiB fixture or an unbounded stream.
  const chunk = encoder.encode(`:${" ".repeat(512 * 1024 - 2)}\n`);
  let chunks = 0;
  let cancelled = false;
  let publicEvents = 0;
  await assert.rejects(streamChatCompletion({ ...defaults, onText: () => publicEvents++, onToolDelta: () => publicEvents++,
    fetch: async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 129) controller.enqueue(chunk);
        else controller.close();
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } }),
  }), (error: unknown) => error instanceof ProviderError && error.code === "protocol");
  assert.equal(chunks, 129, "reject on the first chunk exceeding 64 MiB");
  assert.equal(cancelled, true);
  assert.equal(publicEvents, 0);
});

test("cancellation wins over a pending transport and late completion cannot emit events", async () => {
  const abort = new AbortController();
  let resolve!: (r: Response) => void;
  let events = 0;
  const result = streamChatCompletion({ ...defaults, signal: abort.signal, onText: () => events++,
    fetch: () => new Promise<Response>((r) => { resolve = r; }) });
  abort.abort(new Error("sensitive cancellation reason"));
  await assert.rejects(result, (error: unknown) => error instanceof ProviderError && error.code === "cancelled" && error.message === "Cancelled");
  resolve(response(packet({ content: "Too late" }, "stop") + done));
  await new Promise<void>((r) => setImmediate(r));
  assert.equal(events, 0);
});

test("cancellation while reading cannot return a late complete tool call", async () => {
  const abort = new AbortController();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let readStarted!: () => void;
  const reading = new Promise<void>((r) => { readStarted = r; });
  let deltas = 0;
  const result = streamChatCompletion({ ...defaults, signal: abort.signal, onToolDelta: () => deltas++, fetch: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { body = controller; }, pull() { readStarted(); },
  }), { headers: { "content-type": "text/event-stream" } }) });
  await reading;
  abort.abort();
  await assert.rejects(result, (error: unknown) => error instanceof ProviderError && error.code === "cancelled");
  try { body.enqueue(encoder.encode(packet({ tool_calls: [{ index: 0, id: "late", function: { name: "get_rig", arguments: "{}" } }] }, "tool_calls") + done)); } catch { /* cancelled stream */ }
  assert.equal(deltas, 0);
});

test("bounded timeout interrupts both ignored fetch abort and an indefinitely open stream", async () => {
  for (const transport of [
    () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream<Uint8Array>({}), { headers: { "content-type": "text/event-stream" } }),
  ]) {
    await assert.rejects(streamChatCompletion({ ...defaults, fetch: transport, timeoutMs: 10 }),
      (error: unknown) => error instanceof ProviderError && error.code === "timeout");
  }
});

test("pre-aborted request never starts the transport", async () => {
  let called = false;
  const abort = new AbortController(); abort.abort();
  await assert.rejects(streamChatCompletion({ ...defaults, signal: abort.signal, fetch: async () => { called = true; return response(done); } }),
    (error: unknown) => error instanceof ProviderError && error.code === "cancelled");
  assert.equal(called, false);
});

test("errors never expose transport messages, upstream bodies, credentials, or headers", async () => {
  const secret = "do-not-leak-this-key";
  for (const status of [301, 401, 403, 429, 500]) {
    await assert.rejects(streamChatCompletion({ ...defaults, proxyKey: secret, fetch: async () => new Response(secret, { status, headers: { "x-secret": secret } }) }),
      (error: unknown) => error instanceof ProviderError && error.status === status && !JSON.stringify(error).includes(secret) && !error.message.includes(secret));
  }
  await assert.rejects(streamChatCompletion({ ...defaults, proxyKey: secret, fetch: async () => { throw new Error(secret); } }),
    (error: unknown) => error instanceof ProviderError && error.code === "unreachable" && !error.message.includes(secret));
  await assert.rejects(streamChatCompletion({ ...defaults, fetch: async () => new Response("body", { headers: { "content-type": "text/html" } }) }), ProviderError);
});

test("broker URL accepts only loopback HTTP or explicit HTTPS without embedded credentials or query", () => {
  for (const url of ["http://127.0.0.1:8645/v1", "http://localhost:8645/v1/", "http://[::1]:8645/v1", "https://broker.example/v1"])
    assert.ok(validateBaseUrl(url).endsWith("/v1"));
  for (const url of ["http://10.10.0.2/v1", "http://example.com/v1", "https://user:password@example.com/v1", "https://example.com/v1?key=secret", "https://example.com/v1#secret", "file:///v1", "not a URL", "http://localhost.evil/v1"])
    assert.throws(() => validateBaseUrl(url), (error: unknown) => error instanceof ProviderError && !error.message.includes(url));
});

test("invalid token budget, timeout and proxy header reject before any transport", async () => {
  let requests = 0;
  const transport: typeof fetch = async () => { requests++; return response(done); };
  for (const options of [{ maxTokens: 0 }, { maxTokens: Infinity }, { maxTokens: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 600001 }, { proxyKey: "bad\r\nheader" }])
    await assert.rejects(streamChatCompletion({ ...defaults, fetch: transport, ...options }), ProviderError);
  assert.equal(requests, 0);
});

test("production transport stays disabled in PREVIEW; fake injected transport remains testable", async (t) => {
  assert.equal(process.env.LIGHTESOTA_PREVIEW, "1");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => { requests++; return response(done); });
  await assert.rejects(streamChatCompletion(defaults), (error: unknown) => error instanceof ProviderError && error.code === "preview");
  assert.equal(requests, 0);
  assert.equal((await run(packet({ content: "fake" }, "stop") + done)).message.content, "fake");
});
