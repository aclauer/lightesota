import { test } from "node:test";
import assert from "node:assert/strict";
import * as defaults from "../defaults.js";
import { validateSettings } from "./validate.js";

const MODEL = "deepseek/deepseek-v4.1-flash-1017";

test("new settings select pinned Hermes inference with max reasoning", () => {
  const settings = defaults.defaultSettings();
  assert.equal(settings.agent.provider, "hermes");
  assert.equal(settings.agent.model, MODEL);
  assert.equal(settings.agent.effort, "max");
  assert.doesNotThrow(() => validateSettings(settings));
});

test("settings reject provider substitution, weaker Hermes inference and broker credentials", () => {
  const invalid = [
    { provider: "other" },
    { provider: "hermes", model: "deepseek/other", effort: "max" },
    { provider: "hermes", model: MODEL, effort: "high" },
    { provider: "hermes", model: MODEL, effort: "max", baseUrl: "http://10.0.0.1/v1" },
    { provider: "hermes", model: MODEL, effort: "max", proxyKey: "never-save-a-secret" },
  ];
  for (const patch of invalid) {
    const settings = defaults.defaultSettings();
    Object.assign(settings.agent, patch);
    assert.throws(() => validateSettings(settings), /provider|Hermes|Unknown agent/i);
  }
});

test("legacy settings and exports retain their Anthropic model, effort and quotas", () => {
  const raw = { agent: { model: "claude-custom-legacy", effort: "xhigh", allowApply: false, guestIntervalSec: 43, guestTotalPerHour: 9 } };
  const migrated = defaults.migrateSettings(raw);
  assert.equal(migrated.agent.provider, "anthropic");
  assert.equal(migrated.agent.model, raw.agent.model);
  assert.equal(migrated.agent.effort, raw.agent.effort);
  assert.equal(migrated.agent.allowApply, false);
  assert.equal(migrated.agent.guestIntervalSec, 43);
  assert.equal(migrated.agent.guestTotalPerHour, 9);
  assert.deepEqual(migrated.agent.anthropic, { model: raw.agent.model, effort: raw.agent.effort });
  assert.doesNotThrow(() => validateSettings(migrated));
  assert.deepEqual(defaults.migrateSettings(migrated), migrated);
  const current = defaults.defaultSettings();
  assert.equal(defaults.migrateSettings({ agent: { allowApply: false } }, current).agent.provider, "hermes");
  assert.equal(defaults.migrateSettings(raw, current).agent.provider, "anthropic");
});

test("explicit Anthropic rollback remains valid while malformed saved rollback data is rejected", () => {
  const settings = defaults.defaultSettings();
  Object.assign(settings.agent, { provider: "anthropic", model: "claude-custom", effort: "xhigh" });
  assert.doesNotThrow(() => validateSettings(settings));
  Object.assign(settings.agent, { anthropic: { model: "claude-custom", effort: "invalid" } });
  assert.throws(() => validateSettings(settings), /effort/i);
});
