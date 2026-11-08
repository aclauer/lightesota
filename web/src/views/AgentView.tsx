import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Check, Loader2, Plus, Send, Square, Trash2, Wrench, X } from "lucide-react";
import type { AgentChatMessage, AgentToolCall } from "@lightesota/shared";
import { useStore } from "../state/store";
import { AgentProviderSummary } from "../components/AgentProviderSummary";
import { agentPresentation } from "../lib/agent";

const SUGGESTIONS = [
  "Make a slow, warm sunset fade that moves from the front of the room to the back",
  "Write a chase for the pinspots that alternates on every beat while the washes breathe deep blue",
  "Create a dramatic lightning storm effect with occasional white flashes over a dark purple base",
  "Modify the current pattern so the colors can be changed and the speed follows the BPM",
];

export function AgentView() {
  const agent = useStore((s) => s.agent);
  const send = useStore((s) => s.send);
  const status = useStore((s) => s.status);
  const settings = useStore((s) => s.settings);
  const can = useStore((s) => s.can);
  const editorPatternId = useStore((s) => s.editorPatternId);
  const show = useStore((s) => s.show);
  const [text, setText] = useState("");
  const msgsRef = useRef<HTMLDivElement>(null);
  const conv = agent.current;
  const busy = conv ? !!agent.busy[conv.id] : false;
  const provider = agentPresentation(settings?.agent, status?.agent, status?.control?.preview);

  useEffect(() => { send({ type: "agent", command: { type: "list" } }); }, [send]);
  useEffect(() => { const el = msgsRef.current; if (el) el.scrollTop = conv?.messages.length ? el.scrollHeight : 0; }, [conv?.messages, conv?.messages.at(-1)?.text, conv?.messages.at(-1)?.toolCalls.length]);

  const submit = (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg || busy || !provider.canSend) return;
    send({ type: "agent", command: { type: "send", conversationId: conv?.id ?? null, text: msg, context: { patternId: editorPatternId || show?.patternId || null } } });
    setText("");
  };

  return (
    <div className="agent">
      <div className="convs">
        <button className="btn" onClick={() => send({ type: "agent", command: { type: "new" } })}><Plus /> New chat</button>
        {can("admin") && (
          <div className="seg" style={{ alignSelf: "start" }}>
            <button className={!agent.all ? "active" : ""} onClick={() => send({ type: "agent", command: { type: "list", all: false } })}>Mine</button>
            <button className={agent.all ? "active" : ""} onClick={() => send({ type: "agent", command: { type: "list", all: true } })}>Everyone's</button>
          </div>
        )}
        <div className="plist">
          {agent.conversations.map((c) => (
            <button key={c.id} className={conv?.id === c.id ? "active" : ""} onClick={() => send({ type: "agent", command: { type: "open", conversationId: c.id } })} title={c.ownerName ? `Started by ${c.ownerName}` : ""}>
              <span className="t">{agent.all && !c.mine && c.ownerName ? <span className="faint">{c.ownerName}: </span> : null}{c.title}</span>
              <span className="btn ghost icon sm" role="button" aria-label="Delete" onClick={(e) => { e.stopPropagation(); send({ type: "agent", command: { type: "delete", conversationId: c.id } }); }}><Trash2 style={{ width: 13, height: 13 }} /></span>
            </button>
          ))}
        </div>
      </div>
      <div className="chat">
        <div className="msgs" ref={msgsRef}>
          <AgentProviderSummary settings={settings?.agent} status={status?.agent} preview={status?.control?.preview} />
          {!conv || conv.messages.length === 0 ? (
            <div className="stack" style={{ maxWidth: 640 }}>
              <div className="row"><Bot /> <h2 style={{ fontSize: 16 }}>Describe a look and the agent will write and apply it</h2></div>
              <p className="muted">It knows the rig (the enabled fixtures on the Stage tab). It writes a pattern, test-renders it, applies it, and exposes the tunable parts as sliders on the Live tab. Ask for changes in plain language.</p>
              <p className="hint" style={{ color: "var(--fg-2)" }}>Thinking is not shown in chat. Responses may take time; Stop cancels the current request. Existing show permissions still apply.</p>
            </div>
          ) : conv.messages.map((m) => <Message key={m.id} m={m} />)}
        </div>
        {(!conv || conv.messages.length === 0) && (
          <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} className="btn sm" disabled={!provider.canSend} onClick={() => submit(s)}>{s}</button>)}</div>
        )}
        <div className="composer">
          <textarea className="input" rows={1} placeholder={busy ? "Working…" : window.innerWidth < 600 ? "Describe a look…" : "e.g. “Make the spots strobe on the off-beat and tint the washes teal”"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Message" />
          {busy ? <button className="btn danger icon" onClick={() => conv && send({ type: "agent", command: { type: "cancel", conversationId: conv.id } })} aria-label="Stop"><Square /></button>
            : <button className="btn primary icon" onClick={() => submit()} disabled={!text.trim() || !provider.canSend} title={!provider.canSend ? provider.message : undefined} aria-label="Send"><Send /></button>}
        </div>
      </div>
    </div>
  );
}

