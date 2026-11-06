import http from "node:http";
import os from "node:os";
import type { Rig, Settings } from "../../shared/src/index.js";
import { AgentService } from "./agent/agent.js";
import { Auth } from "./api/auth.js";
import type { AppContext } from "./api/context.js";
import { createApp } from "./api/http.js";
import { WsHub } from "./api/ws.js";
import { config, ensureDataDirs } from "./config.js";
import { defaultRig, defaultSettings } from "./defaults.js";
import { Library } from "./library.js";
import { OutputManager } from "./output/output.js";
import { ShowController } from "./show.js";
import { deepMerge, JsonFile } from "./store.js";

ensureDataDirs();

const rigFile = new JsonFile<Rig>("rig.json", defaultRig);
const settingsFile = new JsonFile<Settings>("settings.json", defaultSettings, (raw) => deepMerge(defaultSettings(), raw));
const library = new Library();
library.load();
const show = new ShowController(library, () => rigFile.get(), () => settingsFile.get());
const output = new OutputManager(show.engine, settingsFile.get(), rigFile.get());
const auth = new Auth(() => settingsFile.get());

let hub: WsHub;
const agent = new AgentService(
  {
    library, show,
    getRig: () => rigFile.get(), getSettings: () => settingsFile.get(),
    onPatternSaved: (id) => show.patternUpdated(id),
  },
  (ev) => hub?.broadcastRole(hub.agentAudience(), { type: "agent", event: ev }),
);

const ctx: AppContext = {
  library, show, output, rigFile, settingsFile, auth, agent,
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

server.listen(config.port, config.host, () => {
  const s = settingsFile.get();
  console.log(`\nLightesota server on http://localhost:${config.port}`);
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === "IPv4" && !a.internal) console.log(`  LAN: http://${a.address}:${config.port}  (${name})`);
  }
  console.log(`  Art-Net -> ${s.artnet.enabled ? `${s.artnet.host}:${s.artnet.port} universe ${s.artnet.universe} @ ${s.artnet.fps} fps` : "disabled"}`);
  console.log(`  Admin link: http://localhost:${config.port}/join/${auth.adminToken}`);
  console.log(`  Guest link: http://localhost:${config.port}/join/${auth.guestToken}`);
  console.log(`  Agent credentials: ${agent.hasCredentials() ? "found" : "missing (set ANTHROPIC_API_KEY)"}`);
  console.log(`  Data dir: ${config.dataDir}\n`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal}: blackout and exit`);
  show.stop();
  library.flush();
  await output.blackoutAndClose();
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
