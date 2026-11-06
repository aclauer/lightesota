import { create } from "zustand";
import type {
  AgentConversation, AgentEvent, ClientMessage, DeviceInfo, FrameColor, OutputStatus, Pattern, PatternMeta, Playlist, Presence,
  Rig, Role, Scene, ServerMessage, Settings, ShowState, HueLightInfo,
} from "@lightesota/shared";
import { roleAllows } from "@lightesota/shared";
import { WsClient, wsUrl } from "../lib/ws";
import { AudioAnalyzer } from "../lib/audio";
import { applyTheme, readThemePref, type ThemePref } from "../lib/theme";

export type View = "live" | "patterns" | "scenes" | "playlists" | "stage" | "agent" | "settings";
export interface Toast { id: number; level: "info" | "success" | "warning" | "error"; text: string; }

interface AgentState {
  conversations: { id: string; title: string; updatedAt: number; ownerName?: string; mine: boolean }[];
  current: AgentConversation | null;
  busy: Record<string, boolean>;
  all: boolean;
}

export interface AppState {
  ws: WsClient;
  connected: boolean;
  role: Role;
  clientId: string | null;
  deviceId: string | null;
  myName: string;
  devices: DeviceInfo[];
  rig: Rig | null;
  show: ShowState | null;
  patterns: PatternMeta[];
  scenes: Scene[];
  playlists: Playlist[];
  settings: Settings | null;
  status: OutputStatus | null;
  presence: Presence[];
  frame: FrameColor[];
  frameT: number;
  dmx: number[] | null;
  patternCache: Record<string, Pattern>;
  hueLights: HueLightInfo[];
  toasts: Toast[];
  view: View;
  theme: ThemePref;
  selectedFixtureId: string | null;
  editorPatternId: string | null;
  agent: AgentState;
  mic: { running: boolean; level: number; bpm: number | null; error: string | null; supported: boolean };

  // actions
  startMic: () => Promise<void>;
  stopMic: () => void;
  send: (msg: ClientMessage) => void;
  request: <T = unknown>(msg: ClientMessage) => Promise<T>;
  can: (role: Role) => boolean;
  setView: (v: View) => void;
  setTheme: (t: ThemePref) => void;
  toast: (level: Toast["level"], text: string) => void;
  dismissToast: (id: number) => void;
  selectFixture: (id: string | null) => void;
  openEditor: (patternId: string | null) => void;
  loadPattern: (id: string) => Promise<Pattern>;
  setMyName: (name: string) => void;
}

let toastSeq = 1;

