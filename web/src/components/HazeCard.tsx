import { useEffect, useState } from "react";
import { CloudFog, Power } from "lucide-react";
import { hazeFixtures, hazeRunning } from "@lightesota/shared";
import { useStore } from "../state/store";

/** Operator panel for the hazer: admin arm, fan and output levels, timed runs that stop by themselves. */
export function HazeCard() {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  if (hazeFixtures(rig).length === 0) return null;
  const admin = can("admin");
  const control = can("guest");
  const H = show.haze;
  const running = hazeRunning(H);
  const left = H.runUntil ? Math.max(0, Math.round((H.runUntil - Date.now()) / 1000)) : 0;
  const fmt = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`);
  const set = (patch: { armed?: boolean; fan?: number; output?: number; runSec?: number }) => send({ type: "setHaze", ...patch });

  return (
    <div className={`card haze ${H.armed ? "armed" : ""}`}>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>Haze</h3>
        {running ? <span className="pill warn"><CloudFog /> Running · {fmt(left)} left</span> : H.armed ? <span className="pill danger">Armed</span> : <span className="pill">Disarmed</span>}
      </div>
      {admin ? (
        <label className="row" style={{ marginBottom: 10 }}>
          <button className={`switch danger ${H.armed ? "on" : ""}`} role="switch" aria-checked={H.armed} onClick={() => set({ armed: !H.armed })} />
          {H.armed ? "Armed: runs below go to the hazer" : "Arm the hazer (detectors and ventilation checked)"}
        </label>
      ) : <p className="hint" style={{ marginBottom: 10 }}>Only an admin can arm the hazer or start a run.</p>}
      {show.blackout && running && <p className="hint" style={{ marginBottom: 10 }}>Blackout is on: haze output is held at zero until it is lifted.</p>}
      <div className="param">
        <span className="lbl">Blower</span><span className="val">{Math.round(H.fan * 100)}%</span>
        <input className="ctl" type="range" min={0} max={1} step={0.01} value={H.fan} disabled={!admin} onChange={(e) => set({ fan: Number(e.target.value) })} aria-label="Blower speed" />
      </div>
      <div className="param">
        <span className="lbl">Haze output</span><span className="val">{Math.round(H.output * 100)}%</span>
        <input className="ctl" type="range" min={0} max={1} step={0.01} value={H.output} disabled={!admin} onChange={(e) => set({ output: Number(e.target.value) })} aria-label="Haze output" />
      </div>
      <div className="row" style={{ marginTop: 10, justifyContent: "space-between" }}>
        <span className="row" style={{ gap: 6 }}>
          <span className="hint">Run for</span>
          <span className="seg">
            {[30, 120, 300, 600].map((s) => <button key={s} disabled={!admin || !H.armed} onClick={() => set({ runSec: s })}>{s < 60 ? `${s} s` : `${s / 60} min`}</button>)}
          </span>
        </span>
        <button className={`btn ${running || H.armed ? "danger" : ""}`} disabled={!control} onClick={() => send({ type: "hazeOff" })}><Power /> Haze off</button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>Every run stops by itself. The unit keeps emitting a little while fluid is in the line, so power it down when done.</p>
    </div>
  );
}
