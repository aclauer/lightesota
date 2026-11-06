import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { oneDark } from "@codemirror/theme-one-dark";
import { BookOpen, Bot, Copy, Play, Plus, Save, Trash2 } from "lucide-react";
import type { Pattern, PatternMeta } from "@lightesota/shared";
import { useStore } from "../state/store";
import { ParamControls } from "../components/ParamControls";
import { Modal } from "../components/Modal";
import { effectiveTheme } from "../lib/theme";

const TEMPLATE = `export default {
  name: "My Pattern",
  description: "What it looks like.",
  tags: ["custom"],
  params: {
    color: { type: "color", default: "#ff6a00", label: "Color" },
    speed: { type: "number", default: 1, min: 0, max: 4, step: 0.05, label: "Speed", unit: "x" },
  },
  render(ctx) {
    const { color, speed } = ctx.params;
    for (const f of ctx.fixtures) {
      const v = 0.5 + 0.5 * Math.sin(ctx.beat * speed * Math.PI * 2 + f.nx * Math.PI);
      ctx.set(f, color, { dim: v });
    }
  },
};
`;

export function PatternsView() {
  const patterns = useStore((s) => s.patterns);
  const show = useStore((s) => s.show)!;
  const can = useStore((s) => s.can);
  const send = useStore((s) => s.send);
  const editorId = useStore((s) => s.editorPatternId);
  const openEditor = useStore((s) => s.openEditor);
  const [filter, setFilter] = useState("");
  const editor = can("editor");
  const control = can("guest");
  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return patterns.filter((p) => !f || p.name.toLowerCase().includes(f) || p.tags.some((t) => t.includes(f)) || p.description.toLowerCase().includes(f));
  }, [patterns, filter]);

  if (editorId !== null && editor) return <PatternEditor patternId={editorId} />;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2 style={{ fontSize: 18 }}>Patterns</h2><p className="hint">Tap to make a pattern live. Hold the crossfade in mind: it is set on the Live tab.</p></div>
        <div className="row">
          <input className="input" style={{ width: 180 }} placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Search patterns" />
          {editor && <button className="btn primary" onClick={() => openEditor("")}><Plus /> New</button>}
        </div>
      </div>
      <div className="grid-cards">
        <button className={`pcard ${show.patternId === null ? "active" : ""}`} disabled={!control} onClick={() => send({ type: "setPattern", patternId: null })}>
          <div className="name"><span>Dark</span></div>
          <div className="swatches"><i style={{ background: "#000" }} /></div>
          <div className="desc">No pattern. Fixtures go dark (fixture overrides still apply).</div>
        </button>
        {list.map((p) => <PatternCard key={p.id} p={p} active={p.id === show.patternId} onActivate={() => send({ type: "setPattern", patternId: p.id })} onEdit={editor ? () => openEditor(p.id) : undefined} disabled={!control} />)}
      </div>
    </div>
  );
}

function PatternCard({ p, active, onActivate, onEdit, disabled }: { p: PatternMeta; active: boolean; onActivate: () => void; onEdit?: () => void; disabled: boolean }) {
  return (
    <div className={`pcard ${active ? "active" : ""}`} onClick={() => !disabled && !p.error && onActivate()} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && !disabled && onActivate()} aria-pressed={active}>
      <div className="name"><span>{p.name}</span>{p.usesBeat && <span className="pill accent" title="Follows the BPM">BPM</span>}</div>
      <div className="swatches">{(p.swatch?.length ? p.swatch : ["#222"]).map((c, i) => <i key={i} style={{ background: c }} />)}</div>
      <div className="desc">{p.error ? <span style={{ color: "var(--danger)" }}>Error: {p.error}</span> : p.description}</div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div className="tags">{p.tags.slice(0, 3).map((t) => <span key={t} className="pill">{t}</span>)}{p.builtin && <span className="pill" title="Built-in">built-in</span>}</div>
        {onEdit && <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); onEdit(); }}>Edit</button>}
      </div>
    </div>
  );
}

