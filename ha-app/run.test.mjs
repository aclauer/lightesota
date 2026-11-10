import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const wrapper = fileURLToPath(new URL("./run.sh", import.meta.url));
const manifest = fs.readFileSync(new URL("./config.yaml", import.meta.url), "utf8");
const newOptions = {
  hermes_base_url: ["LIGHTESOTA_HERMES_BASE_URL", "http://127.0.0.1:8645/v1", "str"],
  hermes_proxy_key: ["LIGHTESOTA_HERMES_PROXY_KEY", "", "password?"],
  preview: ["LIGHTESOTA_PREVIEW", false, "bool"],
  output_commissioned: ["LIGHTESOTA_OUTPUT_COMMISSIONED", false, "bool"],
  haze_commissioned: ["LIGHTESOTA_HAZE_COMMISSIONED", false, "bool"],
  giskard_enabled: ["LIGHTESOTA_GISKARD_ENABLED", false, "bool"],
  giskard_token: ["LIGHTESOTA_GISKARD_TOKEN", "", "password?"],
  giskard_team_id: ["LIGHTESOTA_GISKARD_TEAM_ID", "", "str?"],
  giskard_channel_id: ["LIGHTESOTA_GISKARD_CHANNEL_ID", "", "str?"],
  giskard_user_ids: ["LIGHTESOTA_GISKARD_USER_IDS", "", "str?"],
  giskard_relay_enabled: ["LIGHTESOTA_GISKARD_RELAY_ENABLED", false, "bool"],
  giskard_relay_origin: ["LIGHTESOTA_GISKARD_RELAY_ORIGIN", "", "str?"],
  giskard_connector_token: ["LIGHTESOTA_GISKARD_CONNECTOR_TOKEN", "", "password?"],
};
const envNames = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "LIGHTESOTA_ADMIN_TOKEN",
  "LIGHTESOTA_DATA", "LIGHTESOTA_LOCALHOST_ADMIN", ...Object.values(newOptions).map(([env]) => env)];

// Exercise the shipped shell entrypoint. Only /data/options.json is redirected to
// a disposable fixture; the real server import resolves to a capture-only module
// in the temporary working directory. No production server or output is started.
function run(t, options, extraEnv = {}, rawOptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lightesota-ha-wrapper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dataDir = path.join(dir, "saved-data");
  fs.mkdirSync(dataDir);
  const saved = '{"agent":{"model":"claude-existing","effort":"high"},"retained":true}\n';
  fs.writeFileSync(path.join(dataDir, "settings.json"), saved);
  const optionFile = path.join(dir, "options.json");
  if (typeof options === "function") options = options(dataDir);
  if (rawOptions !== undefined || options !== undefined) {
    fs.writeFileSync(optionFile, rawOptions ?? JSON.stringify(options));
  }
  const capture = path.join(dir, "capture.json");
  const workerCapture = path.join(dir, "worker-started.json");
  const preload = path.join(dir, "options-fixture.cjs");
  fs.writeFileSync(preload, `
    const fs = require("node:fs");
    const originalExists = fs.existsSync, originalRead = fs.readFileSync;
    const redirect = p => p === "/data/options.json" ? ${JSON.stringify(optionFile)} : p;
    fs.existsSync = function(p) { return originalExists.call(this, redirect(p)); };
    fs.readFileSync = function(p, ...args) { return originalRead.call(this, redirect(p), ...args); };
    require("node:module").syncBuiltinESMExports();
  `);
  const fakeServer = path.join(dir, "server/dist/server/src");
  fs.mkdirSync(fakeServer, { recursive: true });
  const workerFile = path.join(fakeServer, "worker.mjs");
  fs.writeFileSync(workerFile, `
    import { parentPort } from "node:worker_threads";
    parentPort.postMessage({ started: true });
  `);
  fs.writeFileSync(path.join(fakeServer, "index.js"), `
    require("node:fs").writeFileSync(${JSON.stringify(capture)}, JSON.stringify(
      Object.fromEntries(${JSON.stringify(envNames)}.map(key => [key, process.env[key] ?? null]))));
    // The real lighting engine starts a file-based Worker with inherited Node flags.
    const worker = new (require("node:worker_threads").Worker)(${JSON.stringify(workerFile)});
    worker.once("message", message => require("node:fs").writeFileSync(${JSON.stringify(workerCapture)}, JSON.stringify(message)));
    worker.once("error", error => { console.error(error.code); process.exitCode = 1; });
  `);
  const env = { ...process.env };
  for (const name of envNames) delete env[name];
  Object.assign(env, { LIGHTESOTA_DATA: dataDir }, extraEnv);
  env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --require ${JSON.stringify(preload)}`;
  const result = spawnSync("/bin/sh", [wrapper], { cwd: dir, env, encoding: "utf8", timeout: 10000 });
  assert.equal(fs.readFileSync(path.join(dataDir, "settings.json"), "utf8"), saved,
    "wrapper must not rewrite saved Anthropic settings or other data");
  return { ...result, dataDir,
    capture: fs.existsSync(capture) ? JSON.parse(fs.readFileSync(capture, "utf8")) : null,
    worker: fs.existsSync(workerCapture) ? JSON.parse(fs.readFileSync(workerCapture, "utf8")) : null };
}

test("HA manifest supplies explicit disabled gates and password fields", () => {
  const options = manifest.split("\noptions:\n")[1]?.split("\nschema:\n")[0];
  const schema = manifest.split("\nschema:\n")[1];
  for (const [name, [, value, type]] of Object.entries(newOptions)) {
    assert.match(options ?? "", new RegExp(`^  ${name}: ${JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), name);
    assert.match(schema ?? "", new RegExp(`^  ${name}: ${type.replace("?", "\\?")}$`, "m"), name);
  }
  for (const name of ["anthropic_api_key", "admin_token"]) assert.match(schema, new RegExp(`^  ${name}: password\\?$`, "m"));
  assert.match(options, /^  data_dir: \/share\/lightesota$/m);
  assert.match(options, /^  localhost_admin: true$/m);
});

