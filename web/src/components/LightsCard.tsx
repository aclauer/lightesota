import { useEffect, useMemo, useState } from "react";
import { Flashlight, Power } from "lucide-react";
import { engineFixtures, findProfile, washFixtures, type Fixture, type FrameColor, type Rig, type ShowState } from "@lightesota/shared";
import { useStore } from "../state/store";
import { frameToCss } from "../lib/format";

const COLORS: [string, string][] = [
  ["Red", "#ff0000"], ["Orange", "#ff5a00"], ["Yellow", "#ffc800"], ["Green", "#00ff3c"], ["Cyan", "#00ffff"],
  ["Blue", "#0028ff"], ["Purple", "#7a00ff"], ["Pink", "#ff1e8c"], ["Warm", "#ffa046"], ["White", "#ffffff"],
];
const MODE_LABEL = { off: "Off", normal: "Color", music6: "Music 6", music32: "Music 32" } as const;

/** Every ordinary light (no lasers or hazer), in rig order. */
function ordinaryLights(rig: Rig): Fixture[] {
  const ids = new Set(engineFixtures(rig).map((f) => f.parentId ?? f.id));
  return rig.fixtures.filter((f) => ids.has(f.id));
}

function lightStatus(show: ShowState, id: string): string {
  const wash = show.washes[id];
  if (wash && wash.owner === "show") return "Show";
  if (wash && wash.owner === "manual") return MODE_LABEL[wash.mode];
  if (!wash && show.overrides[id]) return "Color";
  return show.stopped || !show.patternId ? "Off" : "Pattern";
}

/** Status of every light, and one color/brightness control for all, washes, strips, or one light. */
export function LightsCard() {
  const rig = useStore((s) => s.rig)!;
  const show = useStore((s) => s.show)!;
  const frame = useStore((s) => s.frame);
  const selected = useStore((s) => s.selectedFixtureId);
  const selectFixture = useStore((s) => s.selectFixture);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const connected = useStore((s) => s.connected);
  const lights = useMemo(() => ordinaryLights(rig), [rig]);
  const segments = useMemo(() => engineFixtures(rig), [rig]);
  const groups = useMemo(() => {
    const washes = new Set(washFixtures(rig).map((f) => f.id));
    return [
      ["All", lights.map((f) => f.id)],
      ["Washes", lights.filter((f) => washes.has(f.id)).map((f) => f.id)],
      ["Strips", lights.filter((f) => findProfile(f.profileId, rig.customProfiles)?.transport === "hue").map((f) => f.id)],
    ] as [string, string[]][];
  }, [lights, rig]);
  const [target, setTarget] = useState<string[]>(() => lights.map((f) => f.id));
  const [level, setLevel] = useState(100);
  const [custom, setCustom] = useState("#ff5a00");
  useEffect(() => { if (selected && lights.some((f) => f.id === selected)) setTarget([selected]); }, [selected, lights]);

  const colorsOf = (id: string): FrameColor[] => segments.flatMap((f, i) => (f.parentId ?? f.id) === id && frame[i] ? [frame[i]] : []);
  const brightnessOf = (id: string) => Math.max(0, ...colorsOf(id).map((c) => c.dim));
  // The slider starts at the target's current output so the first drag doesn't jump.
  useEffect(() => {
    const now = Math.max(0, ...target.map(brightnessOf)) / (show.master || 1);
    if (now > 0) setLevel(Math.round(Math.min(1, now) * 100));
  }, [target.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  if (lights.length === 0) return null;
  const disabled = !can("guest") || !connected || target.length === 0;
  const same = (ids: string[]) => ids.length === target.length && ids.every((id) => target.includes(id));
  const groupName = groups.find(([, ids]) => ids.length && same(ids))?.[0];
  const targetName = groupName === "All" ? "All lights" : groupName ?? lights.find((f) => f.id === target[0])?.name ?? "";
  const apply = (brightness: number, color?: string) => send({ type: "setLights", fixtureIds: target, brightness, ...(color ? { color } : {}) });
  const pick = (ids: string[]) => { setTarget(ids); selectFixture(null); };

  return (
    <div className="card lights">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Lights</h3>
        {show.blackout && <span className="pill danger">Blackout on</span>}
      </div>
      <div className="light-list" role="listbox" aria-label="Lights">
        {lights.map((f) => {
          const colors = colorsOf(f.id);
          const css = colors.map(frameToCss);
          const on = target.includes(f.id);
          return (
            <button key={f.id} role="option" aria-selected={on} className={`light-row ${on ? "on" : ""}`} onClick={() => { setTarget([f.id]); selectFixture(f.id); }}>
              <i className="light-swatch" style={{ background: css.length > 1 ? `linear-gradient(90deg, ${css.join(", ")})` : css[0] ?? "#000" }} />
              <span className="light-name">{f.name}</span>
              <span className="light-status">{lightStatus(show, f.id)} · {Math.round(brightnessOf(f.id) * 100)}%</span>
            </button>
          );
        })}
      </div>
      <div className="seg light-groups" aria-label="Control">
        {groups.filter(([, ids]) => ids.length).map(([name, ids]) => (
          <button key={name} className={same(ids) ? "active" : ""} onClick={() => pick(ids)}>{name}</button>
        ))}
      </div>
      <div className="stack" style={{ marginTop: 10 }}>
        <div className="hint">Controlling <b>{targetName}</b></div>
        <div className="light-colors">
          {COLORS.map(([name, hex]) => (
            <button key={hex} className="light-color" style={{ background: hex }} title={name} aria-label={name} disabled={disabled} onClick={() => apply(Math.max(level, 1) / 100, hex)} />
          ))}
          <label className="light-color custom" title="Custom color">
            <input type="color" value={custom} disabled={disabled} aria-label="Custom color" onChange={(e) => { setCustom(e.target.value); apply(Math.max(level, 1) / 100, e.target.value); }} />
          </label>
        </div>
        <div className="param">
          <span className="lbl">Brightness</span><span className="val">{level}%</span>
          <input className="ctl accent" type="range" min={0} max={100} step={1} value={level} disabled={disabled} aria-label="Brightness" onChange={(e) => { setLevel(Number(e.target.value)); apply(Number(e.target.value) / 100); }} />
        </div>
        <div className="row">
          <button className="btn sm" disabled={disabled} onClick={() => apply(0)}><Power /> Off</button>
          {target.length === 1 && <button className="btn sm" disabled={disabled} title="Flash white for 2 s to find this light" onClick={() => send({ type: "testFixture", fixtureId: target[0], seconds: 2 })}><Flashlight /> Flash</button>}
        </div>
        <p className="hint">Colors stay until you start a pattern, which takes every light back.</p>
      </div>
    </div>
  );
}
