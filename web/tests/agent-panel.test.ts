import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HERMES_MODEL, type AgentProviderStatus, type AgentSettings } from "@lightesota/shared";

test("Live agent panel retains prompt, working state and latest reply with accurate provider gates", async () => {
  // Render the actual panel/store with memory-only browser globals; no browser or socket is opened.
  const fake = {
    WebSocket: class { constructor(_url: string) {} },
    window: { isSecureContext: true },
    document: { documentElement: { dataset: {} } },
    navigator: { mediaDevices: {} },
    location: { protocol: "https:", host: "preview.invalid", hash: "" },
    localStorage: { getItem: () => null, removeItem() {} },
  };
  const original = new Map(Object.keys(fake).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(fake)) Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const { useStore } = await import("../src/state/store.js");
    const { AgentPanel } = await import("../src/views/AgentView.js");
    const state = useStore.getInitialState();
    const settings: AgentSettings = { provider: "hermes", model: HERMES_MODEL, effort: "max", allowApply: false, guestAccess: false, guestIntervalSec: 30, guestTotalPerHour: 8 };
    const observed: AgentProviderStatus = { provider: "hermes", model: HERMES_MODEL, reasoning: "max · thinking enabled", state: "configured", message: "Connection has not been tested." };
    state.settings = { agent: settings } as typeof state.settings;
    state.status = { agent: observed, hasApiKey: false, control: { preview: false } } as typeof state.status;
    const render = () => renderToStaticMarkup(createElement(AgentPanel));
    let html = render();
    assert.match(html, /aria-label="Prompt the lights"/);
    assert.match(html, /Hermes \/ Nous Portal/);
    assert.match(html, /deepseek\/deepseek-v4\.1-flash-1017/);
    assert.match(html, /Configured · not tested/);
    assert.doesNotMatch(html, /ANTHROPIC_API_KEY|New chat|Everyone&#x27;s|class="convs"/);
    assert.doesNotMatch(html, /class="btn sm" disabled=""/);

    state.status!.control!.preview = true;
    html = render();
    assert.match(html, /Preview · inference disabled/);
    assert.equal((html.match(/class="btn sm" disabled=""/g) ?? []).length, 3, "all prompt suggestions honor the preview gate");
    state.status!.control!.preview = false;
    state.status!.agent = { ...observed, state: "missing", message: "Proxy setup required." };
    assert.match(render(), /class="btn sm" disabled=""/);
    state.status!.agent = { ...observed, state: "reachable", message: "Proxy responded; inference unverified." };
    assert.match(render(), /Reachable · inference not verified/);
    state.status!.agent = { ...observed, state: "usable", message: "Complete response received." };
    assert.match(render(), /Last request succeeded/);
    state.status!.agent = { ...observed, provider: "anthropic", model: "old-model", state: "usable" };
    assert.match(render(), /Configured · not tested/, "stale provider success is never displayed as current");

    state.agent.current = { id: "chat", title: "Earlier conversation", createdAt: 0, updatedAt: 0, messages: [
      { id: "a1", role: "assistant", text: "Old reply must stay hidden", toolCalls: [], at: 0 },
      { id: "u2", role: "user", text: "Make it warm", toolCalls: [], at: 1 },
      { id: "a2", role: "assistant", text: "Latest reply visible", toolCalls: [], at: 2 },
    ] } as typeof state.agent.current;
    html = render();
    assert.match(html, /Latest reply visible/);
    assert.match(html, /Start over/);
    assert.doesNotMatch(html, /Old reply must stay hidden|Earlier conversation/);
    state.agent.busy.chat = true;
    html = render();
    assert.match(html, /Thinking…/);
    assert.match(html, /Make it warm/);
    assert.match(html, /aria-label="Stop"/);
    assert.doesNotMatch(html, /Latest reply visible/);
  } finally {
    for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