export const useStore = create<AppState>((set, get) => {
  const ws = new WsClient(wsUrl());
  const analyzer = new AudioAnalyzer();
  let lastMicUi = 0;
  analyzer.onFrame = (f) => {
    ws.send({ type: "audio", frame: f });
    const now = performance.now();
    if (now - lastMicUi > 100 || f.onset) { lastMicUi = now; set((s) => ({ mic: { ...s.mic, level: f.level, bpm: f.bpm } })); }
  };
  const initialTheme = readThemePref();
  applyTheme(initialTheme);

  const onMessage = (msg: ServerMessage) => {
    switch (msg.type) {
      case "hello": {
        set({ clientId: msg.clientId, deviceId: msg.deviceId, role: msg.role, myName: msg.name });
        // The server remembers names per device; fall back to a name saved in this browser before that existed.
        const saved = safeGet("lt-name");
        if (saved && /^Guest \d+$/.test(msg.name)) ws.send({ type: "setName", name: saved });
        break;
      }
      case "devices": set({ devices: msg.devices }); break;
      case "snapshot":
        set({ rig: msg.rig, show: msg.show, patterns: msg.patterns, scenes: msg.scenes, playlists: msg.playlists, settings: msg.settings, status: msg.status, presence: msg.presence });
        break;
      case "show": set({ show: msg.show }); break;
      case "rig": set({ rig: msg.rig }); break;
      case "patterns": set((s) => ({ patterns: msg.patterns, patternCache: pruneCache(s.patternCache, msg.patterns) })); break;
      case "scenes": set({ scenes: msg.scenes }); break;
      case "playlists": set({ playlists: msg.playlists }); break;
      case "settings": set({ settings: msg.settings }); break;
      case "status": set({ status: msg.status }); break;
      case "presence": set({ presence: msg.presence }); break;
      case "frame": set({ frame: msg.colors, frameT: msg.t }); break;
      case "dmx": set({ dmx: msg.data }); break;
      case "pattern": set((s) => ({ patternCache: { ...s.patternCache, [msg.pattern.id]: msg.pattern } })); break;
      case "hueLights": set({ hueLights: msg.lights }); break;
      case "toast": get().toast(msg.level, msg.text); break;
      case "error": if (!msg.reqId) get().toast("error", msg.text); break;
      case "agent": handleAgent(msg.event); break;
    }
  };

  const handleAgent = (ev: AgentEvent) => {
    set((s) => {
      const a = { ...s.agent };
      switch (ev.type) {
        case "conversations":
          a.conversations = ev.conversations;
          a.all = ev.all;
          if (a.current && !ev.conversations.some((c) => c.id === a.current!.id)) a.current = null;
          // Open the most recent conversation when none is open yet.
          if (!a.current && ev.conversations.length > 0) setTimeout(() => ws.send({ type: "agent", command: { type: "open", conversationId: ev.conversations[0].id } }), 0);
          break;
        case "conversation":
          if (!a.current || a.current.id === ev.conversation.id || !a.conversations.some((c) => c.id === a.current!.id)) a.current = ev.conversation;
          break;
        case "busy": a.busy = { ...a.busy, [ev.conversationId]: ev.busy }; break;
        case "message":
          if (a.current?.id === ev.conversationId) {
            const msgs = a.current.messages.filter((m) => m.id !== ev.message.id);
            a.current = { ...a.current, messages: [...msgs, ev.message] };
          }
          break;
        case "delta":
          if (a.current?.id === ev.conversationId) {
            a.current = { ...a.current, messages: a.current.messages.map((m) => (m.id === ev.messageId ? { ...m, text: m.text + ev.text } : m)) };
          }
          break;
        case "toolStart":
          if (a.current?.id === ev.conversationId) {
            a.current = { ...a.current, messages: a.current.messages.map((m) => (m.id === ev.messageId ? { ...m, toolCalls: [...m.toolCalls, ev.call] } : m)) };
          }
          break;
        case "toolDelta":
          if (a.current?.id === ev.conversationId) {
            a.current = { ...a.current, messages: a.current.messages.map((m) => (m.id === ev.messageId ? { ...m, toolCalls: m.toolCalls.map((c) => (c.id === ev.callId ? { ...c, partial: (c.partial ?? "") + ev.partial } : c)) } : m)) };
          }
          break;
        case "toolEnd":
          if (a.current?.id === ev.conversationId) {
            a.current = { ...a.current, messages: a.current.messages.map((m) => (m.id === ev.messageId ? { ...m, toolCalls: m.toolCalls.map((c) => (c.id === ev.callId ? { ...c, result: ev.result, isError: ev.isError, partial: undefined } : c)) } : m)) };
          }
          break;
      }
      return { agent: a };
    });
  };

  ws.subscribe(onMessage);
  ws.onStatus = (connected) => set({ connected });
  ws.connect();

  const hashView = location.hash.replace("#", "") as View;
  const views: View[] = ["live", "patterns", "scenes", "playlists", "stage", "agent", "settings"];

  return {
    ws, connected: false, role: "viewer", clientId: null, deviceId: null, myName: "", devices: [],
    rig: null, show: null, patterns: [], scenes: [], playlists: [], settings: null, status: null, presence: [],
    frame: [], frameT: 0, dmx: null, patternCache: {}, hueLights: [], toasts: [],
    view: views.includes(hashView) ? hashView : "live",
    theme: initialTheme,
    selectedFixtureId: null, editorPatternId: null,
    agent: { conversations: [], current: null, busy: {}, all: false },
    mic: { running: false, level: 0, bpm: null, error: null, supported: typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia },

    startMic: async () => {
      try {
        await analyzer.start();
        set((s) => ({ mic: { ...s.mic, running: true, error: null } }));
      } catch (e) {
        const msg = (e as Error).name === "NotAllowedError" ? "Microphone access was denied." : location.protocol !== "https:" && location.hostname !== "localhost" ? "Browsers only allow the microphone on https or localhost. Open the console on this machine, or serve it over https." : (e as Error).message;
        set((s) => ({ mic: { ...s.mic, running: false, error: msg } }));
      }
    },
    stopMic: () => { analyzer.stop(); ws.send({ type: "audio", frame: null }); set((s) => ({ mic: { ...s.mic, running: false, level: 0, bpm: null } })); },
    send: (msg) => ws.send(msg),
    request: (msg) => ws.request(msg),
    can: (role) => roleAllows(get().role, role),
    setView: (view) => { set({ view }); history.replaceState(null, "", `#${view}`); },
    setTheme: (theme) => { applyTheme(theme); set({ theme }); },
    toast: (level, text) => {
      const id = toastSeq++;
      set((s) => ({ toasts: [...s.toasts.slice(-4), { id, level, text }] }));
      setTimeout(() => get().dismissToast(id), level === "error" ? 7000 : 3500);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    selectFixture: (id) => set({ selectedFixtureId: id }),
    openEditor: (patternId) => set({ editorPatternId: patternId, view: "patterns" }),
    loadPattern: async (id) => {
      const cached = get().patternCache[id];
      if (cached) return cached;
      await ws.request({ type: "getPattern", patternId: id });
      const p = get().patternCache[id];
      if (!p) throw new Error("Pattern not found");
      return p;
    },
    setMyName: (name) => { set({ myName: name }); safeSet("lt-name", name); ws.send({ type: "setName", name }); },
  };
});

function pruneCache(cache: Record<string, Pattern>, metas: PatternMeta[]) {
  const out: Record<string, Pattern> = {};
  for (const m of metas) {
    const c = cache[m.id];
    if (c && c.updatedAt === m.updatedAt) out[m.id] = c;
  }
  return out;
}
function safeGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/** Current beat on the client, using the server clock offset. */
export function useBeat(): { beat: number; bpm: number } {
  const show = useStore((s) => s.show);
  const ws = useStore((s) => s.ws);
  if (!show) return { beat: 0, bpm: 120 };
  const now = ws.serverNow();
  return { beat: ((now - show.transport.beatOrigin) / 60000) * show.transport.bpm, bpm: show.transport.bpm };
}
