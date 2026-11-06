import type {
  FixtureOverride, FrameColor, OutputStatus, ParamValues, Pattern, PatternMeta, Playlist,
  Presence, Rig, Role, Scene, Settings, ShowState, HueLightInfo,
} from "./types.js";

/** Messages the server pushes to clients. */
export type ServerMessage =
  | { type: "hello"; clientId: string; role: Role; serverTime: number; name: string }
  | { type: "snapshot"; rig: Rig; show: ShowState; patterns: PatternMeta[]; scenes: Scene[]; playlists: Playlist[]; settings: Settings; status: OutputStatus; presence: Presence[] }
  | { type: "show"; show: ShowState }
  | { type: "rig"; rig: Rig }
  | { type: "patterns"; patterns: PatternMeta[] }
  | { type: "scenes"; scenes: Scene[] }
  | { type: "playlists"; playlists: Playlist[] }
  | { type: "settings"; settings: Settings }
  | { type: "status"; status: OutputStatus }
  | { type: "presence"; presence: Presence[] }
  | { type: "frame"; t: number; colors: FrameColor[] }          // ordered as rig.fixtures
  | { type: "dmx"; universe: number; data: number[] }           // 512 bytes, admin only, on request
  | { type: "pattern"; pattern: Pattern }                       // response to getPattern / after save
  | { type: "toast"; level: "info" | "success" | "warning" | "error"; text: string }
  | { type: "pong"; t: number; serverTime: number }
  | { type: "agent"; event: AgentEvent }
  | { type: "hueLights"; lights: HueLightInfo[] }
  | { type: "error"; text: string; reqId?: string }
  | { type: "ack"; reqId: string; result?: unknown };

/** Messages clients send. `reqId` is echoed back in ack/error. */
export type ClientMessage =
  | { type: "ping"; t: number }
  | { type: "setName"; name: string }
  | { type: "setPattern"; patternId: string | null; params?: ParamValues; crossfadeMs?: number }
  | { type: "setParams"; params: ParamValues; merge?: boolean }
  | { type: "setMaster"; master: number }
  | { type: "setBlackout"; blackout: boolean }
  | { type: "setSpeed"; speed: number }
  | { type: "setCrossfade"; crossfadeMs: number }
  | { type: "setBpm"; bpm: number }
  | { type: "tap" }
  | { type: "resync" }
  | { type: "nudge"; ms: number }
  | { type: "setOverride"; fixtureId: string; override: FixtureOverride | null }
  | { type: "clearOverrides" }
  | { type: "setSolo"; fixtureIds: string[] }
  | { type: "setReleased"; released: boolean }
  | { type: "recallScene"; sceneId: string; crossfadeMs?: number }
  | { type: "saveScene"; name: string; sceneId?: string }
  | { type: "updateScene"; scene: Partial<Scene> & { id: string } }
  | { type: "deleteScene"; sceneId: string }
  | { type: "reorderScenes"; ids: string[] }
  | { type: "savePlaylist"; playlist: Playlist }
  | { type: "deletePlaylist"; playlistId: string }
  | { type: "playPlaylist"; playlistId: string; stepIndex?: number }
  | { type: "stopPlaylist" }
  | { type: "playlistNext" }
  | { type: "playlistPrev" }
  | { type: "getPattern"; patternId: string; reqId?: string }
  | { type: "savePattern"; pattern: { id?: string; name?: string; source: string }; reqId?: string }
  | { type: "deletePattern"; patternId: string }
  | { type: "duplicatePattern"; patternId: string; reqId?: string }
  | { type: "setRig"; rig: Rig }
  | { type: "setSettings"; settings: Partial<Settings> }
  | { type: "subscribeDmx"; on: boolean }
  | { type: "agent"; command: AgentCommand }
  | { type: "huePair"; reqId?: string }
  | { type: "hueListLights"; reqId?: string }
  | { type: "testFixture"; fixtureId: string; seconds?: number };

export function requiredRole(msg: ClientMessage): Role {
  switch (msg.type) {
    case "ping": case "setName": case "getPattern": case "subscribeDmx":
      return "viewer";
    case "setPattern": case "setParams": case "setMaster": case "setBlackout": case "setSpeed":
    case "setCrossfade": case "setBpm": case "tap": case "resync": case "nudge":
    case "setOverride": case "clearOverrides": case "setSolo": case "recallScene":
    case "playPlaylist": case "stopPlaylist": case "playlistNext": case "playlistPrev":
    case "testFixture":
      return "guest";
    case "saveScene": case "updateScene": case "deleteScene": case "reorderScenes":
    case "savePlaylist": case "deletePlaylist": case "savePattern": case "deletePattern":
    case "duplicatePattern": case "agent":
      return "editor";
    default:
      return "admin";
  }
}

/** Guest permission level -> effective role for messages. */
export function roleAllows(role: Role, needed: Role): boolean {
  const rank: Record<Role, number> = { viewer: 0, guest: 1, editor: 2, admin: 3 };
  return rank[role] >= rank[needed];
}

// ---------- Agent chat ----------

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  /** Streaming partial input (JSON text) while the model is still writing it. */
  partial?: string;
}

export interface AgentChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  toolCalls: AgentToolCall[];
  createdAt: number;
  streaming?: boolean;
  error?: string;
}

export interface AgentConversation {
  id: string;
  title: string;
  messages: AgentChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type AgentCommand =
  | { type: "list" }
  | { type: "open"; conversationId: string }
  | { type: "new" }
  | { type: "send"; conversationId: string | null; text: string; context?: { patternId?: string | null } }
  | { type: "cancel"; conversationId: string }
  | { type: "delete"; conversationId: string };

export type AgentEvent =
  | { type: "conversations"; conversations: { id: string; title: string; updatedAt: number }[] }
  | { type: "conversation"; conversation: AgentConversation }
  | { type: "delta"; conversationId: string; messageId: string; text: string }
  | { type: "toolStart"; conversationId: string; messageId: string; call: AgentToolCall }
  | { type: "toolDelta"; conversationId: string; messageId: string; callId: string; partial: string }
  | { type: "toolEnd"; conversationId: string; messageId: string; callId: string; result: string; isError: boolean }
  | { type: "message"; conversationId: string; message: AgentChatMessage }
  | { type: "busy"; conversationId: string; busy: boolean };