test("old HA options preserve Anthropic and saved data, with new gates closed", (t) => {
  const result = run(t, { anthropic_api_key: "existing-anthropic", admin_token: "existing-admin", localhost_admin: false }, {
    LIGHTESOTA_GISKARD_ENABLED: "1", LIGHTESOTA_OUTPUT_COMMISSIONED: "1", LIGHTESOTA_HAZE_COMMISSIONED: "1",
    LIGHTESOTA_GISKARD_TOKEN: "stale-inherited-secret", LIGHTESOTA_HERMES_PROXY_KEY: "stale-proxy-secret",
    LIGHTESOTA_GISKARD_RELAY_ENABLED: "1", LIGHTESOTA_GISKARD_CONNECTOR_TOKEN: "stale-connector-secret",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.capture.ANTHROPIC_API_KEY, "existing-anthropic");
  assert.equal(result.capture.LIGHTESOTA_ADMIN_TOKEN, "existing-admin");
  assert.equal(result.capture.LIGHTESOTA_DATA, result.dataDir);
  assert.equal(result.capture.LIGHTESOTA_LOCALHOST_ADMIN, "0");
  for (const [env, value] of Object.values(newOptions)) {
    assert.equal(result.capture[env], typeof value === "boolean" ? (value ? "1" : "0") : value, env);
  }
  assert.equal(result.stdout + result.stderr, "");
});

test("HA options reach the process literally, including secret metacharacters", (t) => {
  const secret = "test-only-'\"$HOME-$(printf unsafe)-`printf unsafe`-\\-\nvalue";
  const options = {
    anthropic_api_key: secret, admin_token: secret, localhost_admin: true,
    hermes_base_url: "https://broker.example.test/v1", hermes_proxy_key: secret,
    preview: true, output_commissioned: true, haze_commissioned: true, giskard_enabled: true,
    giskard_token: secret, giskard_team_id: "TTEST123", giskard_channel_id: "CTEST123",
    giskard_user_ids: "UTEST123,WTEST456", NODE_OPTIONS: "--invalid-option-must-be-ignored",
    giskard_relay_enabled: true, giskard_relay_origin: "https://relay.example.test", giskard_connector_token: secret,
  };
  const result = run(t, options);
  assert.equal(result.status, 0, result.stderr);
  for (const [name, [env]] of Object.entries(newOptions)) {
    assert.equal(result.capture[env], typeof options[name] === "boolean" ? "1" : options[name], env);
  }
  assert.equal(result.capture.ANTHROPIC_API_KEY, secret);
  assert.equal(result.capture.LIGHTESOTA_ADMIN_TOKEN, secret);
  assert.equal(result.capture.LIGHTESOTA_LOCALHOST_ADMIN, "1");
  assert.equal(result.stdout + result.stderr, "", "startup must not print option secrets");
});

test("outside HA, existing environment remains unchanged", (t) => {
  const inherited = Object.fromEntries(envNames.filter(name => name !== "LIGHTESOTA_DATA").map((name, i) => [name, `inherited-${i}`]));
  const result = run(t, undefined, inherited);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.capture, { ...inherited, LIGHTESOTA_DATA: result.dataDir });
  assert.equal(result.stdout + result.stderr, "");
});

