import type { AgentProviderStatus, AgentSettings } from "@lightesota/shared";
import { agentPresentation } from "../lib/agent";

/** Shared wording for chat and settings; successful inference is distinct from configuration. */
export function AgentProviderSummary({ settings, status, preview }: { settings: AgentSettings | null | undefined; status?: AgentProviderStatus; preview?: boolean }) {
  const info = agentPresentation(settings, status, preview);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <p className="hint" style={{ overflowWrap: "anywhere", color: "var(--fg-2)" }}>{info.summary}</p>
      <div><span className={`pill ${info.tone}`}>{info.label}</span></div>
      <p className="hint" style={{ color: "var(--fg-2)" }} role="status">{info.message}</p>
    </div>
  );
}
