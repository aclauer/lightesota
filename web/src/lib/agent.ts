import { HERMES_MODEL, type AgentProvider, type AgentProviderStatus, type AgentSettings } from "@lightesota/shared";

/** Only an explicit operator selection changes provider; retain the rollback configuration. */
export function selectAgentProvider(settings: AgentSettings, provider: AgentProvider): AgentSettings {
  if (settings.provider === provider) return settings;
  if (provider === "hermes") return {
    ...settings, provider, model: HERMES_MODEL, effort: "max",
    anthropic: { model: settings.model, effort: settings.effort },
  };
  const previous = settings.anthropic ?? { model: "claude-sonnet-5-5", effort: "medium" as const };
  return { ...settings, provider, ...previous };
}

const LABELS: Record<AgentProviderStatus["state"], string> = {
  configured: "Configured · not tested",
  reachable: "Reachable · inference not verified",
  usable: "Last request succeeded",
  preview: "Preview · inference disabled",
  missing: "Setup required",
  error: "Connection error",
};

export function agentPresentation(settings: AgentSettings | null | undefined, observed?: AgentProviderStatus, preview = false) {
  const provider = settings?.provider ?? "hermes";
  const model = settings?.model ?? HERMES_MODEL;
  const effort = provider === "hermes" ? "max" : settings?.effort ?? "medium";
  // A status tick from the previous provider, model or effort must not advertise success after a switch.
  const matchingEffort = observed?.reasoning === effort || observed?.reasoning.startsWith(`${effort} `);
  const current = observed?.provider === provider && observed.model === model && matchingEffort ? observed : undefined;
  const state = preview ? "preview" : current?.state ?? "configured";
  const reasoning = current?.reasoning ?? (provider === "hermes" ? "max · thinking enabled" : settings?.effort ?? "medium");
  const providerName = provider === "hermes" ? "Hermes / Nous Portal" : "Anthropic (manual rollback)";
  const message = state === "preview"
    ? "Preview mode: provider requests and physical outputs are disabled."
    : current?.message ?? (provider === "hermes"
      ? "Connection has not been tested. Ask an administrator to start the Hermes subscription proxy with company authorization, then send a prompt."
      : "Connection has not been tested. Ask an administrator to configure the Anthropic API key on the server, then send a prompt.");
  return {
    label: LABELS[state],
    summary: `${providerName} · ${model} · Reasoning: ${reasoning}`,
    message,
    tone: state === "usable" ? "ok" : state === "missing" || state === "error" || state === "reachable" ? "warn" : "",
    canSend: !!settings && state !== "preview" && state !== "missing",
  };
}
