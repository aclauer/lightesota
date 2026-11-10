# Lighting integration changelog

## 2026-11-09 — live pattern color correction

The first live natural-language sweep reached the agent and started its new pattern,
but palette hex strings passed directly to `mix` became invalid numeric colors and
rendered black. `mix` now accepts those strings as well as its existing RGB arrays,
using the same hex conversion as the rest of the renderer. The sandbox regression
reproduced black output before the fix and verifies finite, moving blue/cyan output,
15% dimming and no strobe afterward. Existing numeric RGB behavior is unchanged.
The full application tests, typechecks and build passed. No transport, permissions,
provider, fixture settings or saved patterns are changed by this correction.

## 2026-11-09 — natural-language lighting requests (source; parent rollout pending)

Giskard gains `lighting_request`: teammates can ask for a moving look without supplying
fixture or preset IDs. The existing Lightesota lighting agent creates new sandboxed
patterns, applies them and exposes owned progress/completion through `lighting_state`.
An accepted request is explicitly not a completed or physically verified change. The
existing typed `lighting_apply` and `lighting_stop` remain available.

One request uses the original one-use lease and remaining deadline. Stop, takeover,
cancel, expiry and restart prevent later effects; no queued work resumes after restart.
Remote tools have a fixed allowlist and copy saved patterns instead of overwriting owner
work. Whole-rig pattern Start includes Hue gradients and manually owned washes. Typed
laser control requires prior operator arming; pattern Follow and existing geometry/strobe
guards remain. Haze must remain disabled at process/output level. No browser admin role,
raw DMX, OS/network capability, scheduling, provider change or UI/data migration is added.

Parent acceptance passed: 172 server tests, 15 web tests, 27 relay tests, 9 HA
wrapper tests, 6 deployment tests, 18 plugin tests and 17 HA integration tests;
22 connector/bridge tests also passed with real loopback sockets and hardware vetoed.
Shared/server/web typechecks and full application/relay builds passed. The actual Hermes
PluginManager and both middleware chains loaded all four tools in an isolated home;
acceptance versus completion, shared one-attempt authority, status IDs and stale/missing
Slack context were verified without changing the real Hermes configuration.

These are software checks, not physical fixture observations. Coordinated HA/relay/plugin
deployment and the live Slack lighting/Stop acceptance follow publication. The accepted
connector ACK recovery correction below is preserved.

## 2026-11-09 — connector recovery correction

The HA connector now keeps its still-valid fenced session after a lost result-upload
acknowledgement instead of unnecessarily entering a session-replacement gap. It abandons
the failed transfer without replaying the command or any result chunk. Authentication,
protocol/storage failures, expiry, shutdown, Stop fences and durable receipts keep their
existing handling. No deadline was increased.

The parent verified 21 connector/bridge tests with real loopback sockets and hardware
outputs vetoed, plus shared/server/web typechecks and the full application build.
Production logs showed a successful Stop result followed by session-replacement conflicts
during the failed follow-up read; the exact lost-ACK mechanism is reproduced in tests,
not claimed as conclusively observed on HA. This change affects the HA connector only;
Andrew's UI, saved lighting data, provider settings and Vercel runtime are unchanged.
Live deployment and ordinary-light activation are being accepted separately below.

## 2026-11-09 — software live; physical output remains disabled

Lightesota on Home Assistant now uses company-authorized DeepSeek Flash at maximum
reasoning. Its actual app conversation completed `get_show_state` and a final answer.
Giskard's three-tool lighting plugin is enabled in the hosted gateway; no general-purpose
tools or unrelated source permissions were enabled. Production does not depend on a laptop.

The relay representation fix is deployed. Real private-store tests passed for small and
large JSON, exact original ETags, conditional writes, stale-write rejection and concurrent
writers. The authenticated Giskard-host → Vercel → HA path passed state / Stop / state.
A real authorized Slack mention also completed state and Stop, advancing the controller
generation. Its immediate follow-up read failed closed; a later fresh Slack state request
succeeded and confirmed that same stopped generation. This is a known intermittent
availability limitation, not a claim that every request succeeds. Unauthenticated access
returns HTTP 401. Requests with uncertain outcomes are not automatically replayed.

