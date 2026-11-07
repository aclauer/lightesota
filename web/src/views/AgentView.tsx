import { useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Check, Loader2, Plus, Send, Square, Trash2, Users, Wrench, X } from "lucide-react";
import type { AgentChatMessage, AgentToolCall } from "@lightesota/shared";
import { useStore } from "../state/store";

const SUGGESTIONS = [
  "Make a slow, warm sunset fade that moves from the front of the room to the back",
  "Write a chase for the pinspots that alternates on every beat while the washes breathe deep blue",
  "Create a dramatic lightning storm effect with occasional white flashes over a dark purple base",
  "Modify the current pattern so the colors can be changed and the speed follows the BPM",
];

/**
 * The agent as a column on the Live view: pick or start a conversation at the top, the transcript
 * runs top to bottom, the composer sits at the bottom. Replaces the old Agent tab and tile.
 */
export function AgentPanel() {
  const agent = useStore((s) => s.agent);
  const send = useStore((s) => s.send);
  const status = useStore((s) => s.status);
  const can = useStore((s) => s.can);
  const editorPatternId = useStore((s) => s.editorPatternId);
  const show = useStore((s) => s.show);
  const [text, setText] = useState("");
  const msgsRef = useRef<HTMLDivElement>(null);
  const conv = agent.current;
  const busy = conv ? !!agent.busy[conv.id] : false;

  useEffect(() => { send({ type: "agent", command: { type: "list" } }); }, [send]);
  useEffect(() => { const el = msgsRef.current; if (el) el.scrollTop = el.scrollHeight; }, [conv?.messages, conv?.messages.at(-1)?.text, conv?.messages.at(-1)?.toolCalls.length]);

  const submit = (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg || busy) return;
    send({ type: "agent", command: { type: "send", conversationId: conv?.id ?? null, text: msg, context: { patternId: editorPatternId || show?.patternId || null } } });
    setText("");
  };
  const empty = !conv || conv.messages.length === 0;

  return (
    <aside className="agent-panel" aria-label="Agent">
      <div className="agent-head">
        <Bot />
        <select className="select" value={conv?.id ?? ""} onChange={(e) => e.target.value ? send({ type: "agent", command: { type: "open", conversationId: e.target.value } }) : send({ type: "agent", command: { type: "new" } })} aria-label="Conversation">
          <option value="">New chat…</option>
          {agent.conversations.map((c) => <option key={c.id} value={c.id}>{agent.all && !c.mine && c.ownerName ? `${c.ownerName}: ` : ""}{c.title}</option>)}
        </select>
        <button className="btn ghost icon sm" title="New chat" aria-label="New chat" onClick={() => send({ type: "agent", command: { type: "new" } })}><Plus /></button>
        {can("admin") && <button className={`btn ghost icon sm ${agent.all ? "active" : ""}`} title={agent.all ? "Showing everyone's chats" : "Show everyone's chats"} aria-label="Everyone's chats" onClick={() => send({ type: "agent", command: { type: "list", all: !agent.all } })}><Users /></button>}
        {conv && <button className="btn ghost icon sm" title="Delete this chat" aria-label="Delete chat" onClick={() => send({ type: "agent", command: { type: "delete", conversationId: conv.id } })}><Trash2 /></button>}
      </div>
      <div className="msgs" ref={msgsRef}>
        {status && !status.hasApiKey && (
          <div className="card" style={{ borderColor: "var(--warn)" }}>
            <b>Agent needs an API key</b>
            <p className="muted">Set <code>ANTHROPIC_API_KEY</code> in the server's environment and restart.</p>
          </div>
        )}
        {empty ? (
          <div className="stack">
            <p className="muted">Describe a look and the agent writes a pattern, test-renders it and applies it. Tunable parts become sliders on the right. Each request takes 10 to 30 seconds.</p>
          </div>
        ) : conv!.messages.map((m) => <Message key={m.id} m={m} />)}
      </div>
      {empty && (
        <div className="suggestions">{SUGGESTIONS.slice(0, 3).map((s) => <button key={s} className="btn sm" onClick={() => submit(s)}>{s}</button>)}</div>
      )}
      <div className="composer">
        <textarea className="input" rows={1} placeholder={busy ? "Working…" : "Ask for a look…"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Message" />
        {busy ? <button className="btn danger icon" onClick={() => conv && send({ type: "agent", command: { type: "cancel", conversationId: conv.id } })} aria-label="Stop"><Square /></button>
          : <button className="btn primary icon" onClick={() => submit()} disabled={!text.trim()} aria-label="Send"><Send /></button>}
      </div>
    </aside>
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
