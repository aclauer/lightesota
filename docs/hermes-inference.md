# Hermes / Nous inference

Lightesota retains its own twelve-round lighting tool loop, permission checks, guest quotas,
pattern compiler, private device conversations and fresh-action generation barrier. Hermes is
only the subscription-backed inference transport. It receives no shell, browser, networking,
filesystem or general Hermes agent tools.

New configurations select `agent.provider: "hermes"`, model
`deepseek/deepseek-v4.1-flash-1017`, effort `max`, and thinking enabled. These values are pinned
for Hermes, with a 32,000 token response budget. No fallback provider/model or lower effort is
selected after errors. Existing settings without `provider` retain their Anthropic model/effort
as explicit legacy configuration. Select Hermes deliberately in Settings to migrate that install.

## Operator setup

Use supported **company** Nous Portal authorization for the separate Hermes subscription proxy.
Ari's personal subscription must not power the shared office application. Company authorization
is an outstanding rollout prerequisite; this implementation neither reads nor copies Hermes
`auth.json`, changes profiles, logs in, nor manages OAuth tokens. The proxy owns refresh.

The supported invocation, including older installed Hermes versions, is:

```sh
hermes proxy start --provider nous --host 127.0.0.1 --port 8645
```

Follow the official [subscription proxy guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/subscription-proxy)
for the installed version. The inspected proxy has **no built-in authentication** and accepts
arbitrary Bearer values; adding a key to the client alone does not protect it. Keep the proxy on
loopback. If a separate authenticated HTTPS reverse proxy is required, put only that reverse
proxy's credential in `LIGHTESOTA_HERMES_PROXY_KEY`. It is never an upstream OAuth credential.
Do not expose the unprotected subscription proxy on the LAN or public Internet.

Server environment:

```dotenv
LIGHTESOTA_HERMES_BASE_URL=http://127.0.0.1:8645/v1
LIGHTESOTA_HERMES_PROXY_KEY=
LIGHTESOTA_GISKARD_ENABLED=0
LIGHTESOTA_OUTPUT_COMMISSIONED=0
LIGHTESOTA_HAZE_COMMISSIONED=0
```

Only HTTP on `127.0.0.1`, `localhost`, or `[::1]`, or an explicitly configured trusted HTTPS
endpoint is accepted. Userinfo, query strings and fragments are rejected. The URL is server env
only; a chat/tool/settings import cannot choose it. Redirects are rejected, so the local key is
never forwarded by a redirect. HTTPS certificate validation uses Node's normal trusted roots.
Compose passes these variables through; its host networking must actually share loopback with
the proxy. A proxy inside a different network namespace needs an explicitly protected HTTPS
endpoint, not an arbitrary LAN HTTP address.

The observed office installation is Home Assistant's `local_lightesota` add-on at
`10.10.0.192:8787`, with data in `/share/lightesota`, not this Compose deployment. Its wrapper
must pass the new variables explicitly. That wrapper is not in this repository and was not
accessible through the inspected Terminal & SSH mounts; publishing this code does not update it.

Restart only after checking the deployment configuration. `LIGHTESOTA_PREVIEW=1` permanently
vetoes all production provider requests and physical outputs, even when commissioning/credentials
are present. There is no runtime preview bypass. Offline tests inject fake transports in process.
An operator can test real inference with preview absent while leaving physical output
uncommissioned; that live inference check has **not** been performed. No live provider was switched.

## Status and failure handling

Settings/chat and health/WebSocket status report the actual provider, model, reasoning and:

| State | Meaning |
| --- | --- |
| `preview` | Provider requests and physical output blocked for process lifetime. |
| `missing` | Invalid Hermes endpoint configuration, or explicit Anthropic rollback lacks credentials. |
| `configured` | Configuration present; no connectivity/inference check has succeeded. |
| `reachable` | Broker responded but authentication, limit, refusal, truncation or stream validation prevented usable inference. |
| `usable` | A complete provider response succeeded during the latest attempt. Not physical feedback. |
| `error` | Connection failed or timed out; follow the sanitized setup/error message. |

There is no startup network probe. Environment presence is never advertised as tested connectivity.
Run the separate proxy and verify company authorization when unreachable/rejected; check
the protecting reverse proxy for authentication failures. Errors omit upstream bodies, headers, endpoint
URLs and credentials. Hermes requests have a ten-minute total deadline and no automatic retries;
each request stays within its token budget. A turn makes at most twelve requests. Cancellation
and durable Stop abort pending inference; late responses cannot regain the original generation.

SSE text streams to existing UI events. Indexed tool fragments are accumulated, then all tool
JSON must validate with a complete tool-call finish and stream terminator before any call runs.
Each response is limited to 64 MiB of total SSE bytes, including event envelopes; the existing
1 MiB event and tool-argument limits remain in place.
Truncated, refused, malformed or disconnected streams run no calls from that response. Reasoning
is hidden from UI/events/storage and echoed only to the next tool-result round in that same turn.

## Conversation storage and rollback

Existing private Anthropic `history` blocks remain intact. Prior context for either provider is
rebuilt from public user/assistant text; prior tool calls and private reasoning are not replayed.
Current-turn Hermes tool/reasoning context lives only in memory. Current Anthropic blocks remain
private in the existing history field. Owner/admin checks and per-client event routing remain.

To roll back, explicitly select **Anthropic (manual rollback)** in Settings and supply the server's
`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` through the normal operator-managed environment.
The UI remembers the prior Anthropic model/effort, including legacy custom model names. Anthropic
rollback sees recent Hermes conversation text, retains the twelve-round/generation boundaries,
and has no automatic model fallback. Rolling back inference does not change output commissioning,
single-sender ownership, laser/haze restrictions or the default-disabled Giskard gate.

## Verification scope

Offline tests cover streaming fragmentation, hidden reasoning/tool results, refusal/truncation,
redaction, cancellation, provider pinning, the bounded loop, stale authority, old history,
conversation isolation and migration. The built provider/status UI was inspected on desktop
and mobile in light/dark themes. The Giskard plugin was exercised with the real Hermes loader
and middleware in a throwaway profile and against a loopback Lightesota preview backend.
These checks did not contact live Nous, deliver Slack messages, deploy either service or verify
hardware. Company authorization, protected networking and the HA add-on rollout remain separate
activation prerequisites.
