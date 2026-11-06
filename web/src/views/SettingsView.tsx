import { useEffect, useState } from "react";
import { Download, Link, RefreshCw, Share2, Upload } from "lucide-react";
import type { Settings } from "@lightesota/shared";
import { useStore } from "../state/store";
import { ShareModal } from "../components/ShareModal";
import { effectiveTheme } from "../lib/theme";

export function SettingsView() {
  const settings = useStore((s) => s.settings)!;
  const status = useStore((s) => s.status);
  const send = useStore((s) => s.send);
  const request = useStore((s) => s.request);
  const can = useStore((s) => s.can);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const toast = useStore((s) => s.toast);
  const show = useStore((s) => s.show)!;
  const hueLights = useStore((s) => s.hueLights);
  const [share, setShare] = useState(false);
  const admin = can("admin");
  const [local, setLocal] = useState<Settings>(settings);
  useEffect(() => setLocal(settings), [settings]);
  const save = (patch: Partial<Settings>) => send({ type: "setSettings", settings: patch });

  const importFile = async (file: File) => {
    try {
      const body = JSON.parse(await file.text());
      const res = await fetch("/api/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
      toast("success", "Imported");
    } catch (e) { toast("error", `Import failed: ${(e as Error).message}`); }
  };

  return (
    <div className="stack">
      <h2 style={{ fontSize: 18 }}>Settings</h2>
      <div className="settings">
        <div className="card">
          <h3>Appearance</h3>
          <div className="stack">
            <div className="seg" role="radiogroup" aria-label="Theme">
              {(["system", "light", "dark"] as const).map((t) => <button key={t} className={theme === t ? "active" : ""} onClick={() => setTheme(t)}>{t === "system" ? `System (${effectiveTheme("system")})` : t[0].toUpperCase() + t.slice(1)}</button>)}
            </div>
            <p className="hint">Saved on this device. On iPhone, use Share → Add to Home Screen for a full-screen app.</p>
          </div>
        </div>

        {admin && (
          <div className="card">
            <h3>Sharing</h3>
            <div className="stack">
              <label className="field"><span>Venue name (shown in the header)</span><input className="input" value={local.sharing.venueName} onChange={(e) => setLocal({ ...local, sharing: { ...local.sharing, venueName: e.target.value } })} onBlur={() => save({ sharing: local.sharing })} /></label>
              <label className="field"><span>Public URL for share links (optional, e.g. a Tailscale name)</span><input className="input" placeholder="auto-detect" value={local.sharing.publicUrl} onChange={(e) => setLocal({ ...local, sharing: { ...local.sharing, publicUrl: e.target.value } })} onBlur={() => save({ sharing: local.sharing })} /></label>
              <button className="btn primary" onClick={() => setShare(true)}><Share2 /> Share links & QR code</button>
            </div>
          </div>
        )}

        {admin && (
          <div className="card">
            <h3>Art-Net output</h3>
            <div className="stack">
              <label className="row"><button className={`switch ${local.artnet.enabled ? "on" : ""}`} role="switch" aria-checked={local.artnet.enabled} onClick={() => save({ artnet: { ...local.artnet, enabled: !local.artnet.enabled } })} /> Send Art-Net</label>
              <div className="row nowrap">
                <label className="field" style={{ flex: 2 }}><span>Node IP (ENTTEC ODE)</span><input className="input mono" value={local.artnet.host} onChange={(e) => setLocal({ ...local, artnet: { ...local.artnet, host: e.target.value } })} onBlur={() => save({ artnet: local.artnet })} /></label>
                <label className="field" style={{ width: 80 }}><span>Port</span><input className="input tabular" type="number" value={local.artnet.port} onChange={(e) => setLocal({ ...local, artnet: { ...local.artnet, port: Number(e.target.value) } })} onBlur={() => save({ artnet: local.artnet })} /></label>
                <label className="field" style={{ width: 80 }}><span>Universe</span><input className="input tabular" type="number" value={local.artnet.universe} onChange={(e) => setLocal({ ...local, artnet: { ...local.artnet, universe: Number(e.target.value) } })} onBlur={() => save({ artnet: local.artnet })} /></label>
                <label className="field" style={{ width: 80 }}><span>FPS</span><input className="input tabular" type="number" min={5} max={60} value={local.artnet.fps} onChange={(e) => setLocal({ ...local, artnet: { ...local.artnet, fps: Number(e.target.value) } })} onBlur={() => save({ artnet: local.artnet })} /></label>
              </div>
              <div className="stats">
                <div className="stat"><b className={status?.artnet.sending ? "" : "muted"}>{status?.artnet.sending ? status.artnet.fps : "—"}</b><span>frames/s sent</span></div>
                <div className="stat"><b>{status?.engine.fps ?? 0}</b><span>engine fps</span></div>
                <div className="stat"><b>{status?.engine.restarts ?? 0}</b><span>worker restarts</span></div>
              </div>
              {status?.artnet.error && <div className="err">{status.artnet.error}</div>}
              <div className="divider" />
              <label className="row"><button className={`switch ${local.artnet.upstream.enabled ? "on" : ""}`} role="switch" aria-checked={local.artnet.upstream.enabled} onClick={() => save({ artnet: { ...local.artnet, upstream: { ...local.artnet.upstream, enabled: !local.artnet.upstream.enabled } } })} /> Merge an upstream Art-Net sender (Home Assistant)</label>
              <p className="hint">Point Home Assistant's Art-Net host at this server instead of the ODE. Its frame is forwarded for every channel this app does not own (lasers, hazer), so the ODE still sees a single sender.</p>
              {local.artnet.upstream.enabled && (
                <div className="row nowrap">
                  <label className="field" style={{ width: 110 }}><span>Listen port</span><input className="input tabular" type="number" value={local.artnet.upstream.listenPort} onChange={(e) => setLocal({ ...local, artnet: { ...local.artnet, upstream: { ...local.artnet.upstream, listenPort: Number(e.target.value) } } })} onBlur={() => save({ artnet: local.artnet })} /></label>
                  <label className="field" style={{ flex: 1 }}><span>Only accept from IP (optional)</span><input className="input mono" placeholder="10.10.0.192" value={local.artnet.upstream.allowFrom} onChange={(e) => setLocal({ ...local, artnet: { ...local.artnet, upstream: { ...local.artnet.upstream, allowFrom: e.target.value } } })} onBlur={() => save({ artnet: local.artnet })} /></label>
                </div>
              )}
              {local.artnet.upstream.enabled && <div className="hint">{status?.upstream.lastFrameAt && Date.now() - status.upstream.lastFrameAt < 5000 ? `Receiving from ${status.upstream.from} (${status.upstream.frames} frames)` : "No upstream frames in the last 5 s; unowned channels are held at 0."}</div>}
              <div className="divider" />
              <label className="row"><button className={`switch ${show.released ? "on" : ""}`} role="switch" aria-checked={show.released} onClick={() => send({ type: "setReleased", released: !show.released })} /> Release output to Home Assistant</label>
              <p className="hint">When released, this app stops driving fixtures: with upstream merge on it forwards HA's frame untouched, otherwise it stops transmitting so HA can send to the ODE directly.</p>
            </div>
          </div>
        )}

        {admin && (
          <div className="card">
            <h3>Philips Hue</h3>
            <div className="stack">
              <label className="row"><button className={`switch ${local.hue.enabled ? "on" : ""}`} role="switch" aria-checked={local.hue.enabled} onClick={() => save({ hue: { ...local.hue, enabled: !local.hue.enabled } })} /> Drive Hue lights</label>
              <div className="row nowrap">
                <label className="field" style={{ flex: 1 }}><span>Bridge IP</span><input className="input mono" value={local.hue.bridgeIp} onChange={(e) => setLocal({ ...local, hue: { ...local.hue, bridgeIp: e.target.value } })} onBlur={() => save({ hue: local.hue })} /></label>
                <label className="field" style={{ width: 110 }}><span>Updates/s</span><input className="input tabular" type="number" min={1} max={20} value={local.hue.rateHz} onChange={(e) => setLocal({ ...local, hue: { ...local.hue, rateHz: Number(e.target.value) } })} onBlur={() => save({ hue: local.hue })} /></label>
              </div>
              <div className="row">
                <button className="btn" disabled={!local.hue.enabled} onClick={async () => { toast("info", "Press the link button on the bridge, then wait…"); try { await request({ type: "huePair" }); } catch (e) { toast("error", (e as Error).message); } }}><Link /> Pair (press the bridge button first)</button>
                <button className="btn" disabled={!local.hue.enabled || !settings.hue.username} onClick={() => send({ type: "hueListLights" })}><RefreshCw /> Load lights</button>
                <span className={`pill ${settings.hue.username ? "ok" : ""}`}>{settings.hue.username ? "paired" : "not paired"}</span>
              </div>
              {status?.hue.lastError && <div className="err">{status.hue.lastError}</div>}
              {hueLights.length > 0 && (
                <div className="tbl-wrap"><table className="tbl"><thead><tr><th>#</th><th>Name</th><th>Type</th><th>State</th></tr></thead><tbody>
                  {hueLights.map((l) => <tr key={l.id}><td className="mono">{l.id}</td><td>{l.name}</td><td className="muted">{l.type}</td><td>{l.reachable ? (l.on ? "on" : "off") : "unreachable"}</td></tr>)}
                </tbody></table></div>
              )}
              <p className="hint">Add Hue lights to the plan in the Stage editor and assign them a light number here. Updates are rate limited by the bridge, so Hue follows slow patterns well and fast ones loosely.</p>
            </div>
          </div>
        )}

        {admin && (
          <div className="card">
            <h3>Agent</h3>
            <div className="stack">
              <div className="row"><span className={`pill ${status?.hasApiKey ? "ok" : "warn"}`}>{status?.hasApiKey ? "API key found" : "no API key"}</span><span className="hint">Set ANTHROPIC_API_KEY in the server environment.</span></div>
              <label className="field"><span>Model</span>
                <select className="select" value={local.agent.model} onChange={(e) => save({ agent: { ...local.agent, model: e.target.value } })}>
                  {["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"].map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>
              <label className="field"><span>Effort</span>
                <div className="seg">{(["low", "medium", "high", "xhigh"] as const).map((e) => <button key={e} className={local.agent.effort === e ? "active" : ""} onClick={() => save({ agent: { ...local.agent, effort: e } })}>{e}</button>)}</div>
              </label>
              <label className="row"><button className={`switch ${local.agent.allowApply ? "on" : ""}`} role="switch" aria-checked={local.agent.allowApply} onClick={() => save({ agent: { ...local.agent, allowApply: !local.agent.allowApply } })} /> Agent may apply patterns and change the live show</label>
              <div className="divider" />
              <label className="row"><button className={`switch ${local.agent.guestAccess ? "on" : ""}`} role="switch" aria-checked={local.agent.guestAccess} onClick={() => save({ agent: { ...local.agent, guestAccess: !local.agent.guestAccess } })} /> Guests may use the agent (rate limited)</label>
              {local.agent.guestAccess && (
                <div className="row nowrap">
                  <label className="field" style={{ flex: 1 }}><span>Seconds between prompts per guest</span><input className="input tabular" type="number" min={1} max={600} value={local.agent.guestIntervalSec} onChange={(e) => setLocal({ ...local, agent: { ...local.agent, guestIntervalSec: Number(e.target.value) } })} onBlur={() => save({ agent: local.agent })} /></label>
                  <label className="field" style={{ flex: 1 }}><span>All guests together / hour</span><input className="input tabular" type="number" min={1} max={1000} value={local.agent.guestTotalPerHour} onChange={(e) => setLocal({ ...local, agent: { ...local.agent, guestTotalPerHour: Number(e.target.value) } })} onBlur={() => save({ agent: local.agent })} /></label>
                </div>
              )}
              <p className="hint">Each prompt costs a few cents on {local.agent.model.includes("opus") ? "Opus" : local.agent.model.includes("haiku") ? "Haiku" : "Sonnet"}. Editors and admins are not limited.</p>
            </div>
          </div>
        )}

        {admin && (
          <div className="card">
            <h3>Data</h3>
            <div className="stack">
              <div className="row">
                <a className="btn" href="/api/export" download><Download /> Export everything</a>
                <label className="btn"><Upload /> Import<input type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && void importFile(e.target.files[0])} /></label>
              </div>
              <label className="field"><span>Preview frame rate (browser)</span>
                <div className="row nowrap"><input type="range" min={5} max={40} step={1} value={local.previewFps} onChange={(e) => setLocal({ ...local, previewFps: Number(e.target.value) })} onPointerUp={() => save({ previewFps: local.previewFps })} aria-label="Preview fps" /><span className="tabular" style={{ width: 40 }}>{local.previewFps}</span></div>
              </label>
              <p className="hint">Rig, scenes, playlists and your patterns live in the server's <code>data/</code> folder as JSON and JavaScript files.</p>
            </div>
          </div>
        )}

        {can("editor") && <DmxMonitor />}

        <div className="card">
          <h3>Shortcuts</h3>
          <div className="stack" style={{ fontSize: 13 }}>
            <div className="row"><span className="kbd">space</span> blackout</div>
            <div className="row"><span className="kbd">T</span> tap tempo <span className="kbd">R</span> resync beat <span className="kbd">[</span> <span className="kbd">]</span> nudge</div>
            <div className="row"><span className="kbd">1</span>–<span className="kbd">9</span> recall scenes <span className="kbd">0</span> dark</div>
            <div className="row"><span className="kbd">⌘S</span> save pattern in the editor</div>
          </div>
        </div>
      </div>
      {share && <ShareModal onClose={() => setShare(false)} />}
    </div>
  );
}

function DmxMonitor() {
  const send = useStore((s) => s.send);
  const dmx = useStore((s) => s.dmx);
  const rig = useStore((s) => s.rig)!;
  const [on, setOn] = useState(false);
  useEffect(() => { send({ type: "subscribeDmx", on }); return () => send({ type: "subscribeDmx", on: false }); }, [on, send]);
  const owned = new Map<number, string>();
  for (const f of rig.fixtures) { if (!f.address) continue; const n = Math.max(1, 12); for (let c = 0; c < n; c++) owned.set(f.address + c, f.name); }
  const prot = new Set<number>();
  for (const p of rig.protectedRanges) for (let c = p.from; c <= p.to; c++) prot.add(c);
  return (
    <div className="card" style={{ gridColumn: "1 / -1" }}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>DMX monitor</h3>
        <label className="row"><button className={`switch ${on ? "on" : ""}`} role="switch" aria-checked={on} onClick={() => setOn(!on)} /> Live</label>
      </div>
      {on && dmx ? (
        <div className="dmxgrid">
          {dmx.slice(0, 160).map((v, i) => <div key={i} className={prot.has(i + 1) ? "prot" : owned.has(i + 1) ? "owned" : ""} title={`ch ${i + 1}${owned.get(i + 1) ? ` · ${owned.get(i + 1)}` : ""}`}>{v}<i style={{ width: `${(v / 255) * 100}%` }} /></div>)}
        </div>
      ) : <p className="hint">Turn on to see the first 160 channels of the universe as they are sent. Red cells are protected channels.</p>}
    </div>
  );
}
