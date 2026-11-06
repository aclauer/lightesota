import { useEffect } from "react";
import { useStore } from "../state/store";

/** Global keyboard shortcuts (desktop). Ignored while typing in inputs. */
export function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable || t.closest(".cm-editor"))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      if (!s.can("guest")) return;
      if (e.code === "Space") { e.preventDefault(); s.send({ type: "setBlackout", blackout: !s.show?.blackout }); }
      else if (e.key === "t" || e.key === "T") s.send({ type: "tap" });
      else if (e.key === "r" || e.key === "R") s.send({ type: "resync" });
      else if (e.key === "[") s.send({ type: "nudge", ms: -20 });
      else if (e.key === "]") s.send({ type: "nudge", ms: 20 });
      else if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key);
        const scene = s.scenes.find((sc) => sc.hotkey === n) ?? s.scenes[n - 1];
        if (scene) s.send({ type: "recallScene", sceneId: scene.id });
      }
      else if (e.key === "0") s.send({ type: "setPattern", patternId: null });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
