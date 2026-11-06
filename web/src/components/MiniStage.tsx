import { useState } from "react";
import { ChevronDown, ChevronUp, Maximize2 } from "lucide-react";
import { COORDINATED_SHOWS } from "@lightesota/shared";
import { useStore } from "../state/store";
import { Stage } from "./Stage";

/** Picture-in-picture live preview shown on every tab except Live (desktop widths). */
export function MiniStage() {
  const rig = useStore((s) => s.rig);
  const show = useStore((s) => s.show);
  const patterns = useStore((s) => s.patterns);
  const setView = useStore((s) => s.setView);
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem("lt-pip") === "0"; } catch { return false; } });
  if (!rig || !show) return null;
  const pattern = patterns.find((p) => p.id === show.patternId);
  const muted = show.stopped || show.blackout;
  const title = show.stopped ? "Stopped" : show.blackout ? "Temporary blackout" : COORDINATED_SHOWS.find((s) => s.id === show.coordinatedShow?.id)?.name ?? pattern?.name ?? "Manual lighting";
  const toggle = () => { const next = !collapsed; setCollapsed(next); try { localStorage.setItem("lt-pip", next ? "0" : "1"); } catch { /* ignore */ } };
  return (
    <div className={`pip ${collapsed ? "collapsed" : ""}`} aria-label="Live preview">
      <div className="pip-bar">
        <span className={`dot ${muted ? "" : "on"}`} style={{ background: muted ? "var(--fg-3)" : "var(--ok)" }} />
        <span className="pip-title">{title}</span>
        <button className="btn ghost icon sm" onClick={() => setView("live")} title="Open Live" aria-label="Open Live"><Maximize2 /></button>
        <button className="btn ghost icon sm" onClick={toggle} title={collapsed ? "Show preview" : "Hide preview"} aria-label={collapsed ? "Show preview" : "Hide preview"}>{collapsed ? <ChevronUp /> : <ChevronDown />}</button>
      </div>
      {!collapsed && (
        <div className="pip-stage" style={{ height: Math.round(Math.min(260, Math.max(120, (280 * rig.room.height) / rig.room.width + 20))) }} onClick={() => setView("live")} role="button" tabIndex={0} onKeyDown={(e) => e.key === "Enter" && setView("live")} title="Click to open Live">
          <Stage rig={rig} mode="live" selectedId={null} showLabels={false} compact />
        </div>
      )}
    </div>
  );
}