/** Minimal markdown: paragraphs, "- " bullets, **bold**, `code`. Enough for the agent's short replies. */
function renderMd(text: string) {
  const inline = (line: string, key: number) => {
    const parts = line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
    return <span key={key}>{parts.map((p, i) => p.startsWith("**") ? <b key={i}>{p.slice(2, -2)}</b> : p.startsWith("`") ? <code key={i}>{p.slice(1, -1)}</code> : p)}</span>;
  };
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => { if (list.length) { blocks.push(<ul key={blocks.length} style={{ margin: "4px 0", paddingLeft: 18 }}>{list.map((l, i) => <li key={i}>{inline(l, i)}</li>)}</ul>); list = []; } };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*[-*] /.test(line)) { list.push(line.replace(/^\s*[-*] /, "")); continue; }
    flush();
    if (line.trim() === "") { blocks.push(<div key={blocks.length} style={{ height: 6 }} />); continue; }
    blocks.push(<div key={blocks.length}>{inline(line, 0)}</div>);
  }
  flush();
  return blocks;
}

function Message({ m }: { m: AgentChatMessage }) {
  return (
    <div className={`msg ${m.role}`}>
      {m.role === "user" && m.by && <span className="hint" style={{ textAlign: "right" }}>{m.by}</span>}
      {m.toolCalls.map((c) => <ToolCall key={c.id} c={c} />)}
      {(m.text || m.streaming) && <div className="bubble" style={{ whiteSpace: "normal" }}>{m.role === "assistant" ? renderMd(m.text) : m.text}{m.streaming && !m.text && <Loader2 className="spin" style={{ width: 14, height: 14, verticalAlign: "middle" }} />}</div>}
      {m.error && <div className="err">{m.error}</div>}
    </div>
  );
}

const TOOL_LABELS: Record<string, string> = {
  write_pattern: "Writing pattern", apply_pattern: "Applying pattern", set_params: "Adjusting parameters", set_bpm: "Setting BPM", set_master: "Setting master",
  save_scene: "Saving scene", read_pattern: "Reading pattern", list_patterns: "Listing patterns", get_rig: "Looking at the rig", get_show_state: "Checking the show", list_scenes: "Listing scenes",
};

function ToolCall({ c }: { c: AgentToolCall }) {
  const [open, setOpen] = useState(false);
  const done = c.result !== undefined;
  const label = TOOL_LABELS[c.name] ?? c.name;
  let summary = "";
  if (done && !c.isError) {
    try { const r = JSON.parse(c.result!); if (r.name) summary = `“${r.name}”`; if (r.params && !r.name) summary = `${Object.keys(r.params).length} params`; if (r.bpm) summary = `${Math.round(r.bpm)} BPM`; } catch { /* plain text */ }
  }
  const partialLen = c.partial?.length ?? 0;
  return (
    <div className={`toolcall ${c.isError ? "err" : ""}`}>
      <div className="h" onClick={() => setOpen(!open)} style={{ cursor: "pointer" }}>
        {!done ? <Loader2 className="spin" /> : c.isError ? <X style={{ color: "var(--danger)" }} /> : <Check style={{ color: "var(--ok)" }} />}
        <span>{label}{done ? "" : "…"}</span>
        <span className="faint" style={{ fontWeight: 400 }}>{summary}{!done && c.name === "write_pattern" && partialLen > 0 ? `${Math.round(partialLen / 40)} lines` : ""}</span>
        <Wrench style={{ marginLeft: "auto", opacity: 0.5 }} />
      </div>
      {open && (
        <>
          <pre>{typeof c.input === "object" && c.input && Object.keys(c.input as object).length ? JSON.stringify(c.input, null, 1).slice(0, 2000) : c.partial?.slice(-1500)}</pre>
          {done && <pre style={{ color: c.isError ? "var(--danger)" : undefined }}>{c.result}</pre>}
        </>
      )}
    </div>
  );
}
