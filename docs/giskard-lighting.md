# Giskard lighting API

This is an opt-in, authenticated gateway API over Lightesota's existing `ShowController` and lighting `AgentService`. It creates no output sender and calls neither Home Assistant nor a Hue bridge directly. Typed fixture commands control ordinary lights; natural requests can also use the agent's existing manually armed, typed laser controls. Haze is excluded. The matching [native Hermes plugin](../integrations/giskard/README.md) ships in this repository.

For company-cloud access to the HA-hosted app, the optional
[Vercel ↔ HA mailbox connector](../integrations/giskard-relay/README.md) forwards only
these four operations through outbound HA HTTPS and fixed numeric loopback dispatch.
It uses three distinct credentials and grants no commissioning authority. The office
deployment and native Slack natural-language/action/Stop acceptance are recorded in
the [changelog](lighting-integration-changelog.md), including device-readback limitations.
Its optional `X-Lightesota-Relay-Dispatch` header can only tighten this API: a missing,
expired or consumed connector permit rejects the effect at the router. Direct requests
without that header retain the contract below. Raw path aliases and queries are rejected.

**Before commissioning a deployment, keep physical output disabled until independent HA/Lightesota DMX senders have been reduced to the verified single-sender arrangement.** The office installation now has ordinary output enabled and was left stopped after acceptance. Haze remains disabled; laser arming and physical safety remain operator responsibilities. Device readback does not establish optical appearance or laser safety.

## Operator configuration

The server reads these environment variables when constructing the API. They are not saved settings and never appear in settings exports or readback. The reconciled [HA wrapper](../ha-app/run.sh) maps the `giskard_*` options in HA Configuration to these variables; its [manifest](../ha-app/config.yaml) declares `giskard_token` as a password and defaults the integration off with empty identity fields. This source support does not activate the proxy or Slack gateway. Preserve existing HA options and `/share/lightesota` data when the operator rebuilds the app.

| Variable | Required value |
| --- | --- |
| `LIGHTESOTA_GISKARD_ENABLED` | Exactly `1` to enable; unset/default is disabled. |
| `LIGHTESOTA_GISKARD_TOKEN` | A dedicated random printable non-whitespace secret, 32–1024 characters. Generate it securely and keep it only in the server and trusted gateway. Do not reuse admin/guest, Hermes proxy, or OAuth credentials. |
| `LIGHTESOTA_GISKARD_TEAM_ID` | Exact Slack team ID, `T` followed by 2–31 uppercase alphanumeric characters. Discover the actual value from trusted Slack metadata. |
| `LIGHTESOTA_GISKARD_CHANNEL_ID` | Exact Slack channel ID. Current requested channel is `C0CB4RFQ55Y` (`#giskard`). |
| `LIGHTESOTA_GISKARD_USER_IDS` | Comma-separated explicit Slack `U`/`W` IDs (maximum 100 entries). No wildcard, empty entry, display name, or inferred membership. The operator supplies the actual authorized users. |
| `LIGHTESOTA_OUTPUT_COMMISSIONED` | Exactly `1` is required for normal applies outside preview. Operator-owned commissioning follows the existing migration runbook. |
| `LIGHTESOTA_HAZE_COMMISSIONED` | Keep `0`. Natural requests fail closed if haze was commissioned at process start; existing output packing vetoes haze while it is disabled. |
| `LIGHTESOTA_PREVIEW` | Existing `1` allows virtual-state QA, while permanently blocking physical output **and provider requests**. No API request changes this gate. |

An enabled but incomplete/invalid configuration fails closed with `503 not_configured`. A disabled integration returns `404 disabled`, including for Stop. With valid enabled configuration, authenticated state/lease/Stop remain available while commissioning blocks apply.

