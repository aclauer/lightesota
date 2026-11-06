import { useEffect, useState } from "react";
import { AlertTriangle, Play, Power } from "lucide-react";
import {
  LASER_COLORS, LASER_COLOR_CSS, LASER_MUSIC_COLORS, LASER_PAN_CENTER, LASER_PAN_MAX, LASER_PAN_MIN, LASER_PATTERNS, LASER_PATTERN_LABEL,
  LASER_LOOKS, LASER_LOOK_PATTERN, defaultLaserState, laserFixtures, laserIsOn, type LaserState,
} from "@lightesota/shared";
import { useStore } from "../state/store";
import { timeAgo } from "../lib/format";
import { laserStartDisabledReason, patternFollowDisabledReason } from "../lib/laser-controls";

/**
 * Operator panel for the bounded software vocabulary. Anyone with control can hit "All lasers off".
 * Software constraints and the preview do not establish optical safety.
 */
export function LasersCard() {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const patterns = useStore((s) => s.patterns);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const connected = useStore((s) => s.connected);
  const [, tick] = useState(0);
  const livePattern = patterns.find((p) => p.id === show.patternId);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const lasers = laserFixtures(rig);
  if (lasers.length === 0) return null;
  const admin = can("admin") && connected;
  const control = can("guest") && connected;
  const L = show.lasers;
  const startReason = laserStartDisabledReason(show, connected, can("admin"));
  const followReason = patternFollowDisabledReason(show, livePattern, connected, can("admin"));
  const anyOn = lasers.some((f) => laserIsOn(L.fixtures[f.id], L.armed, show.blackout));

  return (
    <div className={`card lasers ${L.armed ? "armed" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Lasers</h3>
        {L.armed ? <span className="pill danger"><AlertTriangle /> Armed {L.armedBy ? `by ${L.armedBy}` : ""}{L.armedAt ? ` · ${timeAgo(L.armedAt)}` : ""}</span> : <span className="pill">Disarmed</span>}
      </div>
      {admin ? (
        <label className="row" style={{ marginBottom: 10 }}>
          <button className={`switch danger ${L.armed ? "on" : ""}`} role="switch" aria-checked={L.armed} aria-label="Arm lasers" onClick={() => send({ type: "armLasers", armed: !L.armed })} />
          {L.armed ? "Armed · Start a preset or look to emit" : "Arm lasers (operator present, beam area clear)"}
        </label>
      ) : (
        <p className="hint" style={{ marginBottom: 10 }}>Only an admin can arm the lasers or change presets.</p>
      )}
      <p className="hint" style={{ marginBottom: 10 }}>Arm stays dark. Disarm clears running intents; Start is required again after arming. Preset edits while running apply immediately.</p>
      {show.blackout && <p className="hint" style={{ marginBottom: 10 }}>Temporary blackout is on. Lasers need an operator Start after blackout is released.</p>}
      <div className="looks" style={{ marginBottom: 10 }}>
        <div className="hint" style={{ marginBottom: 6 }}>Start a look</div>
        <div className="chips">
          {LASER_LOOKS.map((l) => <button key={l.id} className={`btn sm ${L.look === l.id ? "active" : ""}`} disabled={!!startReason} title={startReason ?? l.description} onClick={() => send({ type: "setLaserLook", lookId: L.look === l.id ? null : l.id })}>{l.name}{l.animated ? " ·" : ""}</button>)}
          <button className="btn sm" disabled={!!startReason} title={startReason ?? undefined} onClick={() => send({ type: "quickLook", lookId: "laser-duo" })}>Cyan Fan + Magenta Wave</button>
        </div>
        {startReason && <p className="hint" style={{ marginTop: 6 }}>{startReason}</p>}
        {L.patternFollowing || L.look === LASER_LOOK_PATTERN
          ? <div className="hint" style={{ marginTop: 6 }}>Following the live pattern{livePattern ? ` "${livePattern.name}"` : ""}. Adjusting a laser by hand takes over.</div>
          : L.look ? <div className="hint" style={{ marginTop: 6 }}>{LASER_LOOKS.find((l) => l.id === L.look)?.description} Adjusting a laser by hand stops the look.</div>
          : null}
        {livePattern?.usesLasers && <div style={{ marginTop: 8 }}>
          <div className="row"><span className="hint">"{livePattern.name}" has a laser section.</span><button className={`btn sm ghost ${L.patternFollowing ? "active" : ""}`} disabled={!!followReason || !!L.patternFollowing} title={followReason ?? "Authorize the current pattern source to drive the laser layer"} onClick={() => {
            if (L.patternRevision != null) send({ type: "followPatternLasers", patternId: livePattern.id, revision: L.patternRevision });
          }}>{L.patternFollowing ? "Following pattern" : "Follow the pattern"}</button></div>
          <p className="hint">{followReason ?? "Follow authorizes this pattern source only. Changing or reloading it requires a fresh Follow."}</p>
        </div>}
      </div>
      <div className="stack">
        {lasers.map((f) => <LaserRow key={f.id} id={f.id} name={f.name} state={L.fixtures[f.id] ?? defaultLaserState()} armed={L.armed} blackout={show.blackout} editable={admin} startReason={startReason} onChange={(patch) => send({ type: "setLaser", fixtureId: f.id, state: patch })} />)}
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <button className={`btn ${anyOn || L.armed ? "danger" : ""}`} disabled={!control} onClick={() => send({ type: "lasersOff" })}><Power /> All lasers off</button>
        <span className="hint">Fixed tilt 64 / zoom 53. Software limits do not establish optical safety; software off is not an emergency stop.</span>
      </div>
    </div>
  );
}

function LaserRow({ id, name, state, armed, blackout, editable, startReason, onChange }: { id: string; name: string; state: LaserState; armed: boolean; blackout: boolean; editable: boolean; startReason: string | null; onChange: (p: Partial<LaserState>) => void }) {
  const [presetMode, setPresetMode] = useState<"manual" | "music">(state.mode === "music" ? "music" : "manual");
  useEffect(() => { if (state.mode !== "off") setPresetMode(state.mode); }, [state.mode]);
  const on = laserIsOn(state, armed, blackout);
  const dis = !editable;
  return (
    <div className="laser-row" data-id={id}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row"><span className="dot" style={{ background: on ? "var(--danger)" : "var(--fg-3)", boxShadow: on ? "0 0 8px var(--danger)" : "none" }} /><b>{name}</b></span>
        <span className="pill">{on ? state.mode === "music" ? "Fixture mic" : "Manual" : "Off"}</span>
      </div>
      <div className="row" style={{ marginTop: 8, justifyContent: "space-between" }}>
        <span className="seg" aria-label={`${name} staged preset mode`}>
          {(["manual", "music"] as const).map((m) => <button key={m} className={presetMode === m ? "active" : ""} disabled={dis} onClick={() => setPresetMode(m)}>{m === "manual" ? "Manual preset" : "Fixture mic"}</button>)}
        </span>
        <button className="btn sm" disabled={!editable} onClick={() => onChange({ mode: "off" })}>Off</button>
      </div>
      {presetMode === "manual" && (
        <div className="stack" style={{ marginTop: 8, gap: 8 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <span className="seg">
              {LASER_PATTERNS.map((p) => <button key={p} className={state.pattern === p ? "active" : ""} disabled={dis} onClick={() => onChange({ pattern: p })} title={LASER_PATTERN_LABEL[p]}>{p === "fan" ? "Fan" : "Wave"}</button>)}
            </span>
            <span className="chips">
              {LASER_COLORS.map((c) => <button key={c} className={`swatch-btn ${state.color === c ? "active" : ""}`} style={{ background: LASER_COLOR_CSS[c] }} disabled={dis} onClick={() => onChange({ color: c })} title={c} aria-label={c} />)}
            </span>
          </div>
          <div className="param">
            <span className="lbl">Spread (the two fans move in or out together)</span><span className="val">{state.pan === LASER_PAN_CENTER ? "middle" : state.pan < LASER_PAN_CENTER ? `${LASER_PAN_CENTER - state.pan} tighter` : `${state.pan - LASER_PAN_CENTER} wider`}</span>
            <input className="ctl" type="range" min={LASER_PAN_MIN} max={LASER_PAN_MAX} step={1} value={state.pan} disabled={dis} onChange={(e) => onChange({ pan: Number(e.target.value) })} onDoubleClick={() => onChange({ pan: LASER_PAN_CENTER })} aria-label={`${name} spread`} />
          </div>
        </div>
      )}
      {presetMode === "music" && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="hint">Color</span>
          <span className="chips">
            {LASER_MUSIC_COLORS.map((c) => <button key={c} className={`swatch-btn ${state.musicColor === c ? "active" : ""}`} style={{ background: c === "multicolor" ? "conic-gradient(#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)" : LASER_COLOR_CSS[c] }} disabled={dis} onClick={() => onChange({ musicColor: c })} title={c} aria-label={c} />)}
          </span>
          <span className="hint">The laser’s microphone chooses patterns. Sensitivity is physical S5 at addresses 031 / 041; there is no DMX sensitivity control.</span>
        </div>
      )}
      <button className="btn sm" style={{ marginTop: 10 }} disabled={!!startReason} title={startReason ?? undefined} onClick={() => onChange({ ...state, mode: presetMode })}><Play /> Start {presetMode === "manual" ? "preset" : "fixture mic"}</button>
    </div>
  );
}
