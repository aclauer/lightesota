import { useState } from "react";
import { Code2, Flashlight, RotateCcw, Save, X } from "lucide-react";
import { findProfile, type FixtureOverride } from "@lightesota/shared";
import { useStore } from "../state/store";
import { Stage } from "../components/Stage";
import { ParamControls } from "../components/ParamControls";
import { Modal } from "../components/Modal";
import { hexToRgb01, rgb01ToHex } from "../lib/format";

export function LiveView() {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const patterns = useStore((s) => s.patterns);
  const scenes = useStore((s) => s.scenes);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const selected = useStore((s) => s.selectedFixtureId);
  const selectFixture = useStore((s) => s.selectFixture);
  const openEditor = useStore((s) => s.openEditor);
  const status = useStore((s) => s.status);
  const [saveOpen, setSaveOpen] = useState(false);
  const control = can("guest");
  const pattern = patterns.find((p) => p.id === show.patternId);
  const activeScene = scenes.find((s) => s.id === show.activeSceneId);

  return (
    <div className="live">
      <div className="stage-wrap">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <h2 style={{ fontSize: 18 }}>{pattern ? pattern.name : "No pattern"}</h2>
            {activeScene && <span className="pill accent">Scene: {activeScene.name}</span>}
            {show.playlist && <span className="pill ok">Playlist running</span>}
            {status?.engine.patternError && <span className="pill danger" title={status.engine.patternError}>pattern error</span>}
            {show.released && <span className="pill warn">Released to Home Assistant</span>}
          </div>
          <div className="row">
            {control && <button className="btn sm" onClick={() => setSaveOpen(true)}><Save /> Save scene</button>}
            {pattern && can("editor") && <button className="btn sm ghost" onClick={() => openEditor(pattern.id)}><Code2 /> Edit code</button>}
          </div>
        </div>
        <div className="stage-card">
          <Stage rig={rig} mode="live" selectedId={selected} onSelect={selectFixture} />
          <div className="stage-legend">Tap a fixture to inspect it · drag to pan · scroll to zoom · double-click to fit</div>
        </div>
      </div>
      <div className="side">
        {selected ? <FixtureInspector id={selected} onClose={() => selectFixture(null)} /> : null}
        <div className="card">
          <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
            <h3 style={{ margin: 0 }}>Parameters</h3>
            {pattern && control && Object.keys(pattern.params).length > 0 && (
              <button className="btn ghost sm" title="Reset to defaults" onClick={() => send({ type: "setParams", params: Object.fromEntries(Object.entries(pattern.params).map(([k, d]) => [k, d.default])), merge: false })}><RotateCcw /> Reset</button>
            )}
          </div>
          {pattern ? (
            <ParamControls schema={pattern.params} values={show.params} disabled={!control} onChange={(patch) => send({ type: "setParams", params: patch })} />
          ) : <p className="hint">Pick a pattern from the Patterns tab, or recall a scene.</p>}
        </div>
        <div className="card">
          <h3>Show</h3>
          <div className="param">
            <span className="lbl">Crossfade</span><span className="val">{(show.crossfadeMs / 1000).toFixed(1)} s</span>
            <input className="ctl" type="range" min={0} max={8000} step={100} value={show.crossfadeMs} disabled={!control} onChange={(e) => send({ type: "setCrossfade", crossfadeMs: Number(e.target.value) })} aria-label="Crossfade" />
          </div>
          <div className="param">
            <span className="lbl">Speed (free-running patterns)</span><span className="val">×{show.speed.toFixed(2)}</span>
            <input className="ctl" type="range" min={0} max={3} step={0.05} value={show.speed} disabled={!control} onChange={(e) => send({ type: "setSpeed", speed: Number(e.target.value) })} onDoubleClick={() => send({ type: "setSpeed", speed: 1 })} aria-label="Speed" />
          </div>
          <div className="param">
            <span className="lbl">Master</span><span className="val">{Math.round(show.master * 100)}%</span>
            <input className="ctl accent" type="range" min={0} max={1} step={0.01} value={show.master} disabled={!control} onChange={(e) => send({ type: "setMaster", master: Number(e.target.value) })} aria-label="Master" />
          </div>
          {Object.keys(show.overrides).length > 0 && control && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="pill warn">{Object.keys(show.overrides).length} fixture override{Object.keys(show.overrides).length > 1 ? "s" : ""}</span>
              <button className="btn sm ghost" onClick={() => send({ type: "clearOverrides" })}>Clear</button>
            </div>
          )}
          {show.solo.length > 0 && control && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="pill warn">Solo: {show.solo.length}</span>
              <button className="btn sm ghost" onClick={() => send({ type: "setSolo", fixtureIds: [] })}>Clear</button>
            </div>
          )}
        </div>
        {scenes.length > 0 && (
          <div className="card">
            <h3>Scenes</h3>
            <div className="quick-scenes">
              {scenes.map((s) => (
                <button key={s.id} className={`btn sm ${s.id === show.activeSceneId ? "active" : ""}`} disabled={!control} onClick={() => send({ type: "recallScene", sceneId: s.id })}>
                  <span className="swatches" style={{ width: 22 }}>{s.swatch.slice(0, 4).map((c, i) => <i key={i} style={{ background: c }} />)}</span>
                  {s.name}{s.hotkey ? <span className="kbd">{s.hotkey}</span> : null}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      {saveOpen && <SaveSceneModal onClose={() => setSaveOpen(false)} />}
    </div>
  );
}

export function SaveSceneModal({ onClose }: { onClose: () => void }) {
  const show = useStore((s) => s.show)!;
  const patterns = useStore((s) => s.patterns);
  const scenes = useStore((s) => s.scenes);
  const request = useStore((s) => s.request);
  const toast = useStore((s) => s.toast);
  const pattern = patterns.find((p) => p.id === show.patternId);
  const active = scenes.find((s) => s.id === show.activeSceneId);
  const [name, setName] = useState(active?.name ?? pattern?.name ?? "Scene");
  const [overwrite, setOverwrite] = useState(!!active);
  const save = async () => {
    try {
      await request({ type: "saveScene", name, sceneId: overwrite && active ? active.id : undefined });
      toast("success", `Saved "${name}"`);
      onClose();
    } catch (e) { toast("error", (e as Error).message); }
  };
  return (
    <Modal title="Save scene" onClose={onClose}>
      <p className="muted">Saves the current pattern, its parameters, BPM{pattern?.usesBeat ? "" : " (not used by this pattern)"}, master level and fixture overrides.</p>
      <label className="field"><span>Name</span><input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void save()} /></label>
      {active && (
        <label className="row"><button className={`switch ${overwrite ? "on" : ""}`} role="switch" aria-checked={overwrite} onClick={() => setOverwrite(!overwrite)} /> <span>Update the current scene “{active.name}” instead of making a new one</span></label>
      )}
      <div className="row" style={{ justifyContent: "flex-end" }}><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={() => void save()}><Save /> Save</button></div>
    </Modal>
  );
}

function FixtureInspector({ id, onClose }: { id: string; onClose: () => void }) {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const frame = useStore((s) => s.frame);
  const f = rig.fixtures.find((x) => x.id === id);
  if (!f) return null;
  const control = can("guest");
  const profile = findProfile(f.profileId, rig.customProfiles);
  const idx = rig.fixtures.filter((x) => x.enabled).indexOf(f);
  const c = idx >= 0 ? frame[idx] : undefined;
  const ov: FixtureOverride | undefined = show.overrides[f.id];
  const soloed = show.solo.includes(f.id);
  const isColor = profile?.colorModel !== "dimmer";
  const setOv = (patch: Partial<FixtureOverride> | null) => send({ type: "setOverride", fixtureId: f.id, override: patch === null ? null : { ...ov, ...patch } });
  return (
    <div className="card fixture-inspector">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 6 }}>
        <div><h2 style={{ marginBottom: 0 }}>{f.name}</h2><div className="hint">{profile?.name ?? f.profileId}{f.address ? ` · DMX ${f.address}` : ""}{f.hueLightId ? ` · Hue #${f.hueLightId}` : ""}</div></div>
        <button className="btn ghost icon sm" onClick={onClose} aria-label="Close"><X /></button>
      </div>
      <div className="chips" style={{ marginBottom: 10 }}>{f.tags.map((t) => <span key={t} className="pill">{t}</span>)}</div>
      {c && <div className="row" style={{ marginBottom: 10 }}><span className="dot" style={{ width: 18, height: 18, background: `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`, opacity: 0.3 + c.dim * 0.7 }} /><span className="mono faint">{isColor ? `rgb ${Math.round(c.r * 255)} ${Math.round(c.g * 255)} ${Math.round(c.b * 255)}` : ""} dim {Math.round(c.dim * 100)}%</span></div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <button className={`btn sm ${soloed ? "active" : ""}`} disabled={!control} onClick={() => send({ type: "setSolo", fixtureIds: soloed ? show.solo.filter((x) => x !== f.id) : [...show.solo, f.id] })}>Solo</button>
        <button className="btn sm" disabled={!control} onClick={() => send({ type: "testFixture", fixtureId: f.id, seconds: 2 })} title="Flash white for 2 s to find this fixture"><Flashlight /> Flash</button>
        {ov && <button className="btn sm danger" disabled={!control} onClick={() => setOv(null)}>Clear override</button>}
      </div>
      <div className="param-group">
        <h4>Manual override</h4>
        <div className="param">
          <span className="lbl">Intensity</span><span className="val">{ov?.dim !== undefined ? `${Math.round(ov.dim * 100)}%` : "pattern"}</span>
          <input className="ctl" type="range" min={0} max={1} step={0.01} value={ov?.dim ?? (c?.dim ?? 1)} disabled={!control} onChange={(e) => setOv({ dim: Number(e.target.value) })} aria-label="Override intensity" />
        </div>
        {isColor && (
          <div className="param" style={{ gridTemplateColumns: "1fr auto" }}>
            <span className="lbl">Color</span>
            <div className="color-ctl">
              {ov?.r !== undefined && <span className="mono faint">override</span>}
              <input type="color" disabled={!control} value={ov?.r !== undefined ? rgb01ToHex(ov.r, ov.g ?? 0, ov.b ?? 0) : c ? rgb01ToHex(c.r, c.g, c.b) : "#ffffff"} onChange={(e) => { const [r, g, b] = hexToRgb01(e.target.value); setOv({ r, g, b, dim: ov?.dim ?? 1 }); }} aria-label="Override color" />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
