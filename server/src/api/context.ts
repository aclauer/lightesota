import type { Rig, Settings } from "@lightesota/shared";
import type { AgentService } from "../agent/agent.js";
import type { Library } from "../library.js";
import type { OutputManager } from "../output/output.js";
import type { ShowController } from "../show.js";
import type { JsonFile } from "../store.js";
import type { Auth } from "./auth.js";

export interface AppContext {
  library: Library;
  show: ShowController;
  output: OutputManager;
  rigFile: JsonFile<Rig>;
  settingsFile: JsonFile<Settings>;
  auth: Auth;
  agent: AgentService;
  /** Called after rig or settings change so the engine/output pick them up. */
  applyConfig: () => void;
}