Physical output and haze remain uncommissioned/disabled. No light-on or physical fixture
acceptance was performed; ordinary-light Apply stays blocked until separate commissioning.
Andrew's UI, scenes, patterns and saved data were not changed by these relay fixes.

The serving deployment still includes a successful build-only storage probe, which is not
an HTTP route or runtime import, plus rate-limited nonsecret diagnostics. Removing those
requires a fresh Vercel identity verification; the optional cleanup was cancelled rather
than interrupting the working deployment or blocking this software launch.

The dated entries below retain the state of each earlier checkpoint.

## 2026-11-09 — live DeepSeek acceptance and relay representation fix pending cloud acceptance

DeepSeek Flash completed a read-only `get_show_state` tool call and the final assistant
answer inside the deployed HA Lightesota app at maximum reasoning. The saved conversation
and provider health both confirm completion; this does not verify physical lighting.

Parent's cloud probe reproduced conditional-write rejection after compressed larger JSON
reads returned weak ETags; identity reads returned the same content with strong tags
matching creation PUTs. The relay now requests `accept-encoding: identity` through SDK
2.9.0's supported GET headers option and forwards the same read's raw ETag unchanged to
CAS. Offline regressions cover compressed rejection and identity-read CAS. Optional
diagnostics retain their existing limits. Identity-read cloud GREEN and SFO1 relay
acceptance remain pending; Slack lighting is not yet verified. Credentials, receipts,
deadlines and safety rules are unchanged. Physical outputs remain disabled.

## 2026-11-09 — Nous repeated completion metadata (live read-only acceptance passed)

The exact verified Nous endpoint can now repeat the same stream finish reason with only
inert metadata: assistant role, empty content and null reasoning. Changed reasons, new
text/reasoning, tool deltas and unknown delta fields still fail closed; other endpoints
retain their strict completion behavior. Tools remain unavailable for execution until
stream termination and complete validation. Offline regression tests reproduce the captured
empty-argument tool stream. The subsequent live HA acceptance completed the read-only tool
and final answer, as recorded above.

## 2026-11-09 — relay candidate accepted locally; activation remains separate

The bounded Vercel relay and HA outbound connector passed the full application tests,
typecheck/build, relay tests/build, HA wrapper and integration tests, and seven real
loopback bridge tests with hardware transports vetoed. The final plugin passes all
16 tests plus the real Hermes loader/middleware and real HTTP preview checks for
selected targets, duplicate denial, durable Stop and fresh trusted-message admission.
No UI, saved lighting data or physical commissioning defaults were changed.

A real company-key tool/result round trip also verified the exact DeepSeek Flash model
with maximum reasoning. Nous direct inference ends completed streams at clean EOF rather
than `[DONE]`; the parser now accepts this only for the verified Nous endpoint after an
explicit valid finish reason, retaining truncation, cancellation and protocol rejection.
The company's private Vercel store passed uncached-read and concurrent conditional-write
checks. These results do not establish deployed relay latency, Slack ingress or physical
lighting: the connector/plugin remain disabled until their live acceptance, and the
running provider is not considered switched until Lightesota's own loop succeeds.

## 2026-11-09 — trusted Slack message freshness (source, hosted acceptance pending)

The Giskard plugin now rejects malformed, stale or excessively future trusted Slack message
timestamps before event receipt claims, authority requests or lighting tools. It requires
canonical ASCII message `ts` and a finite wall clock, with inclusive limits of 120 seconds old
and 30 seconds ahead. The timestamp is hashed unchanged; a separate wall-clock dependency
keeps existing monotonic lease timing intact. Long inference, continuation and restart cannot
refresh an old message. Fresh authorized state/Stop still work if lease or receipt storage fails.

