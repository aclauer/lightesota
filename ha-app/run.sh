#!/bin/sh
# Container entrypoint. Under Home Assistant the app's options arrive in /data/options.json;
# turn the ones we know into environment variables, then start the server. Outside Home
# Assistant (docker-compose) the file does not exist and the environment is used as is.
set -e
# Keep the server in the exec'd process so container stop signals reach it. Option
# values are data, never shell source, command arguments, or log output.
# Plain CommonJS stdin avoids --input-type flags, which would break the engine's
# file-based ESM workers when inherited through process.execArgv.
exec node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

try {
  if (fs.existsSync("/data/options.json")) {
    const options = JSON.parse(fs.readFileSync("/data/options.json", "utf8"));
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const string = (name, fallback = "") => {
      const value = Object.hasOwn(options, name) ? options[name] : fallback;
      if (typeof value !== "string" || value.includes("\0")) throw new Error();
      return value;
    };
    const boolean = (name, fallback = false) => {
      const value = Object.hasOwn(options, name) ? options[name] : fallback;
      if (typeof value !== "boolean") throw new Error();
      return value ? "1" : "0";
    };

    // Preserve the existing wrapper's fallback behavior for legacy options.
    // Credentials do not select a provider; saved agent settings remain untouched.
    for (const [name, env] of [
      ["anthropic_api_key", "ANTHROPIC_API_KEY"],
      ["admin_token", "LIGHTESOTA_ADMIN_TOKEN"],
      ["data_dir", "LIGHTESOTA_DATA"],
    ]) {
      const value = string(name);
      if (value) process.env[env] = value;
    }
    if (Object.hasOwn(options, "localhost_admin")) {
      // Compatibility only: this cannot enable tokenless access in the server.
      process.env.LIGHTESOTA_LOCALHOST_ADMIN = boolean("localhost_admin");
    }

    // Apply defaults even to older saved HA options. An inherited environment
    // must not silently commission outputs or activate the new integration.
    for (const [name, env] of [
      ["preview", "LIGHTESOTA_PREVIEW"],
      ["output_commissioned", "LIGHTESOTA_OUTPUT_COMMISSIONED"],
      ["haze_commissioned", "LIGHTESOTA_HAZE_COMMISSIONED"],
      ["giskard_enabled", "LIGHTESOTA_GISKARD_ENABLED"],
    ]) process.env[env] = boolean(name);
    for (const [name, env, fallback] of [
      ["hermes_base_url", "LIGHTESOTA_HERMES_BASE_URL", "http://127.0.0.1:8645/v1"],
      ["hermes_proxy_key", "LIGHTESOTA_HERMES_PROXY_KEY"],
      ["giskard_token", "LIGHTESOTA_GISKARD_TOKEN"],
      ["giskard_team_id", "LIGHTESOTA_GISKARD_TEAM_ID"],
      ["giskard_channel_id", "LIGHTESOTA_GISKARD_CHANNEL_ID"],
      ["giskard_user_ids", "LIGHTESOTA_GISKARD_USER_IDS"],
    ]) process.env[env] = string(name, fallback);
  }
} catch {
  // JSON parse errors can contain raw input. Never print them or option values.
  console.error("Lightesota could not load Home Assistant options; check option types and JSON.");
  process.exit(1);
}
try {
  fs.mkdirSync(process.env.LIGHTESOTA_DATA || "/data", { recursive: true });
} catch {
  console.error("Lightesota could not create its data directory; check the data_dir option and permissions.");
  process.exit(1);
}
import(pathToFileURL(path.resolve("server/dist/server/src/index.js")).href).catch(() => {
  console.error("Lightesota server could not start; check the server build and configuration.");
  process.exit(1);
});
NODE