The dedicated bearer is independent of existing `/api/control` and browser/WebSocket authentication. Cookies, query tokens, existing admin/guest tokens, and localhost do not authenticate Giskard. The configured Giskard token is explicitly denied by existing machine/browser/WebSocket authentication even if its value accidentally matches an admin/guest token or admin override. Use a unique dedicated secret to avoid breaking existing operator access.

Only use HTTPS or a private, access-protected tunnel. The API accepts a TLS socket or an actual loopback peer (`127.0.0.1`, `::1`, IPv4-mapped loopback) from a locally terminated tunnel/proxy. Direct plain HTTP from a LAN address is rejected. Forwarded headers cannot grant protected-transport status. The deployment operator owns TLS, tunnel protection, ingress restrictions and networking; this implementation exposes no new listener. Loopback acceptance does not replace bearer or identity checks. Do not publish a public proxy to these routes.

## Trusted gateway sequence

1. Validate the Slack event in the gateway. Construct `{teamId, channelId, userId, turnId}` from trusted event metadata, never LLM tool arguments. `turnId` is a stable unique event/turn ID; use the same value for delivery retries. It must match `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`.
2. **Before the first model inference**, request one lease for that identity. Store the lease outside the model context. Never let a tool call, provider retry, or read-state request reacquire it.
3. Expose only sanitized state and the command schema below to the model. Resolve fixture choices against the returned enabled fixtures.
4. The gateway attaches the captured identity and lease to at most one typed apply. The model never supplies identity, lease, headers, endpoint, arbitrary URL, JavaScript, or credentials.
5. On `invalid_lease`, end that turn's ability to write. A genuinely new user turn must capture fresh authority before inference. Never fabricate a new turn ID to retry an old action.

The shipped plugin validates the original trusted `HERMES_SESSION_MESSAGE_ID` **before hashing**: exactly ten ASCII decimal seconds digits, `.` and six fractional digits from the message's Slack `ts`, never `thread_ts`. Exact integer microsecond parsing enforces an inclusive age of at most 120 seconds and future skew of at most 30 seconds against finite wall time. Non-string/malformed IDs and non-finite clocks fail closed. The token is not normalized. `wall_clock=time.time` is separately injectable from the existing monotonic lease clock.

`identity()` rechecks freshness before the pre-inference receipt/network request and before each lighting tool invocation. A long inference, continuation, new runtime turn/session or restart cannot refresh the original timestamp; the user must ask again in a new Slack message. Durable event receipts and runtime correlation still prevent repeated authority within the freshness window. This closes the source-level unseen-old-message gap without changing any backend endpoint or model schema. Parent must still verify hosted message-`ts` metadata, clock accuracy and both middleware hooks; local adapter inspection and offline tests are not hosted acceptance.
6. Readback describes requested Lightesota state. Tell the user when preview, master zero, stopped mode, blackout, release or commissioning prevents an emitting result. Never claim observed light output.

Stop needs no lease and should remain available independently of inference. In the shipped Slack plugin, state/Stop still require a fresh authorized message, even when lease acquisition or receipt storage fails. A genuine new message can resume ordinary lights after Stop; an old turn cannot.

## HTTP contract

All four endpoints accept **POST**, `Content-Type: application/json`, and a dedicated token in the HTTP Authorization Bearer header. No CORS access is granted. Bodies are strict JSON objects of at most **8192 bytes**; compressed bodies are rejected, unknown fields at every request/identity/command level are rejected, and requests have a **15-second** deadline. Route errors never echo request bodies, authorization headers, or raw exception details.

`identity` below always means:

```json
{"teamId":"TEXAMPLE","channelId":"C0CB4RFQ55Y","userId":"UEXAMPLE","turnId":"event-unique-123"}
```

Those are schema examples, not a configured team or user. All four fields are required, with exact team/channel and explicit user allowlisting. Team/channel/user IDs accept 2–31 uppercase alphanumeric characters after the corresponding `T`/`C`/`U`/`W` prefix.

### POST `/api/integrations/giskard/state`

Body: `{"identity":{...},"requestId":"<optional 24-character request ID>"}`

