import { useEffect, useState } from "react";
import { AlertTriangle, Power } from "lucide-react";
import {
  LASER_COLORS, LASER_COLOR_CSS, LASER_MUSIC_COLORS, LASER_PAN_CENTER, LASER_PAN_MAX, LASER_PAN_MIN, LASER_PATTERNS, LASER_PATTERN_LABEL,
  LASER_LOOKS, defaultLaserState, laserFixtures, laserIsOn, type LaserState,
} from "@lightesota/shared";
import { useStore } from "../state/store";
import { timeAgo } from "../lib/format";

/**
 * Operator panel for the lasers. Admins arm the rig and pick per-laser presets from the approved
 * vocabulary; anyone with control can hit "All lasers off". Nothing here can produce a value the
 * laser operator did not sign off on (see shared/src/laser.ts).
 */
export function LasersCard() {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(t); }, []);
  const lasers = laserFixtures(rig);
  if (lasers.length === 0) return null;
  const admin = can("admin");
  const control = can("guest");
  const L = show.lasers;
  const anyOn = lasers.some((f) => laserIsOn(L.fixtures[f.id], L.armed, show.blackout));

  return (
    <div className={`card lasers ${L.armed ? "armed" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Lasers</h3>
        {L.armed ? <span className="pill danger"><AlertTriangle /> Armed {L.armedBy ? `by ${L.armedBy}` : ""}{L.armedAt ? ` · ${timeAgo(L.armedAt)}` : ""}</span> : <span className="pill">Disarmed</span>}
      </div>
      {admin ? (
        <label className="row" style={{ marginBottom: 10 }}>
          <button className={`switch danger ${L.armed ? "on" : ""}`} role="switch" aria-checked={L.armed} onClick={() => send({ type: "armLasers", armed: !L.armed })} />
          {L.armed ? "Armed: presets below go to the lasers" : "Arm the lasers (operator present, beam area clear)"}
        </label>
      ) : (
        <p className="hint" style={{ marginBottom: 10 }}>Only an admin can arm the lasers or change presets.</p>
      )}
      {show.blackout && L.armed && <p className="hint" style={{ marginBottom: 10 }}>Blackout is on: lasers are dark until it is lifted.</p>}
      <div className="looks" style={{ marginBottom: 10 }}>
        <div className="hint" style={{ marginBottom: 6 }}>Looks</div>
        <div className="chips">
          {LASER_LOOKS.map((l) => <button key={l.id} className={`btn sm ${L.look === l.id ? "active" : ""}`} disabled={!admin} title={l.description} onClick={() => send({ type: "setLaserLook", lookId: L.look === l.id ? null : l.id })}>{l.name}{l.animated ? " ·" : ""}</button>)}
        </div>
        {L.look && <div className="hint" style={{ marginTop: 6 }}>{LASER_LOOKS.find((l) => l.id === L.look)?.description} Adjusting a laser by hand stops the look.</div>}
      </div>
      <div className="stack">
        {lasers.map((f) => <LaserRow key={f.id} id={f.id} name={f.name} state={L.fixtures[f.id] ?? defaultLaserState()} armed={L.armed} blackout={show.blackout} editable={admin} onChange={(patch) => send({ type: "setLaser", fixtureId: f.id, state: patch })} />)}
      </div>
      <div className="row" style={{ marginTop: 12, justifyContent: "space-between" }}>
        <button className={`btn ${anyOn || L.armed ? "danger" : ""}`} disabled={!control} onClick={() => send({ type: "lasersOff" })}><Power /> All lasers off</button>
        <span className="hint">Tilt is fixed at the approved level beam. Software off is not an emergency stop.</span>
      </div>
    </div>
  );
}

function LaserRow({ id, name, state, armed, blackout, editable, onChange }: { id: string; name: string; state: LaserState; armed: boolean; blackout: boolean; editable: boolean; onChange: (p: Partial<LaserState>) => void }) {
  const on = laserIsOn(state, armed, blackout);
  const dis = !editable;
  return (
    <div className="laser-row" data-id={id}>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <span className="row"><span className="dot" style={{ background: on ? "var(--danger)" : "var(--fg-3)", boxShadow: on ? "0 0 8px var(--danger)" : "none" }} /><b>{name}</b></span>
        <span className="seg">
          {(["off", "manual", "music"] as const).map((m) => <button key={m} className={state.mode === m ? "active" : ""} disabled={dis} onClick={() => onChange({ mode: m })}>{m === "off" ? "Off" : m === "manual" ? "Manual" : "Sound"}</button>)}
        </span>
      </div>
      {state.mode === "manual" && (
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
      {state.mode === "music" && (
        <div className="row" style={{ marginTop: 8 }}>
          <span className="hint">Color</span>
          <span className="chips">
            {LASER_MUSIC_COLORS.map((c) => <button key={c} className={`swatch-btn ${state.musicColor === c ? "active" : ""}`} style={{ background: c === "multicolor" ? "conic-gradient(#f33,#ff3,#3f3,#3ff,#33f,#f3f,#f33)" : LASER_COLOR_CSS[c] }} disabled={dis} onClick={() => onChange({ musicColor: c })} title={c} aria-label={c} />)}
          </span>
          <span className="hint">The laser picks its own patterns from its microphone.</span>
        </div>
      )}
    </div>
  );
}
