import { useEffect, useState, type ReactNode } from "react";
import { Loader2, RotateCcw, Send, Square } from "lucide-react";
import { useStore } from "../state/store";

const SUGGESTIONS = [
  "Make a slow, warm sunset fade that moves from the front of the room to the back",
  "Write a chase for the pinspots that alternates on every beat while the washes breathe deep blue",
  "Create a dramatic lightning storm effect with occasional white flashes over a dark purple base",
];

/** What the agent is doing right now, from the tool it is in the middle of. */
const WORKING: Record<string, string> = {
  write_pattern: "Writing the pattern…", apply_pattern: "Applying it to the lights…", set_params: "Tuning the parameters…",
  set_bpm: "Setting the BPM…", set_master: "Setting the master level…", save_scene: "Saving the scene…", read_pattern: "Reading the current pattern…",
  list_patterns: "Looking through the patterns…", get_rig: "Looking at the rig…", get_show_state: "Checking the show…", list_scenes: "Checking the scenes…",
  get_lasers: "Checking the lasers…", set_lasers: "Setting the lasers…", lasers_off: "Turning the lasers off…",
};

/**
 * The agent as a column on the Live view. People come here to ask for a look, so it is a prompt
 * box, a "thinking" line while the agent works, and the agent's latest reply. No transcript.
 */
export function AgentPanel() {
  const agent = useStore((s) => s.agent);
  const send = useStore((s) => s.send);
  const status = useStore((s) => s.status);
  const editorPatternId = useStore((s) => s.editorPatternId);
  const show = useStore((s) => s.show);
  const [text, setText] = useState("");
  const conv = agent.current;
  const busy = conv ? !!agent.busy[conv.id] : false;

  useEffect(() => { send({ type: "agent", command: { type: "list" } }); }, [send]);

  const submit = (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg || busy) return;
    send({ type: "agent", command: { type: "send", conversationId: conv?.id ?? null, text: msg, context: { patternId: editorPatternId || show?.patternId || null } } });
    setText("");
  };

  const last = conv?.messages.filter((m) => m.role === "assistant").at(-1);
  const lastUser = conv?.messages.filter((m) => m.role === "user").at(-1);
  const pendingTool = last?.toolCalls.find((c) => c.result === undefined);
  const working = busy ? (pendingTool ? WORKING[pendingTool.name] ?? "Working…" : last?.streaming && last.text ? "Writing back…" : "Thinking…") : null;
  const hasReply = !!last && !busy && (!!last.text || !!last.error);
  const empty = !conv || conv.messages.length === 0;

  return (
    <aside className="agent-panel" aria-label="Agent">
      <div className="composer prominent">
        <textarea className="input" rows={1} placeholder={busy ? "Working…" : "Prompt the lights"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} aria-label="Prompt the lights" />
        {busy ? <button className="btn danger icon" onClick={() => conv && send({ type: "agent", command: { type: "cancel", conversationId: conv.id } })} aria-label="Stop"><Square /></button>
          : <button className="btn primary icon" onClick={() => submit()} disabled={!text.trim()} aria-label="Send"><Send /></button>}
      </div>
      {status && !status.hasApiKey && <div className="reply err">The agent needs an API key on the server (ANTHROPIC_API_KEY).</div>}
      {working && (
        <div className="thinking" role="status" aria-live="polite">
          <Loader2 className="spin" />
          <div>
            <div>{working}</div>
            {lastUser?.text && <div className="hint" style={{ marginTop: 2 }}>“{lastUser.text.length > 90 ? lastUser.text.slice(0, 90) + "…" : lastUser.text}”</div>}
          </div>
        </div>
      )}
      {hasReply && (
        <div className="reply-wrap">
          <div className="reply">{last!.text ? renderMd(last!.text) : null}{last!.error && <div className="err" style={{ marginTop: 6 }}>{last!.error}</div>}</div>
        </div>
      )}
      {empty && !busy && (
        <div className="suggestions">{SUGGESTIONS.map((s) => <button key={s} className="btn sm" onClick={() => submit(s)}>{s}</button>)}</div>
      )}
      {!empty && !busy && (
        <div className="agent-foot">
          <button className="btn sm ghost" onClick={() => send({ type: "agent", command: { type: "new" } })}><RotateCcw /> Start over</button>
          <span className="hint">Follow-ups keep the context of this chat.</span>
        </div>
      )}
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
