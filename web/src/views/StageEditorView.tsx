import { useMemo, useState } from "react";
import { Copy, Flashlight, Plus, Trash2 } from "lucide-react";
import { BUILTIN_PROFILES, findProfile, isLaserProfile, type Fixture, type Rig } from "@lightesota/shared";
import { useStore } from "../state/store";
import { Stage } from "../components/Stage";

export function StageEditorView() {
  const rig = useStore((s) => s.rig)!;
  const send = useStore((s) => s.send);
  const selected = useStore((s) => s.selectedFixtureId);
  const selectFixture = useStore((s) => s.selectFixture);
  const hueLights = useStore((s) => s.hueLights);
  const settings = useStore((s) => s.settings);
  const [draft, setDraft] = useState<Rig | null>(null);
  const r = draft ?? rig;
  const f = r.fixtures.find((x) => x.id === selected) ?? null;
  const profiles = [...BUILTIN_PROFILES, ...r.customProfiles];

  const commit = (next: Rig) => { setDraft(null); send({ type: "setRig", rig: next }); };
  const update = (next: Rig, live = true) => (live ? commit(next) : setDraft(next));
  const patch = (id: string, p: Partial<Fixture>, live = true) => update({ ...r, fixtures: r.fixtures.map((x) => (x.id === id ? { ...x, ...p } : x)) }, live);

  const addFixture = (profileId: string) => {
    const p = findProfile(profileId, r.customProfiles)!;
    const used = new Set<number>();
    for (const x of r.fixtures) { const pp = findProfile(x.profileId, r.customProfiles); if (x.address && pp) for (let c = 0; c < pp.channels.length; c++) used.add(x.address + c); }
    for (const pr of r.protectedRanges) for (let c = pr.from; c <= pr.to; c++) used.add(c);
    let addr = 1;
    while (p.transport === "dmx" && [...Array(p.channels.length).keys()].some((c) => used.has(addr + c)) && addr < 512) addr++;
    const n = r.fixtures.length + 1;
    const id = `f${Date.now().toString(36)}`;
    const fx: Fixture = { id, name: `${isLaserProfile(p) ? "Laser" : p.colorModel === "dimmer" ? "Spot" : p.transport === "hue" ? "Hue" : "Wash"} ${n}`, profileId, universe: p.transport === "dmx" ? (settings?.artnet.universe ?? 0) : undefined, address: p.transport === "dmx" ? addr : undefined, x: Math.round(r.room.width / 2 * 2) / 2, y: Math.round(r.room.height / 2 * 2) / 2, rotation: 0, tags: [p.colorModel === "dimmer" ? "spot" : p.transport === "hue" ? "hue" : "wash"], enabled: true };
    commit({ ...r, fixtures: [...r.fixtures, fx] });
    selectFixture(id);
  };

  const conflicts = useMemo(() => {
    const owner = new Map<number, string>(); const out = new Map<string, string>();
    for (const x of r.fixtures) {
      const p = findProfile(x.profileId, r.customProfiles);
      if (!x.enabled || !p || p.transport !== "dmx" || !x.address) continue;
      for (let c = 0; c < p.channels.length; c++) {
        const ch = x.address + c;
        const pr = r.protectedRanges.find((pr) => pr.universe === (x.universe ?? 0) && ch >= pr.from && ch <= pr.to);
        if (pr) out.set(x.id, `channel ${ch} is protected (${pr.reason})`);
        const o = owner.get(ch);
        if (o && o !== x.id) { out.set(x.id, `channel ${ch} overlaps ${r.fixtures.find((y) => y.id === o)?.name}`); out.set(o, `channel ${ch} overlaps ${x.name}`); }
        owner.set(ch, x.id);
      }
    }
    return out;
  }, [r]);

  return (
    <div className="live">
      <div className="stage-wrap">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div><h2 style={{ fontSize: 18 }}>Stage editor</h2><p className="hint">Drag fixtures to where they hang (snaps to the grid, hold Alt for free placement). Changes save immediately.</p></div>
          <div className="row">
            <select className="select" style={{ width: 230 }} value="" onChange={(e) => e.target.value && addFixture(e.target.value)} aria-label="Add fixture">
              <option value="">+ Add fixture…</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
        </div>
        <div className="stage-card">
          <Stage rig={r} mode="edit" selectedId={selected} onSelect={selectFixture} onMove={(id, x, y, done) => patch(id, { x, y }, done)} />
          <div className="stage-legend">{r.room.width} × {r.room.height} units · grid {r.room.gridStep}</div>
        </div>
      </div>
      <div className="side">
        {f ? (
          <div className="card">
            <div className="row" style={{ justifyContent: "space-between" }}><h2>{f.name}</h2>
              <div className="row">
                <button className="btn ghost icon sm" title="Flash to identify" onClick={() => send({ type: "testFixture", fixtureId: f.id, seconds: 2 })}><Flashlight /></button>
                <button className="btn ghost icon sm" title="Duplicate" onClick={() => { const c = { ...f, id: `f${Date.now().toString(36)}`, name: `${f.name} copy`, x: f.x + 1, address: f.address ? f.address + (findProfile(f.profileId, r.customProfiles)?.channels.length ?? 1) : undefined }; commit({ ...r, fixtures: [...r.fixtures, c] }); selectFixture(c.id); }}><Copy /></button>
                <button className="btn ghost icon sm" title="Remove" onClick={() => { commit({ ...r, fixtures: r.fixtures.filter((x) => x.id !== f.id) }); selectFixture(null); }}><Trash2 /></button>
              </div>
            </div>
            {conflicts.get(f.id) && <div className="err" style={{ marginBottom: 10 }}>{conflicts.get(f.id)}. This fixture is not driven until fixed.</div>}
            <div className="stack">
              <label className="field"><span>Name</span><input className="input" value={f.name} onChange={(e) => patch(f.id, { name: e.target.value }, false)} onBlur={() => draft && commit(draft)} /></label>
              <label className="field"><span>Profile</span>
                <select className="select" value={f.profileId} onChange={(e) => patch(f.id, { profileId: e.target.value })}>{profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              </label>
              {findProfile(f.profileId, r.customProfiles)?.transport === "dmx" && (
                <div className="row nowrap">
                  <label className="field" style={{ flex: 1 }}><span>DMX address</span><input className="input tabular" type="number" min={1} max={512} value={f.address ?? 1} onChange={(e) => patch(f.id, { address: Number(e.target.value) })} /></label>
                  <label className="field" style={{ width: 90 }}><span>Universe</span><input className="input tabular" type="number" min={0} value={f.universe ?? 0} onChange={(e) => patch(f.id, { universe: Number(e.target.value) })} /></label>
                </div>
              )}
              {findProfile(f.profileId, r.customProfiles)?.transport === "hue" && (
                <label className="field"><span>Hue light</span>
                  <select className="select" value={f.hueLightId ?? ""} onChange={(e) => patch(f.id, { hueLightId: e.target.value || undefined })}>
                    <option value="">(not assigned)</option>
                    {hueLights.map((l) => <option key={l.id} value={l.id}>{l.name} (#{l.id})</option>)}
                    {f.hueLightId && !hueLights.some((l) => l.id === f.hueLightId) && <option value={f.hueLightId}>#{f.hueLightId}</option>}
                  </select>
                  <span className="hint">Load the list from Settings → Hue.</span>
                </label>
              )}
              <div className="row nowrap">
                <label className="field" style={{ flex: 1 }}><span>X</span><input className="input tabular" type="number" step={0.1} value={f.x} onChange={(e) => patch(f.id, { x: Number(e.target.value) })} /></label>
                <label className="field" style={{ flex: 1 }}><span>Y</span><input className="input tabular" type="number" step={0.1} value={f.y} onChange={(e) => patch(f.id, { y: Number(e.target.value) })} /></label>
                <label className="field" style={{ flex: 1 }}><span>Rotation</span><input className="input tabular" type="number" step={15} value={f.rotation} onChange={(e) => patch(f.id, { rotation: Number(e.target.value) })} /></label>
              </div>
              <label className="field"><span>Tags (comma separated; patterns can target these)</span><input className="input" defaultValue={f.tags.join(", ")} key={f.id} onBlur={(e) => patch(f.id, { tags: e.target.value.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean) })} /></label>
              <div className="param"><span className="lbl">Trim (max intensity)</span><span className="val">{Math.round((f.trim ?? 1) * 100)}%</span><input className="ctl" type="range" min={0} max={1} step={0.01} value={f.trim ?? 1} onChange={(e) => patch(f.id, { trim: Number(e.target.value) }, false)} onPointerUp={() => draft && commit(draft)} /></div>
              <label className="row"><button className={`switch ${f.enabled ? "on" : ""}`} role="switch" aria-checked={f.enabled} onClick={() => patch(f.id, { enabled: !f.enabled })} /> Enabled</label>
            </div>
          </div>
        ) : (
          <div className="card">
            <h3>Room</h3>
            <div className="stack">
              <label className="field"><span>Name</span><input className="input" value={r.room.name} onChange={(e) => update({ ...r, room: { ...r.room, name: e.target.value } }, false)} onBlur={() => draft && commit(draft)} /></label>
              <div className="row nowrap">
                <label className="field" style={{ flex: 1 }}><span>Width</span><input className="input tabular" type="number" step={0.5} min={1} value={r.room.width} onChange={(e) => commit({ ...r, room: { ...r.room, width: Number(e.target.value) } })} /></label>
                <label className="field" style={{ flex: 1 }}><span>Depth</span><input className="input tabular" type="number" step={0.5} min={1} value={r.room.height} onChange={(e) => commit({ ...r, room: { ...r.room, height: Number(e.target.value) } })} /></label>
                <label className="field" style={{ flex: 1 }}><span>Grid</span><input className="input tabular" type="number" step={0.25} min={0.1} value={r.room.gridStep} onChange={(e) => commit({ ...r, room: { ...r.room, gridStep: Number(e.target.value) } })} /></label>
              </div>
              <p className="hint">Select a fixture on the plan to edit it, or add one with the menu above.</p>
            </div>
          </div>
        )}
        <div className="card">
          <h3>Fixtures ({r.fixtures.length})</h3>
          <div className="plist">
            {r.fixtures.map((x) => (
              <button key={x.id} className={x.id === selected ? "active" : ""} onClick={() => selectFixture(x.id)}>
                <span className="t">{x.name}</span>
                <span className="faint mono">{x.address ? `@${x.address}` : x.hueLightId ? `hue ${x.hueLightId}` : ""}</span>
                {conflicts.get(x.id) && <span className="dot" style={{ background: "var(--danger)" }} title={conflicts.get(x.id)} />}
                {!x.enabled && <span className="pill">off</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="card">
          <h3>Protected channels</h3>
          <p className="hint" style={{ marginBottom: 8 }}>Never written by this app, whatever the patterns do. Edit the rig file to change them.</p>
          {r.protectedRanges.map((p, i) => <div key={i} className="row" style={{ justifyContent: "space-between", fontSize: 13 }}><span className="mono">U{p.universe} {p.from}–{p.to}</span><span className="muted">{p.reason}</span></div>)}
          <div style={{ marginTop: 8 }}><button className="btn sm ghost" onClick={() => addFixture("hue-color-light")} title="Add a Hue light"><Plus /> Add Hue light</button></div>
        </div>
      </div>
    </div>
  );
}
