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
npm run dev        # server on :8787 (API/WS), Vite on :5173 (UI with hot reload)
```

Open http://localhost:5173 during development. From localhost you are admin automatically.

Production build and run (serves the built UI from the same port):

```bash
npm run build
npm start          # http://localhost:8787
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

## First run against the real rig

The server starts with the office rig from the lighting notes: four SlimPAR Pro H washes in 12CH
at 101/113/125/137, two Saber Spot pinspots at 29/30 (not on the DMX chain yet, so they start
disabled; enable them in the Stage editor once wired), two Scorpion Dual RGB ILS lasers at 31/41
(see [Lasers](#lasers)), Art-Net to 10.10.0.204 universe 0. Channels 51–52 (hazer) are protected
and never written.

**Two senders share the ODE: Home Assistant and this app.** The ODE's ports are set to **HTP merge**
(highest value wins per channel), which is what makes that work:

- HA's frame is all zeros for the washes when its lights are off, so the app's values win there.
- The app sends 0 on the hazer channels (51–52), so HA's gated values win there. Laser channels
  (31–50) are 0 whenever the app's lasers are disarmed, which is the normal state; see Lasers below
  for what happens when both HA and the app have lasers enabled.
- Either sender can stop without breaking the other. "Release output" in Settings stops the app's
  transmission entirely when HA alone should drive the rig.
- While the app is lit, HA cannot force a wash darker than the app's level (HTP takes the maximum).

If the ODE is ever back on **Merge None**, it keeps the first sender it hears and silently drops the
other; the symptom is the Live view moving while the lights stay dark, and `merge_err=1` on the
ODE's config page (`http://10.10.0.204/index.html?config.cgi`). Either set HTP again, or use the
app's "Merge an upstream Art-Net sender" setting with HA pointed at the app's IP.

Check the DMX monitor in Settings to see exactly what is being sent before you trust it.

## Using the console

- **Live**: the room preview, the active pattern's parameters as sliders, crossfade, speed, master,
  quick scene buttons. Tap a fixture to solo it, flash it, or override its color.
- **Patterns**: pick a look. Editors can open the code editor; `⌘S` saves and reloads the live
  pattern with the current parameters.
- **Scenes**: saved looks (pattern + params + BPM + master). Hotkeys 1–9, favorites.
- **Playlists**: timed sequences of scenes in bars or seconds, loop/shuffle.
- **Agent**: describe a look; the agent writes the pattern, test-renders it, applies it and exposes
  the tunable parts as parameters. Needs `ANTHROPIC_API_KEY` on the server.
- **Stage**: drag fixtures to where they hang, set addresses and tags, add Hue lights.
- **Settings**: Art-Net target, upstream merge, Hue pairing, share links with QR code, theme,
  export/import, DMX monitor.

Keyboard: `space` blackout, `T` tap tempo, `R` resync, `[` `]` nudge, `1`–`9` scenes, `0` dark.

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
skip them, and scenes do not store them. The only way light leaves a laser is the **Lasers** card on
the Live tab, and it only speaks the preset vocabulary the laser operator approved on site:

- **Manual**: fan (flat line) or wave (zigzag), one of six fixed colors, "pan" within 48–80. On the
  Scorpion Dual the pan channel is really a spread: the unit's two mirrored fans move in toward each
  other or out away together. Tilt is pinned at 64 (the level beam, the lowest approved angle), zoom
  at 53, strobe and rolling at 0.
- **Sound**: the fixture's own sound-active modes (multicolor or one color); the laser picks its
  patterns and positions itself, as approved for that mode.
- Anything else, including every unknown value a client might send, encodes as all zeros, the
  Scorpion's dark and still state.

Patterns drive the lasers too. A pattern may export a `lasers` section: either the name of a look
(`lasers: "beat-colors"`) or a function `lasers(ctx)` that returns one entry per laser, built from the
same vocabulary (mode, fan/wave, a color that snaps to the nearest approved one, spread 0..1 for how far
the unit's two mirrored fans sit apart, or a sound mode). Such patterns are tagged **laser** on the
Patterns tab, and most of the party and color built-ins have one. Applying a pattern without a lasers
section turns the lasers off. The agent writes laser sections when asked for a look "with lasers".

An admin must **arm** the lasers before any preset is emitted. The arm is in memory only: every
server start comes up disarmed, "Release output" disarms, blackout holds the laser channels at zero
while it is on, and the **All lasers off** button (anyone with control, so a guest can hit it) sets
every laser to Off and disarms. The header shows a red "Lasers armed" badge for everyone while the
rig is armed.

Only the trained operator enables the lasers (guide Step 12.4). Physical power isolation is the stop;
software off is not an interlock. If Home Assistant's own laser entities are enabled at the same
time, the ODE's HTP merge takes the per-channel maximum of two approved frames, which is still an
approved frame, but run one controller at a time anyway.

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

- The hazer (51–52) is a protected range. The output stage never writes it; without an upstream
  frame it is held at 0. The fixture editor refuses addresses that overlap it.
- Lasers are written only from the approved preset tables in `shared/src/laser.ts`, only while armed.
  Do not add channel functions, widen the pan window or lower the tilt without the operator.
- Software off is not an emergency stop. The ODE can hold its last frame. Physical power isolation
  is the stop.
- The ODE merges HA and this app with HTP. Never send non-zero values on channels 51–52 from here.
- On shutdown (Ctrl-C) the server sends a few all-zero frames so the rig goes dark.

## Layout

```
shared/   types, fixture profiles, color math, WebSocket protocol, pattern API doc
server/   engine (worker + vm sandbox), show controller, Art-Net/DMX/Hue output, library, agent, API
web/      React + Vite app
patterns/ built-in patterns
```

`npm test` runs the server unit tests (sandbox, DMX mapping, Art-Net packets, agent tools).
