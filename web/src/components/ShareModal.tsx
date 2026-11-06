import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Copy, RefreshCw } from "lucide-react";
import { Modal } from "./Modal";
import { useStore } from "../state/store";

interface ShareInfo { guest: string; admin: string; guestPermission: string; }

export function ShareModal({ onClose }: { onClose: () => void }) {
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [which, setWhich] = useState<"guest" | "admin">("guest");
  const settings = useStore((s) => s.settings);
  const send = useStore((s) => s.send);
  const toast = useStore((s) => s.toast);
  const load = () => fetch("/api/share").then((r) => r.json()).then(setInfo).catch(() => toast("error", "Could not load share links"));
  useEffect(() => { void load(); }, []);
  const url = info ? (which === "guest" ? info.guest : info.admin) : "";
  const copy = async () => {
    try { await navigator.clipboard.writeText(url); toast("success", "Link copied"); } catch { toast("warning", "Select the link and copy it manually"); }
  };
  const regen = async () => {
    await fetch("/api/share/regenerate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ which }) });
    toast("success", `New ${which} link created. The old one no longer works.`);
    void load();
  };
  return (
    <Modal title="Share the console" onClose={onClose}>
      <p className="muted">Anyone on the office network with this link can open the console. Guests get the permission level below. Off the network, share through a tunnel such as Tailscale.</p>
      <div className="seg" role="tablist">
        <button className={which === "guest" ? "active" : ""} onClick={() => setWhich("guest")}>Guest link</button>
        <button className={which === "admin" ? "active" : ""} onClick={() => setWhich("admin")}>Admin link</button>
      </div>
      {which === "guest" && settings && (
        <label className="field"><span>Guests can</span>
          <select className="select" value={settings.sharing.guestPermission} onChange={(e) => send({ type: "setSettings", settings: { sharing: { ...settings.sharing, guestPermission: e.target.value as "view" | "control" | "edit" } } })}>
            <option value="view">View only: watch the preview</option>
            <option value="control">Control: pick patterns and scenes, tweak params, BPM, blackout</option>
            <option value="edit">Edit: also write patterns, scenes, playlists and use the agent</option>
          </select>
        </label>
      )}
      {which === "admin" && <p className="hint" style={{ color: "var(--warn)" }}>The admin link grants full access including the rig and output settings. Share it only with people you trust.</p>}
      {info && (
        <div className="stack" style={{ justifyItems: "center" }}>
          <div style={{ background: "#fff", padding: 12, borderRadius: 12 }}><QRCodeSVG value={url} size={180} /></div>
          <input className="input mono" readOnly value={url} onFocus={(e) => e.target.select()} />
          <div className="row">
            <button className="btn primary" onClick={copy}><Copy /> Copy link</button>
            <button className="btn" onClick={regen}><RefreshCw /> Make a new link</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
