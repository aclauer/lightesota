import type { ParamDef, ParamSchema, ParamValues } from "@lightesota/shared";
import { Plus, X } from "lucide-react";

interface Props {
  schema: ParamSchema;
  values: ParamValues;
  onChange: (patch: ParamValues) => void;
  disabled?: boolean;
}

/** Renders controls for a pattern's params schema, grouped by `group`. */
export function ParamControls({ schema, values, onChange, disabled }: Props) {
  const entries = Object.entries(schema);
  if (entries.length === 0) return <p className="hint">This pattern has no adjustable parameters.</p>;
  const groups = new Map<string, [string, ParamDef][]>();
  for (const e of entries) {
    const g = e[1].group ?? "";
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(e);
  }
  return (
    <div className="param-group">
      {[...groups.entries()].map(([g, items]) => (
        <div key={g} className="param-group">
          {g && <h4>{g}</h4>}
          {items.map(([k, d]) => <Param key={k} name={k} def={d} value={values[k]} disabled={disabled} onChange={(v) => onChange({ [k]: v })} />)}
        </div>
      ))}
    </div>
  );
}

function Param({ name, def, value, onChange, disabled }: { name: string; def: ParamDef; value: ParamValues[string] | undefined; onChange: (v: ParamValues[string]) => void; disabled?: boolean }) {
  const label = def.label ?? name;
  switch (def.type) {
    case "number": {
      const v = typeof value === "number" ? value : def.default;
      const step = def.step ?? (def.max - def.min) / 200;
      const decimals = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
      const toSlider = (x: number) => (def.log ? Math.log(Math.max(x, 1e-6)) : x);
      const fromSlider = (x: number) => (def.log ? Math.exp(x) : x);
      const lo = def.log ? Math.log(Math.max(def.min, 1e-6)) : def.min, hi = def.log ? Math.log(def.max) : def.max;
      return (
        <div className="param" title={def.description}>
          <span className="lbl">{label}</span>
          <span className="val">{v.toFixed(decimals)}{def.unit ? ` ${def.unit}` : ""}</span>
          <input className="ctl" type="range" min={lo} max={hi} step={def.log ? (hi - lo) / 400 : step} value={toSlider(v)} disabled={disabled}
            onChange={(e) => onChange(round(fromSlider(Number(e.target.value)), def.log ? 4 : decimals))}
            onDoubleClick={() => onChange(def.default)} aria-label={label} />
        </div>
      );
    }
    case "boolean": {
      const v = typeof value === "boolean" ? value : def.default;
      return (
        <div className="param" title={def.description} style={{ gridTemplateColumns: "1fr auto" }}>
          <span className="lbl">{label}</span>
          <button className={`switch ${v ? "on" : ""}`} role="switch" aria-checked={v} aria-label={label} disabled={disabled} onClick={() => onChange(!v)} />
        </div>
      );
    }
    case "select": {
      const v = typeof value === "string" ? value : def.default;
      if (def.options.length <= 4) {
        return (
          <div className="param" title={def.description}>
            <span className="lbl">{label}</span><span />
            <div className="seg ctl" role="radiogroup" aria-label={label} style={{ justifySelf: "start" }}>
              {def.options.map((o) => <button key={o} className={o === v ? "active" : ""} disabled={disabled} onClick={() => onChange(o)}>{o}</button>)}
            </div>
          </div>
        );
      }
      return (
        <div className="param" title={def.description}>
          <span className="lbl">{label}</span><span />
          <select className="select ctl" value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label}>
            {def.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        </div>
      );
    }
    case "color": {
      const v = typeof value === "string" ? value : def.default;
      return (
        <div className="param" title={def.description} style={{ gridTemplateColumns: "1fr auto" }}>
          <span className="lbl">{label}</span>
          <div className="color-ctl">
            <span className="mono faint">{v}</span>
            <input type="color" value={v} disabled={disabled} onChange={(e) => onChange(e.target.value)} aria-label={label} />
          </div>
        </div>
      );
    }
    case "palette": {
      const v = Array.isArray(value) ? value : def.default;
      return (
        <div className="param" title={def.description}>
          <span className="lbl">{label}</span><span className="val">{v.length} colors</span>
          <div className="palette-ctl ctl">
            {v.map((c, i) => (
              <span key={i} style={{ position: "relative" }}>
                <input type="color" value={c} disabled={disabled} onChange={(e) => onChange(v.map((x, j) => (j === i ? e.target.value : x)))} aria-label={`${label} color ${i + 1}`} />
                {v.length > 1 && !disabled && (
                  <button className="btn ghost icon sm" style={{ position: "absolute", top: -10, right: -10, minWidth: 20, padding: 2, background: "var(--surface-2)" }} onClick={() => onChange(v.filter((_, j) => j !== i))} aria-label="Remove color"><X style={{ width: 11, height: 11 }} /></button>
                )}
              </span>
            ))}
            {v.length < 12 && <button className="btn icon sm" disabled={disabled} onClick={() => onChange([...v, v[v.length - 1] ?? "#ffffff"])} aria-label="Add color"><Plus /></button>}
          </div>
        </div>
      );
    }
  }
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
