import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, Pause, Play, Plus, SkipBack, SkipForward, Trash2 } from "lucide-react";
import type { Playlist, PlaylistStep } from "@lightesota/shared";
import { useStore } from "../state/store";

export function PlaylistsView() {
  const playlists = useStore((s) => s.playlists);
  const scenes = useStore((s) => s.scenes);
  const show = useStore((s) => s.show)!;
  const send = useStore((s) => s.send);
  const can = useStore((s) => s.can);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editor = can("editor");
  const control = can("guest");
  const playing = show.playlist;
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 250); return () => clearInterval(t); }, []);

  const newPlaylist = () => {
    const pl: Playlist = { id: "", name: `Playlist ${playlists.length + 1}`, steps: scenes.slice(0, 3).map((s) => ({ id: rid(), sceneId: s.id, duration: 8, unit: "bars" })), loop: true, shuffle: false, createdAt: 0, updatedAt: 0 };
    send({ type: "savePlaylist", playlist: pl });
  };

  const editing = playlists.find((p) => p.id === editingId) ?? null;

  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <div><h2 style={{ fontSize: 18 }}>Playlists</h2><p className="hint">Sequences of scenes that advance automatically, timed in bars (beat-synced) or seconds.</p></div>
        {editor && <button className="btn primary" onClick={newPlaylist} disabled={scenes.length === 0}><Plus /> New playlist</button>}
      </div>
      {playlists.length === 0 && <div className="empty">{scenes.length === 0 ? "Save a few scenes first, then build a playlist from them." : "No playlists yet."}</div>}
      <div className="stack">
        {playlists.map((pl) => {
          const isPlaying = playing?.playlistId === pl.id;
          const prog = isPlaying && playing ? Math.min(1, (Date.now() - playing.stepStartedAt) / Math.max(1, playing.stepEndsAt - playing.stepStartedAt)) : 0;
          return (
            <div key={pl.id} className="card">
              <div className="row" style={{ justifyContent: "space-between" }}>
                <div className="row">
                  <button className={`btn icon ${isPlaying ? "primary" : ""}`} disabled={!control || pl.steps.length === 0} onClick={() => (isPlaying ? send({ type: "stopPlaylist" }) : send({ type: "playPlaylist", playlistId: pl.id }))} aria-label={isPlaying ? "Stop" : "Play"}>{isPlaying ? <Pause /> : <Play />}</button>
                  <div><div style={{ fontWeight: 600 }}>{pl.name}</div><div className="hint">{pl.steps.length} steps · {pl.loop ? "loops" : "plays once"}{pl.shuffle ? " · shuffle" : ""}</div></div>
                </div>
                <div className="row">
                  {isPlaying && <><button className="btn icon sm" onClick={() => send({ type: "playlistPrev" })} aria-label="Previous"><SkipBack /></button><button className="btn icon sm" onClick={() => send({ type: "playlistNext" })} aria-label="Next"><SkipForward /></button></>}
                  {editor && <button className="btn sm" onClick={() => setEditingId(editing?.id === pl.id ? null : pl.id)}>{editing?.id === pl.id ? "Done" : "Edit"}</button>}
                </div>
              </div>
              {isPlaying && playing && (
                <div style={{ marginTop: 10 }}>
                  <div className="row" style={{ justifyContent: "space-between", fontSize: 12 }} ><span className="muted">Step {playing.stepIndex + 1} of {pl.steps.length}: {scenes.find((s) => s.id === pl.steps[playing.stepIndex]?.sceneId)?.name ?? "?"}</span><span className="faint tabular">{Math.max(0, Math.ceil((playing.stepEndsAt - Date.now()) / 1000))} s</span></div>
                  <div className="progress" style={{ marginTop: 4 }}><i style={{ width: `${prog * 100}%` }} /></div>
                </div>
              )}
              {editing?.id === pl.id && <PlaylistEditor pl={pl} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PlaylistEditor({ pl }: { pl: Playlist }) {
  const scenes = useStore((s) => s.scenes);
  const send = useStore((s) => s.send);
  const [confirm, setConfirm] = useState(false);
  const save = (patch: Partial<Playlist>) => send({ type: "savePlaylist", playlist: { ...pl, ...patch } });
  const setStep = (i: number, patch: Partial<PlaylistStep>) => save({ steps: pl.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const move = (i: number, d: number) => { const steps = [...pl.steps]; const [s] = steps.splice(i, 1); steps.splice(i + d, 0, s); save({ steps }); };
  return (
    <div className="stack" style={{ marginTop: 12 }}>
      <div className="row">
        <input className="input" style={{ maxWidth: 260 }} value={pl.name} onChange={(e) => save({ name: e.target.value })} aria-label="Playlist name" />
        <label className="row"><button className={`switch ${pl.loop ? "on" : ""}`} role="switch" aria-checked={pl.loop} onClick={() => save({ loop: !pl.loop })} /> Loop</label>
        <label className="row"><button className={`switch ${pl.shuffle ? "on" : ""}`} role="switch" aria-checked={pl.shuffle} onClick={() => save({ shuffle: !pl.shuffle })} /> Shuffle</label>
      </div>
      <div className="stack">
        {pl.steps.map((st, i) => (
          <div key={st.id} className="list-row">
            <span className="faint tabular" style={{ width: 20 }}>{i + 1}</span>
            <select className="select" style={{ flex: 2, minWidth: 120 }} value={st.sceneId} onChange={(e) => setStep(i, { sceneId: e.target.value })} aria-label="Scene">
              {scenes.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              {!scenes.some((s) => s.id === st.sceneId) && <option value={st.sceneId}>(missing scene)</option>}
            </select>
            <input className="input tabular" type="number" min={0.25} step={0.25} style={{ width: 80 }} value={st.duration} onChange={(e) => setStep(i, { duration: Number(e.target.value) })} aria-label="Duration" />
            <select className="select" style={{ width: 100 }} value={st.unit} onChange={(e) => setStep(i, { unit: e.target.value as "bars" | "seconds" })} aria-label="Unit"><option value="bars">bars</option><option value="seconds">seconds</option></select>
            <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><ArrowUp /></button>
            <button className="btn ghost icon sm" disabled={i === pl.steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><ArrowDown /></button>
            <button className="btn ghost icon sm" onClick={() => save({ steps: pl.steps.filter((_, j) => j !== i) })} aria-label="Remove step"><Trash2 /></button>
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button className="btn sm" disabled={scenes.length === 0} onClick={() => save({ steps: [...pl.steps, { id: rid(), sceneId: scenes[0].id, duration: 8, unit: "bars" }] })}><Plus /> Add step</button>
        {!confirm ? <button className="btn sm danger" onClick={() => setConfirm(true)}><Trash2 /> Delete playlist</button> : <button className="btn sm danger" onClick={() => send({ type: "deletePlaylist", playlistId: pl.id })}>Really delete</button>}
      </div>
    </div>
  );
}

const rid = () => Math.random().toString(36).slice(2, 9);