Response: `{"ok":true,"state":{...},"request":{...}}`. Reading state never creates, renews or consumes a lease. Request status is visible only to its exact Slack team/channel/actor; without an ID the latest owned request is returned. Missing, foreign, restarted or expired-retention IDs return `{"status":"unknown"}`, never another actor's conversation. This is not a conversation/history API.

Every returned `state` has these fields:

| Field | Meaning |
| --- | --- |
| `generation` | Current Lightesota ownership generation; any competing control or Stop invalidates an older lease. |
| `blackout`, `released`, `stopped` | Current boolean authority/control flags. |
| `master` | Existing normalized master, `0..1`; API commands never raise it automatically. |
| `preview`, `commissioned` | Process-lifetime policy flags, not proof of working hardware. |
| `outputStatus` | First applicable value: `blackout`, `released`, `stopped`, `master_zero`, `preview`, `uncommissioned`, `commanded`. |
| `fixtures` | Enabled known ordinary fixtures only: `{id,name,tags,side,transport}`. `side` is existing `a`/`b` grouping; `transport` is `dmx`/`hue`. No addresses, bridge keys or internal Hue IDs. |
| `lights` | Requested controls for those fixtures. Washes: `{fixtureId,owner,mode,brightness,color,white,sensitivity}`. Other lights: `{fixtureId,owner,brightness,color}`. Brightness/white use `0..100`; color uses `#rrggbb`. Non-wash brightness/color are `null` when no explicit manual value exists. Pattern-owned wash values are retained control settings, not a live sampled pattern frame. |
| `ownership` | `{authority:"lightesota",physicalState:"unverified",caveat:"..."}` explaining that there is no fixture feedback and independent senders can still affect lights. |

No settings export, conversation/history, tokens, laser state or haze state is returned.

### POST `/api/integrations/giskard/lease`

Body: `{"identity":{...}}`

Successful response:

```json
{
  "ok": true,
  "leaseId": "<opaque 43-character base64url ID>",
  "generation": 123,
  "expiresAt": 1794000120000,
  "remainingMutations": 1,
  "command": {"kind":"lease"},
  "state": {},
  "preview": true,
  "physicalOutput": "unverified"
}
```

`state` is the full schema above; `{}` is abbreviated only in this example. `expiresAt` is Unix time in milliseconds. A lease expires **120 seconds after its first issuance**, permits **one apply**, and is bound to exact identity, server boot, and captured generation. A repeated request while still usable returns the same lease ID, original generation and original expiry. A consumed, expired or stale turn gets `409 invalid_lease`; repeating it cannot renew authority, including after Stop.

The boot-local ledger retains all turn records, including consumed/expired tombstones, up to **10,000** turns. It never evicts a tombstone to create new authority. At capacity new turns receive `503 lease_capacity`; state and Stop continue to work. Restart requires operator maintenance and makes all old lease IDs invalid. The shipped gateway plugin suppresses old Slack event replays with a durable SQLite event-hash receipt committed before each first lease request. Preserve its profile database across restarts/upgrades and verify storage support on the deployed Hermes version; missing storage fails closed for apply. A restart is not permission to rerun old user turns.

### POST `/api/integrations/giskard/apply`

Body: `{"identity":{...},"leaseId":"...","command":{...}}`

Exactly one command object is allowed. The three typed fixture commands target 1–128 unique enabled IDs:

```json
{"kind":"set_lights","fixtureIds":["w1","w2"],"brightness":30,"color":"#ff8800"}
```

`brightness` is a finite number in `0..100`; optional `color` is exactly `#RRGGBB` (case-insensitive). Targets may be ordinary washes, Hue or other enabled ordinary fixtures. Uses sticky `setWash`/`setOverride` control. Brightness-only preserves the current wash mode/color and the current non-wash color; changing the brightness of an off wash therefore leaves that mode off. Explicit color returns washes to Normal and clears their white component. Use `wash_mode` when the requested action is a mode change. Brightness is quantized to existing 0–255 wash dimmer values; readback reports that quantized value as percent.

