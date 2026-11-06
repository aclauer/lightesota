# Home Assistant → Lightesota

This custom component is a REST client of Lightesota. It has no Art-Net, DMX, Hue,
ODE, audio or pyartnet transport. Lightesota owns the final output and uses the
same validated commands for its browser and this adapter. Installation is a future
operator action; no live migration has been performed.

## Install and configure

1. Complete the [single-sender migration gates](../../docs/deployment/migration.md).
   First validate with fake output and the process preview veto.
2. Copy `custom_components/lightesota/` into HA's `/config/custom_components/`.
   Merge [example.configuration.yaml](example.configuration.yaml) into the HA
   configuration. This is a YAML integration; restart HA after an approved install
   or configuration change. It creates entities even when the service is initially
   offline and recovers through polling.
3. Put `lightesota_url` (an HTTPS origin), `lightesota_control_token` (Lightesota's
   guest control token), and optionally `lightesota_operator_token` (admin token)
   in your own HA `secrets.yaml`. This repository contains no credentials. The
   guest sharing permission must be **control** or **edit**, not view. Supplying
   only the control token creates wash controls and Stop/manual actions; laser
   entities stay unavailable without an operator token and the arm button is absent.
4. Reconcile entity IDs as described below, then optionally merge
   [example.package.yaml](example.package.yaml) and
   [example.dashboard.yaml](example.dashboard.yaml) into the existing Office
   Lighting experience. Do not stack them over an active legacy output package.

Only one Lightesota server is configured per HA instance. `wash_fixtures` and
`laser_fixtures` map actual Lightesota fixture IDs; defaults are `w1`…`w4` and
`l1`,`l2`. Disabled/missing fixtures are unavailable. Polling defaults to 2 seconds
(1–30 configurable), with an 8-second request timeout. TLS uses HA's normal trust
store; certificate verification is never disabled and redirects are not followed.

## Controls and semantics

| Entity / action | Behavior |
| --- | --- |
| `light.office_dmx_w1` … `w4` | Independent RGBW, brightness 0–255, effects `Normal`, `Music6`, `Music32`. Brightness-only retains Music; RGBW forces Normal. Off holds that fixture Off against patterns. Generic On from Off uses Normal and remembered intensity, default 25/255. |
| `number.office_dmx_w1_mic_sensitivity` … `w4` | Integer 11–255, initially 255. Changes sensitivity without changing mode or starting a stopped wash. |
| `button.office_dmx_w1_release_to_pattern` … `w4` | Explicitly releases that wash to the current pattern. |
| `light.office_laser_1_preset`, `light.office_laser_2_preset` | Allowlisted effects `Fan cyan`, `Wave magenta`, other existing single colors, and `Music multicolor` / `Music cyan` etc. Requires operator token, admin HA caller and existing software arm. Generic On without a named effect is rejected. No brightness control, raw bytes or automatic arm. |
| `number.office_laser_1_pan`, `…2_pan` | Bounded 48–80; operator only. Changing pan while Off never supplies a Start/mode. Manual preset actions use centered 64; zoom53/tilt64 and no dedicated strobe. |
| `button.lightesota_operator_laser_arm` | A dedicated press, never scene-restorable state. Requires an HA admin, no parent Context and an empty native script stack. Native `scene.turn_on` / `scene.apply` cannot press it; scripts/automations cannot arm. Arm alone emits nothing; make a new explicit preset action. |
| `button.lightesota_all_lasers_off_disarm` | Clears laser intent and disarms (also cancels haze). Uses the control token, including from scripts, while the API is reachable. |
| `button.lightesota_stop_lighting_all_off` | One shared strong Stop: cancels writers, clears effects and disarms. Does not depend on six sequential light Off calls. Available whenever the control service is reachable, including preview/released output. |
| `button.lightesota_take_manual_control` | Cancels automated writers, holds current washes, clears/disarms lasers. Direct per-wash adjustment takes over only the selected wash. |
| `sensor.lightesota_control_status` | Read-only `lasers_armed` attribute, authority, generation, Stop/blackout/run state; available while the API is reachable, even if physical output is uncommissioned. |

The API state is **commanded state, not observed physical output**. Connection,
authorization, timeout or malformed-state errors mark the client unavailable;
HA does not keep reporting available lamps from stale data. Preview,
uncommissioned and released output also make light entities unavailable.
Disconnection never guarantees a physical stop. HA restarting does not replay
saved On states or the arm button timestamp; reconnect only fetches state and never resends failed commands.

Every mutation uses the current server generation. HTTP409 refreshes state and
reports a stale-action error without retrying the mutation. The client captures
generation before waiting on its request lock. Native multi-target HA actions may
continue their own acknowledged commands under the same HA Context only; Stop,
manual/disarm and external generation changes invalidate that continuation. HA
ULID Context timestamps older than the server's control boundary are rejected.
Reusing an old Context after Stop is rejected; issue a new action. Clock skew can
reject valid actions conservatively: keep the HA/server system clocks aligned.
Unrelated external producers or forged contexts are not authenticated by HA
Context IDs; the server's generation/role checks remain the authority.

**Music6/32 means fixture microphones.** These are independent, not shared BPM or
Spotify/Sonos capture. Sensitivity is a wash setting; laser sensitivity is the
physical **S5** menu at addresses **031/041**, with no DMX sensitivity channel.
Only W4's microphone behavior was historically verified physically. The new
software has not physically validated W1–W4 or either laser. Shared-clock finite
shows are staged and started in Lightesota; they do not arm lasers. Laser Starts
are rejected while muted or released in the shared server path. Unmute clears
laser intent; fresh operator arm and Start are required. Wash mute/resume is retained.
These are software permissions, not a hardware interlock.

