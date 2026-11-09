import { useEffect } from "react";
import { useStore } from "./state/store";
import { Header } from "./components/Header";
import { Nav } from "./components/Nav";
import { Toasts } from "./components/Toasts";
import { MiniStage } from "./components/MiniStage";
import { LiveView } from "./views/LiveView";
import { PatternsView } from "./views/PatternsView";
import { ScenesView } from "./views/ScenesView";
import { PlaylistsView } from "./views/PlaylistsView";
import { StageEditorView } from "./views/StageEditorView";
import { SettingsView } from "./views/SettingsView";
import { useHotkeys } from "./lib/hotkeys";

export function App() {
  const view = useStore((s) => s.view);
  const rig = useStore((s) => s.rig);
  useHotkeys();
  useEffect(() => {
    const onHash = () => {
      const v = location.hash.replace("#", "");
      if (v === "agent") { useStore.getState().setView("live"); return; } // the agent lives on the Live tab now
      if (v && v !== useStore.getState().view) useStore.getState().setView(v as never);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  return (
    <div className={`app view-${view} ${rig && view !== "live" ? "pip-visible" : ""}`}>
      <Header />
      <Nav />
      <main>
        {!rig ? (
          <div className="empty">Connecting to the lighting server…</div>
        ) : view === "live" ? <LiveView />
          : view === "patterns" ? <PatternsView />
          : view === "scenes" ? <ScenesView />
          : view === "playlists" ? <PlaylistsView />
          : view === "stage" ? <StageEditorView />
          : <SettingsView />}
      </main>
      {rig && view !== "live" && <MiniStage />}
      <Toasts />
    </div>
  );
}