test("invalid optional connector fields disable only the connector without logging values", (t) => {
  for (const options of [{ giskard_relay_enabled: "true" }, { giskard_relay_enabled: true, giskard_connector_token: { secret: "never-log-this" } }]) {
    const result = run(t, options);
    assert.equal(result.status, 0);
    assert.equal(result.capture.LIGHTESOTA_GISKARD_RELAY_ENABLED, "0");
    assert.equal(result.capture.LIGHTESOTA_GISKARD_CONNECTOR_TOKEN, "");
    assert.doesNotMatch(result.stdout + result.stderr, /never-log-this|SyntaxError|\bat /);
  }
});

test("blank legacy HA secrets retain existing Anthropic environment", (t) => {
  const result = run(t, { anthropic_api_key: "", admin_token: "" }, {
    ANTHROPIC_API_KEY: "existing-key", ANTHROPIC_AUTH_TOKEN: "existing-auth", LIGHTESOTA_ADMIN_TOKEN: "existing-admin",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.capture.ANTHROPIC_API_KEY, "existing-key");
  assert.equal(result.capture.ANTHROPIC_AUTH_TOKEN, "existing-auth");
  assert.equal(result.capture.LIGHTESOTA_ADMIN_TOKEN, "existing-admin");
});

test("the HA data_dir option selects storage without altering existing data", (t) => {
  const result = run(t, (dataDir) => ({ data_dir: path.join(dataDir, "selected-storage") }));
  assert.equal(result.status, 0, result.stderr);
  const selected = path.join(result.dataDir, "selected-storage");
  assert.equal(result.capture.LIGHTESOTA_DATA, selected);
  assert.ok(fs.statSync(selected).isDirectory());
  assert.equal(result.stdout + result.stderr, "");
});

test("the launched server can start a file-based worker with inherited Node flags", (t) => {
  const result = run(t, { preview: true, output_commissioned: false, haze_commissioned: false });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.worker, { started: true });
  assert.equal(result.capture.LIGHTESOTA_PREVIEW, "1");
  assert.equal(result.capture.LIGHTESOTA_OUTPUT_COMMISSIONED, "0");
  assert.equal(result.capture.LIGHTESOTA_HAZE_COMMISSIONED, "0");
  assert.equal(result.stdout + result.stderr, "");
});

test("invalid option types and malformed JSON stop before server import without secret output", (t) => {
  for (const options of [null, [], { giskard_enabled: "true" }, { output_commissioned: 1 },
    { haze_commissioned: "1" }, { preview: null }, { hermes_proxy_key: { secret: "never-log-this" } },
    { giskard_token: "never-log-this\0truncated" }, { data_dir: 42 }]) {
    const result = run(t, options);
    assert.notEqual(result.status, 0, JSON.stringify(options));
    assert.equal(result.capture, null, "invalid options must not start the server");
    assert.doesNotMatch(result.stdout + result.stderr, /never-log-this|SyntaxError|\bat /);
  }
  const result = run(t, undefined, {}, '{"secret":"never-log-this",');
  assert.notEqual(result.status, 0);
  assert.equal(result.capture, null);
  assert.doesNotMatch(result.stdout + result.stderr, /never-log-this|SyntaxError|\bat /);
});
