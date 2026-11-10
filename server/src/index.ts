import http from "node:http";
import os from "node:os";
import type { Rig, Settings } from "../../shared/src/index.js";
import { AgentService } from "./agent/agent.js";
import { Auth } from "./api/auth.js";
import { DeviceStore } from "./api/devices.js";
import type { AppContext } from "./api/context.js";
import { createApp } from "./api/http.js";
import { WsHub } from "./api/ws.js";
import { config, ensureDataDirs } from "./config.js";
import { defaultRig, defaultSettings, migrateRig, migrateSettings } from "./defaults.js";
import { Library } from "./library.js";
import { OutputManager } from "./output/output.js";
import { ShowController } from "./show.js";
import { JsonFile } from "./store.js";
import { OUTPUT_VETO, PREVIEW } from "./output/policy.js";
import { validateRig, validateSettings } from "./api/validate.js";
import { startGiskardConnector } from "./integrations/giskard-relay.js";

ensureDataDirs();

const rigFile = new JsonFile<Rig>("rig.json", defaultRig);
{
  const m = migrateRig(rigFile.get());
  if (m.changed) { rigFile.set(m.rig); console.log("[rig] historical fixture metadata migrated; outputs start stopped"); }
  validateRig(rigFile.get());
}
const settingsFile = new JsonFile<Settings>("settings.json", defaultSettings, migrateSettings);
validateSettings(settingsFile.get());
const library = new Library();
library.load();
const show = new ShowController(library, () => rigFile.get(), () => settingsFile.get());
const output = new OutputManager(show.engine, settingsFile.get(), rigFile.get(), () => show.state);
const auth = new Auth(() => settingsFile.get());
const devices = new DeviceStore();

let hub: WsHub;
const agent = new AgentService(
  {
    library, show,
    getRig: () => rigFile.get(), getSettings: () => settingsFile.get(),
    onPatternSaved: (id, applyLive) => { if (applyLive !== false) show.patternUpdated(id); },
  },
  (ev, conversationId, owner) => hub?.agentEvent(ev, conversationId, owner),
);

const ctx: AppContext = {
  library, show, output, rigFile, settingsFile, auth, agent, devices,
  applyConfig: () => {
    output.apply(settingsFile.get(), rigFile.get());
    show.rigChanged();
    show.settingsChanged();
  },
};

const app = createApp(ctx);
const server = http.createServer(app);
hub = new WsHub(server, ctx);

show.engine.on("log", (l) => console.log("[engine]", l));
show.start();

let stopConnector = () => {};
server.listen(config.port, config.host, () => {
  stopConnector = startGiskardConnector(process.env, config.port, config.dataDir);
  const s = settingsFile.get();
  console.log(`\nLightesota server on http://localhost:${config.port}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) console.log(`  LAN: http://${a.address}:${config.port}  (${name})`);
  }
  console.log(`  Physical outputs: ${OUTPUT_VETO ? (PREVIEW ? "PREVIEW: permanently vetoed" : "uncommissioned: vetoed") : "commissioned; commanded state is not physical feedback"}`);
  console.log("  Authentication required. Tokens and share links are never printed in logs.");
  const agentStatus = agent.status();
  console.log(`  Agent: ${agentStatus.provider} / ${agentStatus.model} / ${agentStatus.reasoning}: ${agentStatus.state}`);
  console.log(`  Data dir: ${config.dataDir}\n`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: blackout and exit`);
  stopConnector();
  show.stop();
  library.flush();
  await output.blackoutAndClose();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
