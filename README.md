# Lightesota

A web console for the office lights. One Node process drives the DMX rig over Art-Net,
renders a live top-down preview, keeps scenes and playlists, serves a shareable control page for
phones, and hosts a Claude agent that writes new lighting patterns on request.

```
Browsers (laptop, iPhone, friends) ──WebSocket──▶ server ──Art-Net──▶ ENTTEC ODE ──DMX──▶ washes + pinspots
                                                    │  └─Hue REST──▶ Hue Bridge ──▶ strips
                                                    └─ Claude API (agent writes patterns)
```

## Run it

Node 22 is required. On this machine it comes from nix:

```bash
nix-shell          # or: nix develop
npm install
LIGHTESOTA_PREVIEW=1 npm run dev  # permanently veto physical output in this process
```

Open http://localhost:5173 during development and authenticate explicitly. Tokenless
loopback administration is disabled, including through reverse proxies.

Production build and run (serves the built UI from the same port):

```bash
npm run build
LIGHTESOTA_PREVIEW=1 npm start  # http://localhost:8787, physical output vetoed
```

Or with Docker (host networking so UDP reaches the ODE):

```bash
docker compose up -d --build
```

Configuration is by environment variables, see [.env.example](.env.example). A `.env` file in the
repo root is loaded automatically by `npm start` and `npm run dev` (it is git-ignored). The agent
needs `ANTHROPIC_API_KEY` there; restart the server after adding it. Everything the app
stores (rig, scenes, playlists, your patterns, agent chats, share tokens) lives in `data/` as
JSON and JavaScript files.

## Output ownership and commissioning