## Existing entity IDs and dashboard migration

New unique IDs are `lightesota_w1`…`lightesota_w4`, `lightesota_l1`,
`lightesota_l2`. The new arm button uses unique ID `lightesota_laser_arm`;
Disarm uses `lightesota_lasers_off`, and status remains `lightesota_control_status`.
The never-deployed candidate arm switch/platform has been removed; this change
performs no live HA registry operation. They do **not** adopt legacy pyartnet registry entries. The names
suggest the historical entity IDs, but HA may append `_2` on collision.

During the approved isolated maintenance window:

1. Export/back up the real HA registry, package, dashboard and automations. Record
   each old entity ID and unique ID. Disable old emitting automations/scripts,
   remove their active sender configuration, and verify the old process is no
   longer transmitting **before** enabling Lightesota output.
2. With output still vetoed, rename the old registry entries to an unambiguous
   `_legacy_disabled` suffix (or remove only the retired unavailable entries after
   backup). Assign the new entities their exact IDs using HA's entity settings:

   | Legacy entity ID to retain | New component fixture ID |
   | --- | --- |
   | `light.office_dmx_w1` | `w1` |
   | `light.office_dmx_w2` | `w2` |
   | `light.office_dmx_w3` | `w3` |
   | `light.office_dmx_w4` | `w4` |
   | `light.office_laser_1_preset` | `l1` |
   | `light.office_laser_2_preset` | `l2` |

3. Existing brightness and RGBW light cards can keep these target IDs. Change
   wash effect actions to the exact strings `Normal`, `Music6`, `Music32`. Remove
   RGBW/transition from music actions. Update old microphone helpers/actions to
   the corresponding new `number` entity (11–255). Side A is W1/W2; B is W3/W4.
4. Replace old All DMX Off / Stop effects script bodies with a press of
   `button.lightesota_stop_lighting_all_off`; preserve each site's script entity
   IDs if dashboards already reference them. Replace manual-takeover action with
   the new button. Do not leave a delayed legacy script or helper listener capable
   of calling the old sender. Legacy pinspot/haze actions are excluded, not mapped.
5. Replace legacy laser enable helpers with the explicit operator arm button and
   map only approved presets to the new effect names. A generic saved HA scene
   cannot arm. Unknown legacy preset names must be mapped manually; the old 415
   menu entries are not silently replicated. Pan remains a compact number control.
6. Check the actual assigned IDs in the package/dashboard, including sensitivity,
   Stop, Disarm and Arm. The guarded-duo package reads the status sensor
   `lasers_armed` attribute; it never presses Arm. Run a **genuine isolated HA** config/lifecycle/registry and native
   desktop/mobile light/dark UI acceptance with fake outputs before live rollout.

## Machine API

`GET /api/control/state` and `POST /api/control/command` require
`Authorization: Bearer …`; neither query tokens, browser cookies nor tokenless
loopback administration authenticate these routes. Use HTTPS. Do not place
credentials in URLs, logs or exported evidence.

Successful GET and POST both return the direct state object with `generation`,
`controlledAt`, `washes`, `lasers`, `rig`, `available`, `blackout`, `stopped`,
`coordinatedShow`, and `ownership`. `ownership.physicalState` remains `unverified`;
`legacySenderRetired: false` explicitly avoids claiming a site cutover.

Example POST bodies (replace the generation with the latest GET/response value):

```json
{"generation": 123, "command": {"type": "setWash", "fixtureIds": ["w1", "w2"], "patch": {"mode": "music6", "brightness": 38, "sensitivity": 255}}}
```

```json
{"generation": 124, "command": {"type": "stopLighting"}}
```

Normal RGBW uses `patch: {"mode":"normal","brightness":25,"rgbw":[0,0,255,0]}`.
Explicit release is `{"type":"releaseWashes","fixtureIds":["w1"]}`; common
manual takeover is `{"type":"takeManualControl"}`. The server returns401 for
missing/invalid Bearer,403 for insufficient role,409 for stale intent and400 for
invalid commands. Treat all non-2xx as failure; never silently retry an emitting
action. Safe Stop is accepted independently of stale generation on the server.

## Offline validation

From the repository root:

```bash
../.ha-test-venv/bin/python -m unittest discover -s integrations/home_assistant/tests -v
../.ha-test-venv/bin/python -m compileall -q integrations/home_assistant/custom_components/lightesota
```

Tests use in-memory HTTP transport and explicit HA doubles. They exercise real
client/parser/entity methods, errors/offline state, generation queues, native
multi-target context continuation, Stop invalidation, role gates, mode mapping and
selected-fixture commands. They create no sockets or physical output.

Genuine isolated Home Assistant 2026.11.0 / Python 3.14.7 acceptance also exercises
native setup, schemas, registry, service dispatch, script contexts, saved-scene
reproduction and restart with an in-memory backend session. Native HA does not
press the arm button during `scene.turn_on` or `scene.apply`. The known HA/aiohttp
Application-subclass deprecation remains a separate diagnostic failure; it is not
suppressed or counted as a functional pass. See the dated
[change log](../../docs/lighting-integration-changelog.md) for final checks.
No live HA, TLS, devices or physical commissioning are established by these tests.
