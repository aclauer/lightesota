import { useState } from "react";
import { Modal } from "./Modal";
import { useStore } from "../state/store";
import { timeAgo } from "../lib/format";

export function PresenceModal({ onClose }: { onClose: () => void }) {
  const presence = useStore((s) => s.presence);
  const deviceId = useStore((s) => s.deviceId);
  const myName = useStore((s) => s.myName);
  const setMyName = useStore((s) => s.setMyName);
  const [name, setName] = useState(myName);
  return (
    <Modal title="Who's here" onClose={onClose}>
      <label className="field"><span>Your name</span>
        <div className="row nowrap">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={24} placeholder="Your name" />
          <button className="btn primary" onClick={() => { setMyName(name.trim() || myName); onClose(); }}>Save</button>
        </div>
      </label>
      <div className="stack">
        {presence.map((p) => (
          <div key={p.id} className="list-row">
            <span className="avatar" style={{ background: p.color }}>{p.name.slice(0, 1).toUpperCase()}</span>
            <div className="grow"><div className="t">{p.name}{p.deviceId === deviceId ? " (you)" : ""}</div><div className="s">{p.role} · joined {timeAgo(p.connectedAt)}{p.connections > 1 ? ` · ${p.connections} tabs` : ""}</div></div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