```json
{"kind":"wash_mode","fixtureIds":["w1"],"mode":"music6","sensitivity":160}
```

Targets must be existing enabled 12-channel wash fixtures. `mode` is exactly `off`, `normal`, `music6`, or `music32`. Optional `sensitivity` is an integer `11..255`. Other controls and unrelated fixtures remain unchanged, using existing wash ownership behavior.

```json
{"kind":"quick_look","fixtureIds":["w1","w3"],"lookId":"cyan-magenta"}
```

Targets must be enabled washes. `lookId` is exactly `warm-arrival`, `cyan-magenta`, or `calm-blue`, using existing `quickLook` levels/colors and side grouping.

These three fixture commands accept no laser/haze targets, disabled/unknown fixtures, `laser-duo`, strobe, raw channels, dynamic pattern code, schedules, arm commands, arbitrary URLs or JavaScript. The entire command and target batch validate before any change. Validation failure does not consume a lease. The API checks commissioning, blackout/release and lease freshness, consumes the lease, then checks the generation again immediately before the synchronous mutations, with no inference or await between them. Once consumed, even a partial/internal failure cannot repeat effects with the same lease.

Blackout or release is never cleared by apply. Typed fixture commands never raise master zero; a successful stored change with master zero reports `outputStatus:"master_zero"`. Existing `ShowController` manual takeover rules still stop competing writers for the selected scope and invalidate old authority.

Successful response: `{"ok":true,"command":<normalized accepted command>,"state":<sanitized readback>,"preview":<boolean>,"physicalOutput":"unverified"}`. This means Lightesota accepted the control state, not that physical lights were observed.

The fourth command starts the existing lighting agent:

```json
{"kind":"agent_request","prompt":"Make the lights shift from left to right"}
```

`prompt` must be nonempty and at most **4096 UTF-8 bytes**, within the existing 8192-byte
request cap. Admission consumes the same single-use lease and returns **HTTP 202** with
`{ok:true,command:{kind:"agent_request"},request:{id,status:"accepted",summary:"",tools:[],remainingMs,physicalOutput:"unverified"},preview,physicalOutput:"unverified"}`.
The prompt and private conversation ID are not echoed. Acceptance confirms only that the
backend admitted work. The relay preserves this 202; it never treats acceptance as a Stop ACK.

Read `state` for `running`, `completed`, `failed`, `cancelled`, `expired` or `unknown`.
Status includes a bounded final summary and successful tool names, not tool arguments or
private reasoning. Completion means the existing 12-round agent loop ended without reported
tool/provider errors; it does not prove physical output. A failure/timeout may follow partial
effects. Unknown submission/status must never trigger automatic resubmission.

One remote request may run at a time; there is no queue or restart auto-resume. Up to 64
volatile status records last through the original deadline plus five minutes. Authority
uses the original generation and the remaining lease (wall and monotonic expiry), never a
fresh 120 seconds after enqueue. Stop, cancellation, takeover, blackout/release and expiry
block later tools, including pattern saves. Only exact synchronous generation changes from
this request's own validated tools carry forward. Completed earlier effects are not rolled
back by timeout. The short relay dispatch permit covers admission only; inference does not
extend a relay/session deadline. Once accepted, a job can run to its original lease deadline
even if its caller loses the acceptance reply; use read-only status or Stop.

The remote capability explicitly allows `get_rig`, `get_show_state`, `list_patterns`,
`read_pattern`, `write_pattern`, `apply_pattern`, `set_params`, `set_bpm`, `set_master`,
`list_scenes`, `get_lasers`, `set_lasers`, `lasers_off`. All future/unknown tools fail closed.
Pattern saves create new copies, at most eight per request and 65536 source bytes each,
using the existing sandbox. Pattern apply is an explicit whole-rig ordinary Start and
releases wash/Hue manual overrides and solo selection while retaining master. The typed fixture commands
remain available for selected-fixture changes. No browser admin role is granted. Lasers
require manual arming, a running show and existing typed geometry/strobe limits; pattern
Follow remains operator-only. Haze stays disabled at the existing process/output boundary.

