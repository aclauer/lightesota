import { LayoutGrid, Map, Play, Settings } from "lucide-react";
import { useStore, type View } from "../state/store";

const items: { id: View; label: string; icon: typeof Play; min?: "admin" | "editor" }[] = [
  { id: "live", label: "Live", icon: Play },
  { id: "patterns", label: "Patterns", icon: LayoutGrid },
  { id: "stage", label: "Stage", icon: Map, min: "admin" },
  { id: "settings", label: "Settings", icon: Settings },
];

export function Nav() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const can = useStore((s) => s.can);
  const role = useStore((s) => s.role);
  const visible = (i: typeof items[number]) => !i.min || can(i.min);
  return (
    <nav className="nav" aria-label="Sections">
      {items.filter(visible).map((i) => (
        <button key={i.id} className={view === i.id ? "active" : ""} onClick={() => setView(i.id)} aria-current={view === i.id ? "page" : undefined}>
          <i.icon strokeWidth={1.8} />
          <span>{i.label}</span>
        </button>
      ))}
      <div className="grow" />
      <div className="desktop-only faint" style={{ fontSize: 10.5, textAlign: "center", padding: "6px 0" }}>{role}</div>
    </nav>
  );
}
