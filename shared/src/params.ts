import type { ParamDef, ParamSchema, ParamValues } from "./types.js";

export function defaultParams(schema: ParamSchema): ParamValues {
  const out: ParamValues = {};
  for (const [k, d] of Object.entries(schema)) out[k] = Array.isArray(d.default) ? [...d.default] : d.default;
  return out;
}

/** Coerce incoming values to the schema; unknown keys dropped, bad values replaced by defaults. */
export function sanitizeParams(schema: ParamSchema, values: ParamValues | undefined): ParamValues {
  const out = defaultParams(schema);
  if (!values) return out;
  for (const [k, d] of Object.entries(schema)) {
    const v = values[k];
    if (v === undefined) continue;
    const c = coerceParam(d, v);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export function coerceParam(d: ParamDef, v: unknown): ParamValues[string] | undefined {
  switch (d.type) {
    case "number": {
      const n = typeof v === "number" ? v : Number(v);
      if (!Number.isFinite(n)) return undefined;
      return Math.min(d.max, Math.max(d.min, n));
    }
    case "boolean":
      return typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined;
    case "select":
      return typeof v === "string" && d.options.includes(v) ? v : undefined;
    case "color":
      return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : undefined;
    case "palette":
      return Array.isArray(v) && v.every((c) => typeof c === "string" && /^#[0-9a-fA-F]{6}$/.test(c))
        ? v.map((c) => c.toLowerCase()) : undefined;
  }
}

/** Validate a schema object produced by a pattern. Returns a clean schema or throws. */
export function validateSchema(raw: unknown): ParamSchema {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error("params must be an object");
  const out: ParamSchema = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k)) throw new Error(`param "${k}": invalid name`);
    if (typeof v !== "object" || v === null) throw new Error(`param "${k}": must be an object`);
    const d = v as Record<string, unknown>;
    const base = {
      label: typeof d.label === "string" ? d.label : undefined,
      description: typeof d.description === "string" ? d.description : undefined,
      group: typeof d.group === "string" ? d.group : undefined,
    };
    switch (d.type) {
      case "number": {
        const min = Number(d.min ?? 0), max = Number(d.max ?? 1);
        const def = Number(d.default ?? min);
        if (![min, max, def].every(Number.isFinite) || max <= min) throw new Error(`param "${k}": bad number range`);
        out[k] = { ...base, type: "number", min, max, default: Math.min(max, Math.max(min, def)),
          step: typeof d.step === "number" ? d.step : undefined,
          unit: typeof d.unit === "string" ? d.unit : undefined,
          log: d.log === true };
        break;
      }
      case "color": {
        const c = coerceParam({ type: "color", default: "#ffffff" }, d.default ?? "#ffffff");
        if (typeof c !== "string") throw new Error(`param "${k}": default must be a #rrggbb color`);
        out[k] = { ...base, type: "color", default: c };
        break;
      }
      case "boolean":
        out[k] = { ...base, type: "boolean", default: d.default === true };
        break;
      case "select": {
        const options = Array.isArray(d.options) ? d.options.map(String) : [];
        if (options.length === 0) throw new Error(`param "${k}": select needs options`);
        const def = typeof d.default === "string" && options.includes(d.default) ? d.default : options[0];
        out[k] = { ...base, type: "select", options, default: def };
        break;
      }
      case "palette": {
        const c = coerceParam({ type: "palette", default: [] }, d.default ?? ["#ffffff"]);
        if (!Array.isArray(c) || c.length === 0) throw new Error(`param "${k}": palette default must be an array of #rrggbb colors`);
        out[k] = { ...base, type: "palette", default: c };
        break;
      }
      default:
        throw new Error(`param "${k}": unknown type "${String(d.type)}" (number|color|boolean|select|palette)`);
    }
  }
  return out;
}
