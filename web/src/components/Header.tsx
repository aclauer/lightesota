import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Moon, Power, Share2, Sun, SunMoon, Users } from "lucide-react";
import { useStore } from "../state/store";
import { ShareModal } from "./ShareModal";
import { PresenceModal } from "./PresenceModal";

export function Header() {
  const show = useStore((s) => s.show);
  const settings = useStore((s) => s.settings);
  const connected = useStore((s) => s.connected);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const presence = useStore((s) => s.presence);
  const [share, setShare] = useState(false);
  const [people, setPeople] = useState(false);
  const control = can("guest");

  const nextTheme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
  const ThemeIcon = theme === "dark" ? Moon : theme === "light" ? Sun : SunMoon;

  return (
    <header className="hdr">
      <div className="brand">
        <span className={`lamp ${show?.lasers.armed ? "laser" : ""}`} style={show?.blackout && !show?.lasers.armed ? { background: "var(--fg-3)", boxShadow: "none" } : undefined} title={show?.lasers.armed ? "Lasers armed" : undefined} />
        <span>Lightesota</span>
        {settings?.sharing.venueName && <span className="venue">· {settings.sharing.venueName}</span>}
      </div>
      {show?.lasers.armed && <span className="pill danger laser-armed" title={`Lasers armed${show.lasers.armedBy ? ` by ${show.lasers.armedBy}` : ""}`}><AlertTriangle /> <span className="hide-mobile">Lasers armed</span></span>}
      <div className="spacer" />
      <Transport />
      <div className="master hide-mobile" title="Master intensity">
        <span className="faint" style={{ fontSize: 11 }}>MASTER</span>
        <input type="range" className="accent" min={0} max={1} step={0.01} value={show?.master ?? 1} disabled={!control}
          onChange={(e) => send({ type: "setMaster", master: Number(e.target.value) })} aria-label="Master intensity" />
      </div>
      <button className={`btn blackout ${show?.blackout ? "on" : ""}`} disabled={!control} onClick={() => send({ type: "setBlackout", blackout: !show?.blackout })} title="Blackout (space)">
        <Power /> <span className="hide-mobile">{show?.blackout ? "BLACKOUT" : "Blackout"}</span>
      </button>
      <button className="btn ghost icon presence" onClick={() => setPeople(true)} title={`${presence.length} connected`} aria-label="People">
        <Users /> <span className="tabular" style={{ fontSize: 12 }}>{presence.length}</span>
      </button>
      {can("admin") && <button className="btn ghost icon hide-mobile" onClick={() => setShare(true)} title="Share" aria-label="Share"><Share2 /></button>}
      <button className="btn ghost icon" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme} (click for ${nextTheme})`} aria-label="Toggle theme"><ThemeIcon /></button>
      <span className={`conn ${connected ? "on" : ""}`} title={connected ? "Connected" : "Reconnecting…"} />
      {share && <ShareModal onClose={() => setShare(false)} />}
      {people && <PresenceModal onClose={() => setPeople(false)} />}
    </header>
  );
}

function Transport() {
  const show = useStore((s) => s.show);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const ws = useStore((s) => s.ws);
  const dotRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ y: number; bpm: number } | null>(null);
  const control = can("guest");

  // Beat indicator driven by rAF, outside React state.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const s = useStore.getState().show;
      const el = dotRef.current;
      if (s && el) {
        const beat = ((ws.serverNow() - s.transport.beatOrigin) / 60000) * s.transport.bpm;
        const phase = beat - Math.floor(beat);
        const on = phase < 0.15;
        const bar = Math.floor(beat) % 4 === 0;
        el.className = `beat-dot ${on ? "on" : ""} ${on && bar ? "bar" : ""}`;
        el.style.transform = `scale(${1 + (on ? (1 - phase / 0.15) * 0.5 : 0)})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ws]);

  const bpm = show?.transport.bpm ?? 120;
  const onPointerDown = (e: React.PointerEvent) => {
    if (!control) return;
    drag.current = { y: e.clientY, bpm };
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const d = drag.current.y - e.clientY;
    send({ type: "setBpm", bpm: Math.round((drag.current.bpm + d * 0.25) * 2) / 2 });
  };
  const onPointerUp = () => { drag.current = null; };

  return (
    <div className="transport" aria-label="Transport">
      <div className="bpm" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} title="Drag up/down to change BPM" onDoubleClick={() => {
        const v = window.prompt("BPM", String(bpm));
        if (v && control) send({ type: "setBpm", bpm: Number(v) });
      }}>
        <b>{bpm.toFixed(bpm % 1 ? 1 : 0)}</b><span>BPM</span>
      </div>
      <span ref={dotRef} className="beat-dot" />
      <button className="btn sm" disabled={!control} onClick={() => send({ type: "tap" })} title="Tap tempo (T)">Tap</button>
      <button className="btn sm ghost hide-mobile" disabled={!control} onClick={() => send({ type: "resync" })} title="Restart the beat grid (R)">Sync</button>
      <button className="btn sm ghost hide-mobile" disabled={!control} onClick={() => send({ type: "setBpm", bpm: bpm / 2 })} title="Half tempo">½</button>
      <button className="btn sm ghost hide-mobile" disabled={!control} onClick={() => send({ type: "setBpm", bpm: bpm * 2 })} title="Double tempo">×2</button>
    </div>
  );
}
