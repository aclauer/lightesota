# One output authority: commissioning and migration

**Implemented software; no live cutover.** The always-on host and attended
commissioning are not confirmed. Current office sender/ODE configuration has not
been inspected or changed. Legacy HA may still transmit independently. In that
state Lightesota's Stop cannot force darkness against the other sender, and the
app does not claim shared Off works.

The target is:

```
HA entities / scripts ── authenticated HTTP ─┐
                                          ├─ Lightesota ─ Art-Net ─ ODE ─ DMX
Browsers ── authenticated WebSocket ─────────┘
```

There must be one active Art-Net authority. **Channelwise HTP is not valid for
laser or program/mode enums.** Taking maxima of two independently approved frames
can create an unapproved mixed command. Do not use the old HTP recommendation or
upstream frame merging as the integration mechanism. The HA component is a client,
not a second sender. This application never reconfigures the ODE or HA for you.

## Software gates

Physical output defaults to vetoed for **all installations**, including existing
saved settings that say Art-Net/Hue is enabled. Actual output needs the explicit
process environment `LIGHTESOTA_OUTPUT_COMMISSIONED=1`. The additional
`LIGHTESOTA_PREVIEW=1` veto always wins, even if the commissioning flag is set. It
is immutable for that process and cannot be removed by imports, settings, browser,
machine API or upstream data. Preview also blocks Hue pairing/transport and
upstream listening; it is the mode for UI/testing. No output should be enabled to
run the software acceptance tests.

On boot/restart/worker recovery/import, emitting state is not restored. Libraries
remain available; an operator makes a fresh Start. Lasers start disarmed and Off.
Disarm clears intents; Arm alone cannot emit an old or staged preset. Strong Stop
cancels queued writers and requires fresh intent. Temporary Blackout is a separate
wash mute. Laser Starts are refused while muted/released, and either edge clears
laser/haze intent; a fresh operator arm and Start is required after unmute.

Haze has a separate immutable process gate: `LIGHTESOTA_HAZE_COMMISSIONED=1` is
required in addition to whole-output commissioning, and cannot override preview.
It is **unset/false for this integration**. The retained card/profile/preview and
timed runs are future capability; default/migrated haze fixtures stay disabled,
and saved enabled fixtures remain blocked. Existing protected ranges and user
fixtures/layout are retained. Only the built-in 2CH Haze 4D profile at 51 is allowed;
ordinary overrides, patterns, identification flashes and custom profiles cannot
drive it. Neither UI, import nor API can commission a process.

Future haze commissioning requires separate building approval for detectors and
ventilation, attended physical testing, explicit review of protected 51–52 ranges
and fixture enablement, and only then a deliberately configured process restart.
The flag never clears protected ranges. Stop, global manual takeover, release,
disarm, mute and restart cancel haze; unmute never resumes it. Haze installation
and physical tests remain pending and are outside the single-sender cutover below.

## Later operator sequence (not executed)

1. **Choose the always-on owner.** Record host, supervised process/user, startup
   command, network route, maintenance owner, backups and physical control-loss
   procedure. Node/browser output state does not prove physical darkness; the ODE
   or fixture may hold a last frame during controller loss.
2. **Back up actual installed state** through the site's approved workflow: HA
   package/custom component/dependency and registry, dashboard, automations,
   Lightesota libraries/settings and relevant ODE configuration. Compare with
   current source; do not overlay the archived party fork or copy old saved room
   settings onto the user's layout.
3. **Validate isolated first.** Run Node suites and real HA configuration,
   lifecycle, service queue, registry and UI tests against a fake output preview.
   Keep effects physically isolated during future installation. Commissioning
   cannot be inferred from the historical genuine HA acceptance of a different
   pyartnet bundle.
4. **Retire the old sender before enabling the new one.** Disable legacy emitting
   automations, delayed scripts, helpers and direct pyartnet/Art-Net configuration.
   Cancel scheduled old actions; stop/unload the legacy sender by the operator's
   authorized process. Confirm through an approved observation that it is no
   longer sending; a grey HA entity alone is insufficient. Keep Lightesota's
   output veto in place throughout. If the previous Lightesota release is also
   running, retire that process as well. Do not intentionally run both for a
   comparison or rely on HTP.