function PatternEditor({ patternId }: { patternId: string }) {
  const patterns = useStore((s) => s.patterns);
  const show = useStore((s) => s.show)!;
  const request = useStore((s) => s.request);
  const send = useStore((s) => s.send);
  const loadPattern = useStore((s) => s.loadPattern);
  const openEditor = useStore((s) => s.openEditor);
  const setView = useStore((s) => s.setView);
  const toast = useStore((s) => s.toast);
  const theme = useStore((s) => s.theme);
  const cache = useStore((s) => s.patternCache);
  const [source, setSource] = useState<string | null>(null);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [docOpen, setDocOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const dirty = useRef(false);
  const meta = patterns.find((p) => p.id === patternId);
  const isNew = patternId === "";
  const [, forceDark] = useState(0);
  useEffect(() => { const mq = window.matchMedia("(prefers-color-scheme: dark)"); const h = () => forceDark((x) => x + 1); mq.addEventListener("change", h); return () => mq.removeEventListener("change", h); }, []);

  useEffect(() => {
    if (isNew) { setSource(TEMPLATE); setLoadedId(""); dirty.current = false; return; }
    if (loadedId === patternId) return;
    loadPattern(patternId).then((p: Pattern) => { setSource(p.source); setLoadedId(patternId); dirty.current = false; setError(p.error ?? null); }).catch((e: Error) => toast("error", e.message));
  }, [patternId, isNew, loadedId, loadPattern, toast]);

  const live = show.patternId === patternId;
  const save = async (andApply: boolean) => {
    if (source === null) return;
    setSaving(true); setError(null);
    try {
      const id = await request<string>({ type: "savePattern", pattern: { id: isNew ? undefined : patternId, source } });
      dirty.current = false;
      if (id !== patternId) openEditor(id);
      if (andApply) send({ type: "setPattern", patternId: id, crossfadeMs: 300 });
      toast("success", meta?.builtin ? "Saved as a new pattern (built-ins are read-only)" : "Saved");
    } catch (e) { setError((e as Error).message); }
    finally { setSaving(false); }
  };
  const del = () => { send({ type: "deletePattern", patternId }); openEditor(null); };
  const dup = async () => { try { const id = await request<string>({ type: "duplicatePattern", patternId }); openEditor(id); } catch (e) { toast("error", (e as Error).message); } };
  const dark = effectiveTheme(theme) === "dark";
  const cached = cache[patternId];

  // Keyboard: Cmd/Ctrl+S saves
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === "s") { e.preventDefault(); void save(live); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="editor">
      <div className="list">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <button className="btn sm ghost" onClick={() => openEditor(null)}>← All patterns</button>
          <button className="btn sm" onClick={() => openEditor("")}><Plus /> New</button>
        </div>
        <div className="plist">
          {patterns.map((p) => (
            <button key={p.id} className={p.id === patternId ? "active" : ""} onClick={() => openEditor(p.id)}>
              <span className="sw">{(p.swatch?.length ? p.swatch : ["#333"]).slice(0, 4).map((c, i) => <i key={i} style={{ background: c }} />)}</span>
              <span className="t">{p.name}</span>
              {p.id === show.patternId && <span className="dot" style={{ background: "var(--ok)" }} title="Live" />}
            </button>
          ))}
        </div>
      </div>
      <div className="code">
        <div className="row" style={{ justifyContent: "space-between" }}>
          <div className="row">
            <h2 style={{ fontSize: 16 }}>{isNew ? "New pattern" : meta?.name ?? "…"}</h2>
            {meta?.builtin && <span className="pill" title="Saving creates an editable copy">built-in</span>}
            {live && <span className="pill ok">live</span>}
          </div>
          <div className="row">
            <button className="btn sm ghost" onClick={() => setDocOpen(true)} title="Pattern API reference"><BookOpen /> API</button>
            <button className="btn sm ghost" onClick={() => setView("agent")} title="Ask the agent to change this pattern"><Bot /> Ask agent</button>
            {!isNew && <button className="btn sm ghost" onClick={() => void dup()} title="Duplicate"><Copy /></button>}
            {!isNew && !meta?.builtin && (!confirm ? <button className="btn sm ghost" onClick={() => setConfirm(true)} title="Delete"><Trash2 /></button> : <button className="btn sm danger" onClick={del}>Delete?</button>)}
            <button className="btn sm" disabled={saving || source === null} onClick={() => void save(false)}><Save /> Save</button>
            <button className="btn sm primary" disabled={saving || source === null} onClick={() => void save(true)}><Play /> {live ? "Save & reload" : "Save & apply"}</button>
          </div>
        </div>
        <div className="cm-wrap">
          {source !== null && (
            <CodeMirror value={source} height="100%" theme={dark ? oneDark : "light"} extensions={[javascript()]} onChange={(v) => { setSource(v); dirty.current = true; }} basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: true, bracketMatching: true, highlightActiveLine: true }} />
          )}
        </div>
        {error ? <div className="err">{error}</div> : <div className="hint">Tip: <span className="kbd">⌘S</span>/<span className="kbd">Ctrl+S</span> saves{live ? " and reloads the live pattern with the current params" : ""}. Everything in <code>params</code> becomes a live control.</div>}
      </div>
      <div className="side">
        <div className="card">
          <h3>Live parameters</h3>
          {live && meta ? (
            <ParamControls schema={meta.params} values={show.params} onChange={(patch) => send({ type: "setParams", params: patch })} />
          ) : meta ? (
            <div className="stack"><p className="hint">Not live. Apply it to tune parameters here while watching the room.</p><button className="btn" onClick={() => send({ type: "setPattern", patternId })}><Play /> Make live</button></div>
          ) : <p className="hint">Save the pattern first.</p>}
        </div>
        {cached?.description && <div className="card"><h3>About</h3><p className="muted">{cached.description}</p><div className="row" style={{ marginTop: 8 }}>{cached.tags.map((t) => <span key={t} className="pill">{t}</span>)}</div></div>}
      </div>
      {docOpen && <ApiDocModal onClose={() => setDocOpen(false)} />}
    </div>
  );
}

function ApiDocModal({ onClose }: { onClose: () => void }) {
  const [doc, setDoc] = useState("Loading…");
  useEffect(() => { fetch("/api/pattern-api.md").then((r) => r.text()).then(setDoc).catch(() => setDoc("Could not load the reference.")); }, []);
  return (
    <Modal title="Pattern API" onClose={onClose} wide>
      <pre className="mono" style={{ whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.5, margin: 0 }}>{doc}</pre>
    </Modal>
  );
}
