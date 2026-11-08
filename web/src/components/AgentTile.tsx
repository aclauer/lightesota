import { useState } from "react";
import { Bot, Send } from "lucide-react";
import { useStore } from "../state/store";
import { agentPresentation } from "../lib/agent";

/** Floating quick-prompt for the agent (desktop, every tab except Agent). */
export function AgentTile() {
  const setView = useStore((s) => s.setView);
  const send = useStore((s) => s.send);
  const agent = useStore((s) => s.agent);
  const settings = useStore((s) => s.settings);
  const status = useStore((s) => s.status);
  const show = useStore((s) => s.show);
  const editorPatternId = useStore((s) => s.editorPatternId);
  const [text, setText] = useState("");
  const provider = agentPresentation(settings?.agent, status?.agent, status?.control?.preview);
  const busy = !!(agent.current && agent.busy[agent.current.id]);
  const submit = () => {
    const t = text.trim();
    if (!t || !provider.canSend || busy) { setView("agent"); return; }
    send({ type: "agent", command: { type: "send", conversationId: agent.current?.id ?? null, text: t, context: { patternId: editorPatternId || show?.patternId || null } } });
    setText("");
    setView("agent");
  };
  return (
    <div className="agent-tile" aria-label="Ask the agent">
      <button className="btn ghost icon" onClick={() => setView("agent")} title={`${provider.summary}. ${provider.label}. Open the Agent tab.`} aria-label="Open the Agent tab"><Bot /></button>
      <input className="input" placeholder={!provider.canSend ? provider.label : busy ? "Agent working…" : "Ask the agent for a look…"} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(); }} aria-label="Prompt" />
      <button className="btn primary icon" onClick={submit} disabled={!provider.canSend || busy} title={!provider.canSend ? provider.message : undefined} aria-label="Send"><Send /></button>
    </div>
  );
}