5. **Install the client and reconcile IDs.** Follow the HA
   [component instructions](../../integrations/home_assistant/README.md). Preserve
   dashboard target entity IDs by explicit registry mapping; migrate script bodies
   and effect names. Ensure no active script references the retired sender.
6. **Commission the single sender.** With physical effects still under attended
   control, verify target universe/address/profile and the ODE's intended
   single-sender behavior. Any ODE change is a separate operator action; the app
   does not do it. Configure explicit authentication behind the proxy (tokenless
   localhost administration is removed), then only after the retirement checks, explicitly set
   `LIGHTESOTA_OUTPUT_COMMISSIONED=1` for the production process. Remove preview
   only for this separately authorized commissioning run. Boot remains dark.
7. **Test washes individually at modest intensity.** Confirm Normal/Music6/Music32,
   RGBW return to Normal, brightness-only retention, sensitivity255 and selected
   side behavior on each wash. W4 was historically verified; W1–W3 are not thereby
   accepted. Inspect the real emitted result and Stop/restart/control-loss outcome.
8. **Commission laser controls separately.** Keep the installation's approved
   geometry, 10CH addresses031/041 and physical S5 unchanged. Manual outputs use
   only Fan/Wave, existing colors, zoom53/tilt64 and bounded pan48–80; coordinated
   shows center pan64. Test disarm, Arm-only darkness, explicit preset Start,
   Stop/manual takeover, restart and each fixture's sound response. Built-in sound
   programs move independently and can change abruptly. No software test validates
   optics or emitted darkness.
9. **Record acceptance and ownership.** Verify one sender, operator access, legacy
   retirement, actual Stop outcome, recovery and chosen host persistence. Retain
   an attended rollback path. This source intentionally reports physical state as
   `unverified` and `legacySenderRetired:false`; no migration flag pretends the
   site was checked automatically.

## Address and output boundaries

| Fixture | DMX addresses (universe 0) | Scope |
| --- | --- | --- |
| W1 / W2 | 101–112 / 113–124 | Side A |
| W3 / W4 | 125–136 / 137–148 | Side B |
| Laser1 / Laser2 | 31–40 / 41–50 | Preset-only, explicit operator arm |
| Hazer | 51–52 | Separate process commissioning gate false; 51–52 held zero |
| Pinspots | 29 / 30 | Disabled/excluded from this work |

The wash 12CH order is dimmer,R,G,B,A,W,UV,strobe,macro,program,sensitivity,
dimmer-speed. Strobe off0/start16, macro0, Normal0/Music6=224/Music32=250,
sensitivity11–255 (initial255), dimmer-speed52. Control/enum bytes are never
interpolated. Optional intense/strobe pattern controls remain explicit opt-in;
the Party default is no strobe burst. Hue installation, mirror motor, Sonos,
Spotify and haze commissioning are outside this migration.

## Rollback order

If acceptance fails, use the attended physical isolation procedure first. Stop and
disable the **new Lightesota sender**, remove its commissioning flag and confirm
it is no longer active before restoring the backed-up old sender. Restore the
old package/registry/dashboard as one reviewed set; disable the new HA client and
its emitting actions to avoid misleading controls. Only then may the authorized
operator restart the old authority. Never restore both simultaneously. Saved
user libraries are preserved and should not be deleted to obtain a dark boot.

## Safe loopback review

After `npm run build`, from the repository root:

```bash
env LIGHTESOTA_PREVIEW=1 LIGHTESOTA_OUTPUT_COMMISSIONED=0 LIGHTESOTA_HAZE_COMMISSIONED=0 LIGHTESOTA_LOCALHOST_ADMIN=0 LIGHTESOTA_ADMIN_TOKEN="${LIGHTESOTA_QA_TOKEN:?set a disposable preview token}" HOST=127.0.0.1 LIGHTESOTA_DATA=../qa-data node server/dist/server/src/index.js
```

This invokes the built server directly and does **not** read `.env`. The process
veto prevents physical outputs regardless of data/settings. Use local synthetic
QA credentials supplied as `LIGHTESOTA_QA_TOKEN` via the parent's approved harness;
do not print this value or retrieve or copy live
auth stores. Tokenless loopback is disabled. The reviewer must terminate the
process after QA. No server is left running by this implementation worker.