### POST `/api/integrations/giskard/stop`

Body: `{"identity":{...}}`

Calls durable `stopLighting`, cancels pending effects/agent generations, invalidates older leases and disarms lasers/haze through existing show logic. No lease is required. This remains authorized during blackout, release or uncommissioned output when the integration itself is enabled/configured. It does not stop an independent HA/DMX sender or assert physical feedback.

Successful response: `{"ok":true,"command":{"kind":"stop"},"state":<sanitized readback>,"preview":<boolean>,"physicalOutput":"unverified"}`.

## Failures, limits and audit

Errors are JSON: `{"ok":false,"code":"...","error":"<sanitized actionable message>"}`.

| HTTP | Codes / interpretation |
| --- | --- |
| 400 | `invalid_request`, `invalid_command`, `invalid_json`: schema, type, target, command or parsing error; no mutation. |
| 401 | `unauthorized`: dedicated bearer missing or wrong. |
| 403 | `identity_denied`, `protected_transport_required`. |
| 404 | `disabled`, `not_found`: integration disabled or unsupported path/method. |
| 408 | `request_timeout`: body/request deadline exceeded. |
| 409 | `invalid_lease`, `output_blocked`: end old turn authority; do not silently retry with a new lease/turn. |
| 413 | `body_too_large`: maximum 8192 JSON bytes. |
| 415 | `json_required`, `invalid_json`: wrong media type or compressed JSON body. |
| 429 | `rate_limited`: finite request budget exceeded. |
| 500 | `operation_failed`: no raw exception detail; read state before a genuinely new turn. The apply lease may already be consumed. |
| 503 | `not_configured`, `uncommissioned`, `lease_capacity`: operator action required. |

Fixed one-minute windows permit 240 non-Stop requests globally and 60 per allowed user. Stop has independent budgets of 120 globally and 30 per allowed user, so ordinary API use cannot exhaust its reserve. Global counts include only requests that pass dedicated bearer authentication and protected-transport checks. Per-user storage is bounded by the explicit allowlist, and the lease ledger is independently bounded.

Structured audit entries contain only integration name, actor IDs (including trusted turn ID), command kind, target IDs, generation and result. They never contain prompt text, tokens, headers, lease IDs, history or raw exception/upstream bodies. Natural requests use the existing provider asynchronously; state, lease, typed apply and Stop do not depend on inference completing.

## Validation and rollout

`server/src/api/giskard.test.ts` uses the real `ShowController` with isolated temporary storage and in-memory engine state. Express parser checks run through in-memory HTTP streams without a listener or network. Tests cover separate bearer authentication, default-off/config gates, allowlists, sanitized state, atomic invalid mixed targets, disabled/hazard/code rejection, sticky color/mode retention, one-use/repeated/expired/restart/capacity leases, takeover/Stop invalidation, commissioning, master-zero reporting, scope preservation, Stop cancellation/disarming, body/rate bounds, parse error redaction and a fake-time request deadline that prevents late callbacks from mutating or sending a second response.

Run the focused suite with:

```sh
LIGHTESOTA_PREVIEW=1 node --import tsx --test server/src/api/giskard.test.ts
```

The plugin, provider/status UI and API have been exercised in isolated local preview, including the real Hermes loader/middleware and real loopback HTTP. Live company authentication, protected ingress, deployed gateway compatibility, Slack delivery and single-sender cutover remain unverified. Keep Giskard disabled until those activation checks pass. For immediate rollback, unset `LIGHTESOTA_GISKARD_ENABLED` and restart through the operator's deployment process; existing UI and machine control paths are independent of this integration.
