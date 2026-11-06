import { useEffect, useState } from "react";
import { Play, RotateCcw } from "lucide-react";
import { COORDINATED_SHOWS, QUICK_LOOKS, WASH_MODES, defaultWashState, washFixtures, washSide, type CoordinatedShowId, type WashMode, type WashPatch, type WashState } from "@lightesota/shared";
import { useStore } from "../state/store";
import { laserStartDisabledReason } from "../lib/laser-controls";

const MODE_LABEL: Record<WashMode, string> = { off: "Off", normal: "Normal", music6: "Music 6", music32: "Music 32" };
const SHOW_DESCRIPTION: Record<CoordinatedShowId, string> = {
  "neon-exchange": "Cyan and magenta swap sides every 16 beats.",
  "call-response": "The leading side reaches the ceiling; the other stays at 40%. Roles swap every phrase.",
  "build-release": "Build from 35% to the chosen ceiling over 16 beats, then release and swap palette.",
};

/** One shared scope for direct wash commands, quick looks, and finite show starts. */
export function WashesCard() {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const selected = useStore((s) => s.selectedFixtureId);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const connected = useStore((s) => s.connected);
  const fixtures = washFixtures(rig);
  const [selection, setSelection] = useState<string[]>(() => selected && fixtures.some((f) => f.id === selected) ? [selected] : fixtures.map((f) => f.id));
  useEffect(() => {
    if (selected && rig.fixtures.some((f) => f.id === selected && f.enabled && f.profileId === "chauvet-slimpar-pro-h-12ch")) setSelection([selected]);
  }, [selected, rig]);
  const ids = fixtures.filter((f) => selection.includes(f.id)).map((f) => f.id);
  const states = ids.map((id) => show.washes[id] ?? defaultWashState());
  const first = states[0] ?? defaultWashState();
  const mixed = <K extends keyof WashState>(key: K) => states.some((s) => JSON.stringify(s[key]) !== JSON.stringify(first[key]));
  const disabled = !can("guest") || !connected || ids.length === 0;
  const patch = (p: WashPatch) => send({ type: "setWash", fixtureIds: ids, patch: p });
  const selectionMatches = (scope: string[]) => ids.length === scope.length && scope.every((id) => ids.includes(id));
  const [showId, setShowId] = useState<CoordinatedShowId>("neon-exchange");
  const [durationSec, setDurationSec] = useState(180);
  const [ceiling, setCeiling] = useState(25);
  const [includeLasers, setIncludeLasers] = useState(false);
  const laserReason = laserStartDisabledReason(show, connected, can("admin"));
  const laserAllowed = !laserReason;
  useEffect(() => { if (!laserAllowed) setIncludeLasers(false); }, [laserAllowed]);
  const run = show.coordinatedShow;
  if (fixtures.length === 0) return null;

  return (
    <>
      <div className="card washes">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Washes</h3>
          <span className="pill">{ids.length} selected</span>
        </div>
        <div className="stack">
          <div className="seg wash-scopes" aria-label="Wash selection">
            {([['All', fixtures], ['Side A · W1/2', fixtures.filter((f) => washSide(f) === 'a')], ['Side B · W3/4', fixtures.filter((f) => washSide(f) === 'b')]] as const).map(([label, group]) => (
              <button key={label} className={selectionMatches(group.map((f) => f.id)) ? "active" : ""} onClick={() => setSelection(group.map((f) => f.id))}>{label}</button>
            ))}
          </div>
          <div className="wash-fixtures">
            {fixtures.map((f) => {
              const state = show.washes[f.id] ?? defaultWashState();
              return <label className="wash-fixture" key={f.id}>
                <input type="checkbox" checked={ids.includes(f.id)} onChange={() => setSelection((old) => old.includes(f.id) ? old.filter((id) => id !== f.id) : [...old, f.id])} />
                <span>{f.name}<small>{state.owner === "pattern" ? "Pattern" : MODE_LABEL[state.mode]} · {state.brightness}/255{state.owner === "show" ? " · show" : ""}</small></span>
              </label>;
            })}
          </div>
          <div className="seg wash-modes" aria-label="Selected wash mode">
            {WASH_MODES.map((mode) => <button key={mode} disabled={disabled} className={!mixed("mode") && first.mode === mode && first.owner !== "pattern" ? "active" : ""} onClick={() => patch({ mode })}>{MODE_LABEL[mode]}</button>)}
          </div>
          <p className="hint">Music 6 / 32 use each fixture’s microphone. Brightness retains the mode; RGBW switches selected washes to Normal.</p>
          <div className="param">
            <span className="lbl">Intensity</span><span className="val">{mixed("brightness") ? "Mixed" : `${first.brightness}/255 · ${Math.round(first.brightness / 255 * 100)}%`}</span>
            <input className="ctl accent" type="range" min={0} max={255} step={1} value={first.brightness} disabled={disabled} onChange={(e) => patch({ brightness: Number(e.target.value) })} aria-label="Selected wash intensity" />
          </div>
          <div className="wash-rgbw">
            {(["R", "G", "B", "W"] as const).map((channel, index) => <label className="field" key={channel}>
              <span>{channel}{states.some((state) => state.rgbw[index] !== first.rgbw[index]) ? " · mixed" : ""}</span>
              <input className="input tabular" type="number" min={0} max={255} step={1} value={first.rgbw[index]} disabled={disabled} aria-label={`Selected wash ${channel}`} onChange={(e) => {
                const value = e.target.valueAsNumber;
                if (!Number.isInteger(value) || value < 0 || value > 255) return;
                const rgbw: WashState["rgbw"] = [...first.rgbw];
                rgbw[index] = value;
                patch({ rgbw });
              }} />
            </label>)}
          </div>
          {mixed("rgbw") && <p className="hint">Mixed RGBW: editing applies all four displayed values to the selection.</p>}
          <details>
            <summary className="hint">Advanced · fixture microphone sensitivity</summary>
            <div className="param" style={{ marginTop: 8 }}>
              <span className="lbl">Sensitivity (11–255)</span><span className="val">{mixed("sensitivity") ? "Mixed" : first.sensitivity}</span>
              <input className="ctl" type="range" min={11} max={255} step={1} value={first.sensitivity} disabled={disabled} onChange={(e) => patch({ sensitivity: Number(e.target.value) })} aria-label="Fixture microphone sensitivity" />
            </div>
            <p className="hint">Initial value 255. W4 is physically verified; the other washes still need on-site checks.</p>
          </details>
          <div className="row">
            <button className="btn sm" disabled={disabled} onClick={() => send({ type: "takeManualControl", fixtureIds: ids })}>Take manual control</button>
            <button className="btn sm ghost" disabled={disabled} onClick={() => send({ type: "releaseWashes", fixtureIds: ids })}><RotateCcw /> Release to pattern</button>
          </div>
          <p className="hint">Take manual control holds selected washes and cancels their automation. Unselected manual washes stay unchanged.</p>
          <div className="divider" />
          <h4 style={{ fontSize: 12 }}>Quick looks · selected washes</h4>
          <div className="chips">
            {QUICK_LOOKS.filter((look) => look.id !== "laser-duo").map((look) => <button className="btn sm" key={look.id} disabled={disabled} onClick={() => send({ type: "quickLook", lookId: look.id, fixtureIds: ids })}>{look.name.replace("Fixture microphones · ", "")}</button>)}
          </div>
          <p className="hint">Calm Blue 25/255 · Warm Arrival 32/255 · sides and Music 38/255. These are dimmer bytes, before master.</p>
        </div>
      </div>
      <div className="card coordinated-show">
        <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Coordinated show</h3><span className={`pill ${run ? "ok" : ""}`}>{run ? "Running" : "Staged"}</span>
        </div>
        <div className="stack">
          {run && <div className="show-timer" role="status">
            <b>{COORDINATED_SHOWS.find((s) => s.id === run.id)?.name}</b>
            <span className="tabular">{formatSeconds(run.elapsedSec)} / {formatSeconds(run.durationSec)}</span>
            <div className="progress"><i style={{ width: `${Math.min(100, run.elapsedSec / run.durationSec * 100)}%` }} /></div>
            <small>Shared BPM clock · phrase {run.phrase + 1} · {run.fixtureIds.length} washes{run.includeLasers ? " + lasers" : " only"}</small>
          </div>}
          <label className="field"><span>Next show</span><select className="select" value={showId} onChange={(e) => setShowId(e.target.value as CoordinatedShowId)}>{COORDINATED_SHOWS.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <p className="hint">{SHOW_DESCRIPTION[showId]}</p>
          <div className="row nowrap">
            <label className="field" style={{ flex: 1 }}><span>Duration · seconds</span><input className="input" type="number" min={10} max={900} step={1} value={durationSec} onChange={(e) => setDurationSec(e.target.valueAsNumber || 0)} /></label>
            <label className="field" style={{ flex: 1 }}><span>Ceiling · /255</span><input className="input" type="number" min={1} max={102} step={1} value={ceiling} onChange={(e) => setCeiling(e.target.valueAsNumber || 0)} /></label>
          </div>
          <label className="row"><input type="checkbox" checked={includeLasers && laserAllowed} disabled={!laserAllowed} title={laserReason ?? undefined} onChange={(e) => setIncludeLasers(e.target.checked)} /> Include lasers in this run</label>
          {laserReason && <p className="hint">Washes only. {laserReason}</p>}
          <button className="btn primary" disabled={disabled || !Number.isInteger(durationSec) || durationSec < 10 || durationSec > 900 || !Number.isInteger(ceiling) || ceiling < 1 || ceiling > 102} onClick={() => {
            send({ type: "startCoordinatedShow", params: { id: showId, fixtureIds: ids, durationSec, ceiling, includeLasers: includeLasers && laserAllowed } });
            setIncludeLasers(false);
          }}><Play /> Start{run ? " new run" : ""} · {ids.length} selected washes</button>
          <p className="hint">Shared BPM clock · use Tap / Sync above. Runs once, then clears its outputs. Edits are staged until Start; fixture microphone modes are separate.</p>
        </div>
      </div>
    </>
  );
}

function formatSeconds(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}