Deterministic red/green plugin tests close the source-level unseen-old-event hold. Hosted
message-`ts` metadata, wall-clock accuracy and middleware acceptance remain parent-owned.
Bridge/server/HA/provider source, lockfiles, tool schemas, durable receipts, Andrew's data and
physical commissioning gates are unchanged; no live deployment or hardware claim is made.

## 2026-11-09 — final bounded bridge review fixes (source, acceptance pending)

First mailbox initialization now survives a failed startup and process restart using a
small durable pending/established state in the existing SQLite ledger. Confirmed mailbox
observation is committed before polling; established or legacy ledgers cannot recreate a
lost mailbox, even with zero receipts. Unknown or corrupt state remains disabled.

An admitted Stop now survives caller disconnect or a lost admission acknowledgement within
its unchanged deadline. Success still requires backend acknowledgement. Definite refusals
before any admission CAS return without a cancellation read or uncertainty delay; attempted
writes remain outcome unknown across SDK conflict echoes and retries. Ordinary cancellation,
receipts, Stop fences, credentials and physical output vetoes remain intact.

Focused red/green tests cover these three findings. Parent retains real socket, full-suite,
private-store and hosted-ingress acceptance. No gateway schema, inference configuration,
Andrew's data or commissioning setting changed; no publication or live deployment is claimed.

## 2026-11-09 — bridge reliability follow-up (source, acceptance pending)

