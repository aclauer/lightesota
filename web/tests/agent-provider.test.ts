import assert from "node:assert/strict";
import test from "node:test";
import { HERMES_MODEL, type AgentProviderStatus, type AgentSettings } from "@lightesota/shared";
import { agentPresentation, selectAgentProvider } from "../src/lib/agent.js";

const settings: AgentSettings = { provider: "anthropic", model: "claude-preserved", effort: "xhigh", allowApply: false, guestAccess: true, guestIntervalSec: 42, guestTotalPerHour: 8 };

test("explicit provider switching pins Hermes and restores the previous Anthropic selection", () => {
  const hermes = selectAgentProvider(settings, "hermes");
  assert.equal(hermes.provider, "hermes");
  assert.equal(hermes.model, HERMES_MODEL);
  assert.equal(hermes.effort, "max");
  assert.deepEqual(hermes.anthropic, { model: settings.model, effort: settings.effort });
  assert.equal(settings.provider, "anthropic");
  const rollback = selectAgentProvider(hermes, "anthropic");
  assert.equal(rollback.model, settings.model);
  assert.equal(rollback.effort, settings.effort);
  assert.equal(rollback.allowApply, false);
  assert.equal(rollback.guestIntervalSec, 42);
  assert.equal(rollback.guestTotalPerHour, 8);
});

test("UI distinguishes untested, reachable and usable; stale provider status cannot imply connectivity", () => {
  const hermes = selectAgentProvider(settings, "hermes");
  const missingStatus = agentPresentation(hermes);
  assert.match(missingStatus.summary, /Hermes.*deepseek\/deepseek-v4\.1-flash-1017.*max.*thinking enabled/);
  assert.match(missingStatus.label, /not tested/i);
  const stale: AgentProviderStatus = { provider: "anthropic", model: settings.model, reasoning: "xhigh", state: "usable", message: "Previous success" };
  assert.match(agentPresentation(hermes, stale).label, /not tested/i);
  const changedEffort = agentPresentation({ ...settings, effort: "low" }, { ...stale, reasoning: "xhigh (adaptive thinking)" });
  assert.match(changedEffort.label, /not tested/i);
  assert.match(changedEffort.summary, /Reasoning: low/);
  assert.doesNotMatch(changedEffort.summary, /xhigh/);
  assert.equal(agentPresentation(settings, { ...stale, reasoning: "xhigh (adaptive thinking)" }).tone, "ok");
  const current: AgentProviderStatus = { provider: "hermes", model: HERMES_MODEL, reasoning: "max · thinking enabled", state: "reachable", message: "Proxy responded; check company authorization." };
  assert.match(agentPresentation(hermes, current).label, /reachable/i);
  assert.notEqual(agentPresentation(hermes, current).tone, "ok");
  assert.match(agentPresentation(hermes, { ...current, state: "usable" }).label, /succeeded/i);
  assert.equal(agentPresentation(hermes, { ...current, state: "usable" }).tone, "ok");
});

test("preview and missing setup disable prompts without confusing configured proxies with missing API keys", () => {
  const hermes = selectAgentProvider(settings, "hermes");
  const preview = agentPresentation(hermes, undefined, true);
  assert.equal(preview.canSend, false);
  assert.match(preview.message, /provider requests.*disabled/i);
  assert.doesNotMatch(preview.message, /ANTHROPIC_API_KEY/);
  const missing: AgentProviderStatus = { provider: "anthropic", model: settings.model, reasoning: "xhigh", state: "missing", message: "Set ANTHROPIC_API_KEY on the server." };
  assert.equal(agentPresentation(settings, missing).canSend, false);
  assert.equal(agentPresentation(hermes).canSend, true);
  assert.equal(agentPresentation(hermes, { ...missing, provider: "hermes", model: HERMES_MODEL, state: "error" }).canSend, true);
});
