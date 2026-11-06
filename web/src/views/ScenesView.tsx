import { useState } from "react";
import { Pencil, Save, Star, Trash2 } from "lucide-react";
import type { Scene } from "@lightesota/shared";
import { useStore } from "../state/store";
import { Modal } from "../components/Modal";
import { SaveSceneModal } from "./LiveView";
import { timeAgo } from "../lib/format";

export function ScenesView() {
  const scenes = useStore((s) => s.scenes);
  const show = useStore((s) => s.show)!;
  const patterns = useStore((s) => s.patterns);
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const [edit, setEdit] = useState<Scene | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const control = can("guest");
  const editor = can("editor");
  const favorites = scenes.filter((s) => s.favorite);
  const others = scenes.filter((s) => !s.favorite);

  const Tile = ({ s }: { s: Scene }) => {
    const p = patterns.find((x) => x.id === s.patternId);
    return (
      <button className={`scene-tile ${s.id === show.activeSceneId ? "active" : ""}`} disabled={!control} onClick={() => send({ type: "recallScene", sceneId: s.id })} title={`Recall "${s.name}"`}>
        <div className="swatches">{(s.swatch.length ? s.swatch : ["#333"]).map((c, i) => <i key={i} style={{ background: c }} />)}</div>
        <div className="nm">{s.name}</div>
        <div className="meta"><span>{p?.name ?? (s.patternId ? "missing pattern" : "Manual scene")}</span><span>{s.bpm ? `${Math.round(s.bpm)} bpm` : ""}</span></div>
        {s.favorite && <Star className="star" style={{ width: 14, height: 14 }} fill="currentColor" />}
        {s.hotkey && <span className="kbd" style={{ position: "absolute", top: 6, left: 6 }}>{s.hotkey}</span>}
        {editor && <span className="btn ghost icon sm" style={{ position: "absolute", bottom: 4, right: 4 }} onClick={(e) => { e.stopPropagation(); setEdit(s); }} role="button" aria-label="Edit scene"><Pencil /></span>}
      </button>
    );
  };

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2 style={{ fontSize: 18 }}>Scenes</h2><p className="hint">A scene saves the pattern, parameters, wash modes, BPM and master. Laser arming is never saved. Press <span className="kbd">1</span>–<span className="kbd">9</span> to recall hotkey scenes.</p></div>
        {control && <button className="btn primary" onClick={() => setSaveOpen(true)}><Save /> Save current look</button>}
      </div>
      {scenes.length === 0 && <div className="empty">No scenes yet. Set up a look on the Live tab and save it.</div>}
      {favorites.length > 0 && <><h3 className="faint" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>Favorites</h3><div className="scene-grid">{favorites.map((s) => <Tile key={s.id} s={s} />)}</div></>}
      {others.length > 0 && <>{favorites.length > 0 && <h3 className="faint" style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em" }}>All scenes</h3>}<div className="scene-grid">{others.map((s) => <Tile key={s.id} s={s} />)}</div></>}
      {edit && <EditSceneModal scene={edit} onClose={() => setEdit(null)} />}
      {saveOpen && <SaveSceneModal onClose={() => setSaveOpen(false)} />}
    </div>
  );
}

function EditSceneModal({ scene, onClose }: { scene: Scene; onClose: () => void }) {
  const send = useStore((s) => s.send);
  const scenes = useStore((s) => s.scenes);
  const [name, setName] = useState(scene.name);
  const [hotkey, setHotkey] = useState<number | null>(scene.hotkey);
  const [favorite, setFavorite] = useState(scene.favorite);
  const [confirm, setConfirm] = useState(false);
  const save = () => {
    send({ type: "updateScene", scene: { id: scene.id, name: name.trim() || scene.name, hotkey, favorite } });
    onClose();
  };
  const taken = (n: number) => scenes.find((s) => s.hotkey === n && s.id !== scene.id);
  return (
    <Modal title="Edit scene" onClose={onClose}>
      <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <label className="field"><span>Hotkey</span>
        <div className="row">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <button key={n} className={`btn sm ${hotkey === n ? "active" : ""}`} onClick={() => setHotkey(hotkey === n ? null : n)} title={taken(n) ? `Currently: ${taken(n)!.name}` : ""}>{n}</button>)}
        </div>
        {hotkey && taken(hotkey) && <span className="hint">“{taken(hotkey)!.name}” also uses {hotkey}; this scene will take over.</span>}
      </label>
      <label className="row"><button className={`switch ${favorite ? "on" : ""}`} role="switch" aria-checked={favorite} onClick={() => setFavorite(!favorite)} /> <span>Favorite</span></label>
      <div className="hint">Saved {timeAgo(scene.updatedAt)}. To change what the scene looks like, recall it, adjust, then “Save current look” and choose update.</div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        {!confirm ? <button className="btn danger" onClick={() => setConfirm(true)}><Trash2 /> Delete</button>
          : <button className="btn danger" onClick={() => { send({ type: "deleteScene", sceneId: scene.id }); onClose(); }}>Really delete “{scene.name}”</button>}
        <div className="row"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save</button></div>
      </div>
    </Modal>
  );
}