The outbound connector now recovers automatically after startup failure or a cloud outage,
using bounded backoff and a fresh fenced session while retaining exclusive SQLite ownership.
It never resends an uncertain operation, lease or result. Shutdown cancels retries; invalid
configuration or durable storage failures still require review. Cloud admission hashes now
expire after 130 seconds instead of exhausting a lifetime 2048/512-entry limit. Permanent
attempt receipts remain in HA and trusted event receipts remain in the gateway; the
[bridge notes](../integrations/giskard-relay/README.md#protocol-bounds-and-failure-semantics)
describe the ingress dependency for requests that never reached HA.

Adapter tests now use the installed Blob 2.9.0 error classes; only a recognized precondition
conflict permits a CAS retry. Genuine red/green regressions cover recovery, SDK error
classification and 2,055 completed lease flows with a bounded mailbox. Parent reports the
five original socket tests passed with hardware veto; private-store, expanded socket,
deployed ingress and live acceptance remain parent-owned. No physical outputs, inference
settings, Andrew's data or commissioning gates changed.

## 2026-11-09 — bounded Giskard Vercel ↔ HA bridge (source, acceptance pending)

Added a separate [Node relay package](../integrations/giskard-relay/README.md) and a
default-disabled outbound connector inside the existing HA Lightesota process. Only
the four ordinary-light API operations cross the bridge. A private, production-only
Blob mailbox uses uncached origin reads and ETag CAS, with separate Stop capacity,
strict Slack admission, fixed deadlines and no automatic mutation retry. The connector
commits persistent SQLite attempt receipts before loopback dispatch, and the existing
protected router checks an optional one-use deadline/fence permit immediately before
effects. Stop fences older queued leases and results; success requires backend acknowledgement.

New HA options are `giskard_relay_enabled`, `giskard_relay_origin` and password field
`giskard_connector_token`. Absent options remain disabled. Three distinct credentials
separate Giskard, relay and backend access. No generic tunnel, admin proxy, UI, scheduler,
extra model tools, inference changes or lighting sender were added. Andrew's features,
attribution, saved data, existing leases/generations, authentication and hazard gates remain.

Offline regressions exercise real relay/connector/router behavior over Node HTTP streams,
durable receipts, Stop/deadline races, CAS conflicts and ambiguous commits. Actual loopback
listening is blocked by this sandbox (`EPERM`); a parent-run socket selector is supplied.
At initial implementation the pinned Blob SDK could not be installed offline (`ENOTCACHED`);
parent subsequently installed it for the reliability follow-up above. Adapter tests still
do not establish Vercel store behavior. Review, commit, publication, production/private-store
setup, live Slack acceptance and onsite commissioning remain parent-owned. Nothing in this change enables outputs or haze or claims observed light.

## 2026-11-09 — event branch reconciliation and HA wrapper (source only)

Reconciled main candidate `f9744dc76b893e9a55bcdc12d4e25c6d287955e2` with Andrew's
event-deployed `104a61ba9884a6ae0270b36cacc19f35a63bf6e1`. Andrew's Live agent column
keeps its prompt, working indicator and latest reply without a transcript picker. The
actual provider, pinned Hermes model and configuration/reachability/result status appear
in that panel, with preview/setup prompt gates. The superseded floating agent tile is removed.
The pattern editor's Ask agent shortcut now opens that Live panel instead of falling through
to Settings; the broken and corrected click paths were exercised in the real preview.

Gradient strip expansion, Hue v2 gradient transport and strip order, ring primitives,
Warm to White Sweep and Ring Runner, segmented stage preview, and strip overrides/flash/solo
are retained. Saved strip IDs remain control targets; virtual segments stay internal to
rendering. Manual washes, finite shows, Stop/generation guards, laser boundaries, protected
haze channels, commissioning, strict authentication and the complete Hermes transport remain.
Stop now aborts actual pending Hue HTTPS requests, including v2 discovery, so late discovery
cannot launch a stale write. CA verification and bridge identity checks apply to v1 and v2.

The actual [HA manifest](../ha-app/config.yaml) and [entrypoint](../ha-app/run.sh) now map
the Hermes/Giskard and physical commissioning options. New Giskard credentials/identities
default empty; Giskard, physical output and haze default disabled. Secrets use HA password
fields and are passed as process data without shell evaluation or logging. Old saved HA options
also receive these closed gates. Existing Anthropic options and saved model/effort remain
until an explicit provider selection; no saved lighting data is replaced.

The [deployment script](../ha-app/deploy.sh) targets `/local_apps/lightesota`, archives one
immutable commit including its manifest, ships only the root manifest, requires known-host
SSH verification and honors local `TMPDIR`. It retains previous source outside HA's scan
root under `/share/lightesota-deployments` and skips seed data whenever `/share/lightesota`
already exists. Build/start errors are surfaced. The script has only received static/syntax
checks here; it has not been invoked. Restoring retained source and rebuilding remains an
operator action after a failed build/start.

This source revision does not by itself deploy or activate the integration. The existing HA
source and saved data were backed up before rollout; Giskard's plugin files are staged but
remain disabled. Company inference authorization, a protected cloud-to-HA route and a real
Slack acceptance check are still required. The built-in Hermes proxy has no auth; its supported
command is `hermes proxy start --provider nous --host 127.0.0.1 --port 8645` and it must not be
exposed directly. See [actual HA setup](../README.md#run-it-on-home-assistant).

Current local verification passes 133 server tests (all 123 main tests, two event tests and
eight new regressions), 15 web tests, 13 plugin tests, 17 HA adapter tests and eight wrapper
tests, plus typecheck and production build. Six deployment checks inspect policy and shell
syntax without executing the script. Hardware I/O is blocked by the preload guard or replaced
with fake transports before commissioned-policy cases execute.
Red/green logs cover the provider panel, strip controls/API, Hue cancellation and wrapper
mapping/worker launch. The final built Live/Settings UI was inspected at desktop and mobile
widths in both themes, including the scrolled mobile provider controls and disabled preview
states; no clipping, horizontal overflow or runtime/console errors were found. These are
software checks with hardware transports vetoed, not live inference or fixture commissioning.

Offline npm cache analysis identifies the existing high advisory as `zod@3.25.76`,
`GHSA-mrhx-c7xc-m3w5`, via Anthropic's optional production peer dependency. Dependencies
and lockfile are unchanged; a compatible dependency update remains separate work. The build
also retains Vite's non-failing warning for the roughly 515 kB CodeEditor chunk.

The dated sections below record earlier verification and its limits; they do not claim this
reconciliation has been deployed.

## 2026-11-07 — Hermes inference and bounded Giskard API (for Andrew)

Added a small fetch/SSE adapter for the separate Hermes Nous subscription proxy.
New configurations pin `deepseek/deepseek-v4.1-flash-1017`, max reasoning, thinking
enabled and the existing 32,000-token budget; failures never select another model
or provider. Existing Anthropic settings/history and explicit rollback remain.
The existing private conversation UI, guest quotas, tool/compiler boundaries,
twelve-round loop and original generation capture are preserved. Stop now also
cancels pending inference from every existing control path. Provider status shows
configuration separately from reachability and completed inference.

Added four dedicated Giskard POST routes for sanitized state, a pre-inference
120-second one-use lease, one validated ordinary-light batch, and durable Stop.
They reuse `ShowController`, add no output sender, require a separate bearer plus
exact Slack identity allowlists, and reject hazards, strobe/code/URL controls,
stale/replayed actions and uncommissioned apply. The Giskard token cannot enter
existing browser/HA authorization, including accidental token reuse. Blackout,
release and zero master are reported honestly and never lifted by these commands.

Andrew's latest work at `d0bcaa4f43b3595831cf7c26090522ec206d4384`, including
verified Hue TLS and balcony patterns, remains unchanged and retains his
attribution. Existing fixture IDs/layouts, wash modes, effects, show classes,
laser/haze boundaries, patterns and physical-output policy remain in place.

Configuration is environment-only for proxy URL/key and Giskard credentials.
See [Hermes setup/rollback](hermes-inference.md), the exact
[Giskard API/gateway contract](giskard-lighting.md), Compose passthrough and
`.env.example`. **Giskard defaults disabled and must stay disabled until the
single-sender cutover is verified.** Company Nous authorization is operator-owned;
Ari's private subscription must not power the shared office app. Preview still
permanently blocks all physical output and production provider requests.

The [native Hermes plugin](../integrations/giskard/README.md) adds only state,
one bounded ordinary-light apply and Stop. Identity comes from trusted Slack
metadata, not model arguments. Stable event hashes, runtime-bound one-use leases
and durable SQLite receipts prevent retries or gateway/backend restarts from
re-authorizing an old Slack message. Storage failure blocks new apply authority;
authenticated state/Stop remain available. Keep the receipt database on upgrades.

Meaningful RED/GREEN covered the adapter, service, configuration, API and replay
boundaries. All **123 server tests, 14 browser-helper tests and 13 plugin tests
pass**, along with typecheck and production build. The plugin also passed the real
Hermes loader/request/tool middleware in a throwaway profile and 14 checks against
the real loopback preview HTTP server. Built Settings/Agent views were inspected
at desktop/mobile widths in light/dark themes with no horizontal overflow or
console errors; provider/status contrast and empty-chat mobile scrolling were fixed.
Tests use fake provider transports, isolated storage and permanently blocked
physical outputs. Live Nous inference, protected cloud networking, deployed plugin
compatibility, Slack delivery and physical lights remain unverified. The HA add-on
wrapper was still missing this configuration at that checkpoint; the 2026-11-09
reconciliation above adds it to source. No live provider was switched by these source changes. Rollback is an explicit
Anthropic selection; Giskard can independently be disabled by unsetting
`LIGHTESOTA_GISKARD_ENABLED` and restarting through the operator's deployment controls.

This records the scoped integration and correctness fixes for Andrew's review.
The live deployment, HA configuration, ODE, devices, accounts and credentials have
not been changed. Publication does not commission physical output.

## Added or fixed by this integration

- **Selected washes:** independent Off / Normal / Music6 / Music32, RGBW,
  brightness and microphone sensitivity. Side A is W1/W2; B is W3/W4. The 12CH
  map is corrected to dimmer, R, G, B, A, W, UV, strobe, macro, program,
  sensitivity, dimmer speed. CH8 strobe defaults Off; CH9 macro is zero.
  Music programs use 224/250, sensitivity defaults to 255 and dimmer speed to 52.
  RGBW selects Normal; brightness alone preserves Music. Unselected washes retain
  their state. Party strobe bursts default Off.
- **Looks and finite shows:** Warm Arrival, Cyan/Magenta sides, Calm Blue, selected
  Music6/32 and an explicitly guarded laser duo; Neon Exchange, Call and Response,
  and Build and Release on the existing BPM clock. Shows default to washes only,
  180 seconds and a modest 25/255 ceiling, then stop their owned output.
- **Stop and ownership:** shared Stop cancels automated and queued writers;
  global manual takeover holds washes and clears effects. Restart/import/recovery
  starts dark. Generation and source guards reject stale browser, API and AI work.
  Temporary wash mute remains reversible. Laser Starts while muted/released are
  rejected before state changes; unmute cannot activate staged laser intent.
- **HA and laser permissions:** authenticated REST and the HA client use the same
  command path as the browser. Four wash and two laser light IDs have explicit
  [migration mappings](../integrations/home_assistant/README.md#existing-entity-ids-and-dashboard-migration).
  Laser arming is a dedicated administrator button, with no restorable arm switch;
  native saved scenes cannot press it, and scripts/automations cannot arm. Armed
  status is read-only on the existing sensor; a separate Disarm button remains
  available to control clients. Arm alone stays dark. Pattern lasers require an
  operator's explicit Follow for the loaded source; no geometry expansion or
  hardware-interlock claim is made.
- **Haze remains uncommissioned:** Andrew's capability is retained behind a
  separate process gate. Channels 51–52 stay zero, new/migrated haze fixtures are
  disabled, and an already-saved enabled fixture remains blocked. Arm/start,
  validation, cancellation and browser queues share the guarded command path.
  Pinspots remain disabled by default and excluded from this integration.

## Andrew's work preserved

The existing room preview and clipped dual-aperture laser geometry, Spread
controls, laser looks, typed pattern laser sections and badges, built-in patterns,
AI tools, and new haze profile/card/preview/timed runs remain. Existing scenes,
playlists, custom pattern libraries, fixture IDs, saved user fixtures, placements,
layout and protected ranges are retained. Only exact historical wash side tags
are migrated; saved layouts are not replaced.

## Deployment changes and remaining gates

All installations now require `LIGHTESOTA_OUTPUT_COMMISSIONED=1` for physical
transport. `LIGHTESOTA_PREVIEW=1` always vetoes it. Haze additionally requires
`LIGHTESOTA_HAZE_COMMISSIONED=1`; this remains unset/false and cannot be changed by
UI, import or API. It cannot override preview, whole-output veto or saved channel
protections. Haze building approval and attended physical testing are still pending.

Tokenless localhost administration is removed; operators need explicit browser
credentials and HA needs Bearer credentials. The [HTTPS/proxy instructions](deployment/https.md)
cover WebSockets and browser microphone secure contexts. No host, certificate or
DNS changes have been made. The [single-sender cutover and rollback procedure](deployment/migration.md)
requires an always-on host and retirement of the legacy direct HA sender before
Lightesota is commissioned. HTP dual controllers are not a safe integration.

## Verification

- 74 server tests, 11 browser-helper tests and 17 Python adapter unit tests pass;
  typecheck and production build pass.
- Genuine isolated HA: 121 checks pass, including native scene replay,
  script-context denial and restart without arm replay. One upstream HA/aiohttp
  deprecation check still fails, so the strict harness exits 1; it was not suppressed.
- Real HA-to-loopback REST: 15 checks pass, including shared Stop, state refresh,
  the non-restorable arm boundary and availability reporting in preview.
- The final built UI was inspected on desktop and mobile in light and dark themes.
  Selected-wash control, explicit laser Start, blackout without laser replay,
  shared Stop and the disabled haze controls/reason were exercised. No console
  errors or horizontal overflow were observed. The saved acceptance scene remained
  byte-identical across the update.

All execution used isolated data and permanently blocked physical transports.
These checks do not establish live HA dashboard rendering, production TLS,
physical lighting behavior or commissioning.
