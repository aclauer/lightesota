# Lighting integration — 2026-11-06

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
wrapper is separate from this repository's Compose file and still needs the new
configuration; no live provider has been switched. Rollback is an explicit
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
