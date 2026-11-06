import { X } from "lucide-react";
import { useStore } from "../state/store";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.level}`}>
          <span>{t.text}</span>
          <button className="btn ghost icon sm" onClick={() => dismiss(t.id)} aria-label="Dismiss"><X /></button>
        </div>
      ))}
    </div>
  );
}
