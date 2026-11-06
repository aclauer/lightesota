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

Configuration is by environment variables, see [.env.example](.env.example). Everything the app
stores (rig, scenes, playlists, your patterns, agent chats, share tokens) lives in `data/` as
JSON and JavaScript files.

## First run against the real rig

The server starts with the office rig from the lighting notes: four SlimPAR Pro H washes in 12CH
at 101/113/125/137, two Saber Spot pinspots at 29/30, Art-Net to 10.10.0.204 universe 0.
Channels 31–52 (lasers, hazer) are protected and never written.

**Only one Art-Net sender may talk to the ODE** (it is set to Merge None). Home Assistant currently
sends to it. Pick one of:

1. **Pause HA's Art-Net integration** (disable the `artnet_led` platform or stop HA) while
   Lightesota runs. Simplest for a first test.
2. **Upstream merge (recommended long term).** In HA's `office_lighting.yaml` change
   `host: 10.10.0.204` to the IP of the machine running Lightesota, then in Settings → Art-Net turn
   on "Merge an upstream Art-Net sender". Lightesota forwards HA's frame for every channel it does
   not own (lasers, hazer, anything else) and overwrites the wash and spot channels. The ODE still
   sees a single sender and the laser gating in HA keeps working. "Release output" hands the whole
   universe back to HA at any time.

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

- Lasers (31–50) and the hazer (51–52) are protected channels. The output stage never writes them;
  without an upstream frame they are held at 0, which is the Scorpion's dark state. The fixture
  editor refuses addresses that overlap them.
- Software off is not an emergency stop. The ODE can hold its last frame. Physical power isolation
  is the stop.
- On shutdown (Ctrl-C) the server sends a few all-zero frames so the rig goes dark.

## Layout

```
shared/   types, fixture profiles, color math, WebSocket protocol, pattern API doc
server/   engine (worker + vm sandbox), show controller, Art-Net/DMX/Hue output, library, agent, API
web/      React + Vite app
patterns/ built-in patterns
```

`npm test` runs the server unit tests (sandbox, DMX mapping, Art-Net packets, agent tools).