The server starts with the office rig from the lighting notes: four SlimPAR Pro H washes in 12CH
at 101/113/125/137, two Saber Spot pinspots at 29/30 (not on the DMX chain yet, so they start
disabled and excluded from this integration), two Scorpion Dual RGB ILS lasers at 31/41
(see [Lasers](#lasers)), a Hurricane Haze 4D at 51 (see [Haze](#haze)),
Art-Net to 10.10.0.204 universe 0.

Lightesota is the intended single output authority; Home Assistant becomes an authenticated
API client through the [HA component](integrations/home_assistant/README.md). **No live cutover
has occurred.** If a legacy sender remains active, shared Off cannot be guaranteed. Channelwise
HTP merging is invalid for laser frames and program/mode enums; it can combine individually
approved frames into a different command. Do not use HTP or upstream merging for this integration.

All installations default to a process-level physical-output veto, including existing saved
settings. Actual transport requires `LIGHTESOTA_OUTPUT_COMMISSIONED=1` after explicit operator
commissioning and old-sender retirement. `LIGHTESOTA_PREVIEW=1` always overrides that flag and
cannot be disabled by settings, imports or API calls. Boot keeps libraries and starts output
dark/disarmed. Follow the [migration and rollback procedure](docs/deployment/migration.md),
including the exact safe loopback preview command. The DMX monitor shows commanded bytes,
not observed light or proof of delivered darkness.

## Using the console

- **Live**: the room preview, the active pattern's parameters as sliders, crossfade, speed, master,
  quick scene buttons. Tap a fixture to solo it, flash it, or override its color.
- **Patterns**: pick a look. Editors can open the code editor; `⌘S` saves and reloads the live
  pattern with the current parameters.
- **Scenes**: saved looks (pattern + params + BPM + master + independent wash modes). Hotkeys 1–9, favorites.
- **Playlists**: timed sequences of scenes in bars or seconds, loop/shuffle.
- **Agent**: describe a look; the agent writes the pattern, test-renders it, applies it and exposes
  the tunable parts as parameters. Needs `ANTHROPIC_API_KEY` on the server.
- **Stage**: drag fixtures to where they hang, set addresses and tags, add Hue lights.
- **Settings**: Art-Net target, output ownership, Hue pairing, share links with QR code, theme,
  export/import, DMX monitor.

**Stop lighting / All Off** cancels automated writers and pending intents, clears effect output
and disarms. A fresh Start is required. **Blackout** is a separate temporary mute; laser output
requires an explicit operator restart after release. Per-wash Off/Normal/Music6/Music32 and
manual ownership preserve unselected fixtures; release to pattern is explicit. Shared BPM shows
are finite, staged and washes-only by default. Fixture microphones, shared clock and browser
microphone sources are labeled separately; see [HTTPS/microphone setup](docs/deployment/https.md).

Keyboard: `space` temporary blackout, `T` tap tempo, `R` resync, `[` `]` nudge, `1`–`9` scenes, `0` Stop lighting.

### Sharing with friends

Settings → Share shows a guest link and QR code. Guests get the level you choose: view only,
control (patterns, scenes, params, BPM, blackout), or edit (also patterns, scenes, playlists, the
agent). The links are long random tokens stored in `data/auth.json`; make a new one to revoke.
They work on the office network; off it, run the server behind Tailscale or similar and set the
public URL in Settings.

On iPhone, open the link in Safari and use Share → Add to Home Screen for a full-screen app.

## Lasers

The two Scorpion Dual lasers are fixtures in the rig, but they are not lights as far as the rest of
the app is concerned: patterns never see them, the agent has no tool for them, overrides and flash
skip them, and scenes do not store them. The **Lasers** card, guarded shared shows and operator
API actions all use the same preset vocabulary the laser operator approved on site:

- **Manual**: fan (flat line) or wave (zigzag), one of six fixed colors, "pan" within 48–80. On the
  Scorpion Dual the pan channel is really a spread: the unit's two mirrored fans move in toward each
  other or out away together. Tilt is pinned at 64 (the level beam, the lowest approved angle), zoom
  at 53, strobe and rolling at 0.
- **Sound**: the fixture's own sound-active modes (multicolor or one color); the laser picks its
  patterns and positions itself, as approved for that mode.
- Invalid preset commands are rejected. Disarmed, Off and blacked-out laser states encode
  as all zeros; raw channels are never accepted from patterns or API clients.

Patterns drive the lasers too. A pattern may export a `lasers` section: either the name of a look
(`lasers: "beat-colors"`) or a function `lasers(ctx)` that returns one entry per laser, built from the
same vocabulary (mode, fan/wave, a color that snaps to the nearest approved one, spread 0..1 for how far
the unit's two mirrored fans sit apart, or a sound mode). Such patterns are tagged **laser** on the
Patterns tab, and most of the party and color built-ins have one. An operator must explicitly select
Follow after arming to authorize the current pattern source; applying a different pattern clears that
pattern ownership and its laser output. Manual laser looks have their own explicit selection. The agent writes laser sections when asked for a look "with lasers".

An admin must **arm** the lasers before any preset is emitted. The arm is in memory only: every
server start comes up disarmed, "Release output" disarms, blackout clears laser intents,
and the **All lasers off** button (anyone with control, so a guest can hit it) sets
every laser to Off and disarms. The header shows a red "Lasers armed" badge for everyone while the
rig is armed.

Only the trained operator enables the lasers (guide Step 12.4). Physical power isolation is the stop;
software off is not an interlock. Arm alone never emits a previously staged preset; make a new
deliberate preset/Start action after arming. Never run a legacy Home Assistant laser sender
alongside Lightesota: the per-channel maximum of approved frames is **not** necessarily approved.
Laser sound sensitivity remains physical S5 at 031/041, with no DMX sensitivity control.

## Haze

Andrew's Haze card, Hurricane Haze 4D profile, preview and timed runs are retained
as future capability. **Haze is uncommissioned: channels 51–52 stay zero.** New and
migrated fixtures are disabled; existing saved enabled fixtures remain blocked by
the immutable process gate. Arm/Start require `LIGHTESOTA_HAZE_COMMISSIONED=1`
plus whole-output commissioning, and preview still vetoes them. No UI, import or
API can enable this gate or silently remove saved protected ranges.

Future attended commissioning needs building approval for detectors/ventilation,
physical testing and explicit fixture/protection review; see the
[migration procedure](docs/deployment/migration.md). After commissioning, only an
admin can arm/start a timed run (up to 20 minutes). Haze off is available to control
roles. Stop, global manual takeover, disarm, release, mute and restart cancel runs;
unmute never restarts them. Patterns, ordinary overrides and AI cannot drive haze.
The unit may continue emitting fluid already in the line; software Off is not a
physical isolation procedure.

## Writing patterns

A pattern is a small JavaScript module. The full reference is in the editor (API button) and in
[shared/src/patternApiDoc.ts](shared/src/patternApiDoc.ts). The short version:

```js
export default {
  name: "Rainbow Sweep",
  params: {
    speed: { type: "number", default: 0.25, min: 0, max: 2, step: 0.01, label: "Speed" },
    sat:   { type: "number", default: 1, min: 0, max: 1, step: 0.01, label: "Saturation" },
  },
  render(ctx) {
    for (const f of ctx.fixtures) ctx.set(f, hsv(ctx.beat * ctx.params.speed + f.nx, ctx.params.sat, 1));
  },
};
```

Every entry in `params` becomes a live control. `ctx.beat` follows the BPM; `ctx.t` is seconds.
Patterns run in a sandbox (no network, filesystem or timers) with a per-frame time limit; a
pattern that hangs is disabled rather than freezing the show. Built-ins live in
[patterns/](patterns/), user patterns in `data/patterns/`.

## Safety rules this app keeps

- The hazer (51–52) is uncommissioned and held at 0, including with upstream data.
  Only the fixed built-in haze profile may occupy those addresses; it remains gated.
- Lasers are written only from the bounded preset tables in `shared/src/laser.ts`, only while armed.
  Pattern laser output additionally requires an operator to select **Follow** for the current loaded source.
  Applying/reloading/editing the pattern or its parameters, Stop, disarm and manual takeover invalidate Follow.
  Arm alone never restores it. The software vocabulary does not establish optical safety.
  Do not add channel functions, widen the pan window or lower the tilt without the operator.
- Software off is not an emergency stop. The ODE can hold its last frame. Physical power isolation
  is the stop.
- Use one final output authority. Retire legacy direct senders before commissioning this one.
- Shutdown attempts a zero frame when transport is permitted; successful software calls do not
  prove delivery or physical darkness. Preview never sends even an Off frame.

## Layout

```
shared/   types, fixture profiles, color math, WebSocket protocol, pattern API doc
server/   engine (worker + vm sandbox), show controller, Art-Net/DMX/Hue output, library, agent, API
web/      React + Vite app
patterns/ built-in patterns
```

`npm test` runs server control/output/API regressions and fake browser audio/WebSocket tests.
See the [HA adapter tests](integrations/home_assistant/README.md#offline-validation) for Python checks.

Changes in this integration are recorded in the [2026-11-06 change log](docs/lighting-integration-changelog.md).
