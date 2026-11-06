import { useEffect, useRef } from "react";
import { findProfile, type Fixture, type Rig } from "@lightesota/shared";
import { useStore } from "../state/store";
import { frameToCss, frameLuma } from "../lib/format";

interface Props {
  rig: Rig;
  mode: "live" | "edit";
  selectedId: string | null;
  onSelect?: (id: string | null) => void;
  onMove?: (id: string, x: number, y: number, done: boolean) => void;
  showLabels?: boolean;
  /** Draws fixtures with preview colors (from the store frame). */
  live?: boolean;
  /** Tight padding, no scale bar: for the picture-in-picture preview. */
  compact?: boolean;
}

/** Top-down room canvas used for both the live preview and the stage editor. */
export function Stage({ rig, mode, selectedId, onSelect, onMove, showLabels = true, live = true, compact = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({ scale: 40, ox: 0, oy: 0, w: 0, h: 0, dpr: 1, drag: null as null | { id: string; dx: number; dy: number; moved: boolean }, pan: null as null | { x: number; y: number; ox: number; oy: number }, hover: null as string | null });
  const propsRef = useRef({ rig, mode, selectedId, onSelect, onMove, showLabels, live, compact });
  propsRef.current = { rig, mode, selectedId, onSelect, onMove, showLabels, live, compact };

  // Fit room to canvas whenever size or room changes.
  const fit = () => {
    const s = state.current;
    const { rig, compact } = propsRef.current;
    const pad = compact ? 10 : 36;
    const sx = (s.w - pad * 2) / rig.room.width, sy = (s.h - pad * 2) / rig.room.height;
    s.scale = Math.max(4, Math.min(sx, sy));
    s.ox = (s.w - rig.room.width * s.scale) / 2;
    s.oy = (s.h - rig.room.height * s.scale) / 2;
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ro = new ResizeObserver(() => {
      const r = canvas.getBoundingClientRect();
      const s = state.current;
      s.dpr = Math.min(2, window.devicePixelRatio || 1);
      s.w = r.width; s.h = r.height;
      canvas.width = Math.round(r.width * s.dpr); canvas.height = Math.round(r.height * s.dpr);
      fit();
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { fit(); }, [rig.room.width, rig.room.height]);

  // Render loop
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d")!;
      const s = state.current;
      const { rig, mode, selectedId, showLabels, live, compact } = propsRef.current;
      const frame = useStore.getState().frame;
      const enabled = rig.fixtures.filter((f) => f.enabled);
      const css = getComputedStyle(canvas);
      const fg = css.getPropertyValue("--fg").trim(), fg3 = css.getPropertyValue("--fg-3").trim(), line = css.getPropertyValue("--line").trim(), accent = css.getPropertyValue("--accent").trim(), surface = css.getPropertyValue("--surface").trim(), bg = css.getPropertyValue("--bg").trim();
      const isDark = (css.getPropertyValue("color-scheme").trim() || "dark") === "dark";
      ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
      ctx.clearRect(0, 0, s.w, s.h);
      const X = (x: number) => s.ox + x * s.scale, Y = (y: number) => s.oy + y * s.scale;
      // Room
      // Floor: dark enough in both themes that colored and white light reads.
      ctx.fillStyle = isDark ? "rgba(0,0,0,0.35)" : "#3a3d47";
      ctx.fillRect(X(0), Y(0), rig.room.width * s.scale, rig.room.height * s.scale);
      // Grid
      ctx.strokeStyle = isDark ? line : "rgba(255,255,255,0.12)"; ctx.lineWidth = 1;
      const step = rig.room.gridStep || 0.5;
      const gridEvery = s.scale * step < 14 ? step * 2 : step;
      ctx.beginPath();
      for (let x = 0; x <= rig.room.width + 1e-6; x += gridEvery) { ctx.moveTo(X(x), Y(0)); ctx.lineTo(X(x), Y(rig.room.height)); }
      for (let y = 0; y <= rig.room.height + 1e-6; y += gridEvery) { ctx.moveTo(X(0), Y(y)); ctx.lineTo(X(rig.room.width), Y(y)); }
      ctx.globalAlpha = 0.6; ctx.stroke(); ctx.globalAlpha = 1;
      ctx.strokeStyle = fg3; ctx.lineWidth = 1.5;
      ctx.strokeRect(X(0), Y(0), rig.room.width * s.scale, rig.room.height * s.scale);
      // Shapes
      for (const sh of rig.room.shapes) {
        ctx.fillStyle = sh.color ?? (isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)");
        ctx.strokeStyle = fg3;
        if (sh.kind === "rect" && sh.w && sh.h) {
          ctx.fillRect(X(sh.x), Y(sh.y), sh.w * s.scale, sh.h * s.scale);
          ctx.strokeRect(X(sh.x), Y(sh.y), sh.w * s.scale, sh.h * s.scale);
          if (sh.text) { ctx.fillStyle = fg3; ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(sh.text, X(sh.x + sh.w / 2), Y(sh.y + sh.h / 2)); }
        } else if (sh.kind === "line" && sh.x2 !== undefined && sh.y2 !== undefined) {
          ctx.beginPath(); ctx.moveTo(X(sh.x), Y(sh.y)); ctx.lineTo(X(sh.x2), Y(sh.y2)); ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
        } else if (sh.kind === "label" && sh.text) {
          ctx.fillStyle = fg3; ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(sh.text, X(sh.x), Y(sh.y));
        }
      }
      // Glows first (live)
      if (live) {
        for (let i = 0; i < enabled.length; i++) {
          const f = enabled[i];
          const c = frame[i];
          const luma = frameLuma(c);
          if (luma <= 0.01) continue;
          const p = findProfile(f.profileId, rig.customProfiles);
          const r = ((p?.size ?? 0.3) / 2) * s.scale;
          const glow = r * (3 + luma * 4);
          const g = ctx.createRadialGradient(X(f.x), Y(f.y), r * 0.5, X(f.x), Y(f.y), glow);
          const col = frameToCss(c);
          g.addColorStop(0, col.replace("rgb", "rgba").replace(")", `, ${0.55 * luma})`));
          g.addColorStop(1, col.replace("rgb", "rgba").replace(")", ", 0)"));
          ctx.fillStyle = g;
          ctx.fillRect(X(f.x) - glow, Y(f.y) - glow, glow * 2, glow * 2);
        }
      }
      // Fixtures
      ctx.font = "11px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "top";
      for (let i = 0; i < rig.fixtures.length; i++) {
        const f = rig.fixtures[i];
        const idx = enabled.indexOf(f);
        const c = live && idx >= 0 ? frame[idx] : undefined;
        const p = findProfile(f.profileId, rig.customProfiles);
        const r = Math.max(6, ((p?.size ?? 0.3) / 2) * s.scale);
        const cx = X(f.x), cy = Y(f.y);
        ctx.save();
        ctx.translate(cx, cy); ctx.rotate((f.rotation * Math.PI) / 180);
        const fill = !f.enabled ? "#2a2c33" : c ? frameToCss(c) : (isDark ? surface : "#1f2129");
        ctx.fillStyle = fill;
        ctx.strokeStyle = f.id === selectedId ? accent : s.hover === f.id ? fg : fg3;
        ctx.lineWidth = f.id === selectedId ? 3 : 1.5;
        ctx.beginPath();
        if (p?.shape === "square") ctx.rect(-r, -r, r * 2, r * 2);
        else if (p?.shape === "bar") ctx.rect(-r * 2.2, -r * 0.45, r * 4.4, r * 0.9);
        else ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill(); ctx.stroke();
        if (p?.shape !== "bar") { // direction tick
          ctx.beginPath(); ctx.moveTo(0, -r); ctx.lineTo(0, -r - 5); ctx.strokeStyle = fg3; ctx.lineWidth = 1.5; ctx.stroke();
        }
        if (!f.enabled) { ctx.strokeStyle = fg3; ctx.beginPath(); ctx.moveTo(-r, -r); ctx.lineTo(r, r); ctx.stroke(); }
        ctx.restore();
        if (showLabels) {
          // Halo so labels stay readable over glows in either theme.
          ctx.lineWidth = 3; ctx.strokeStyle = isDark ? "rgba(0,0,0,0.75)" : "rgba(40,42,50,0.85)"; ctx.lineJoin = "round";
          ctx.strokeText(f.name, cx, cy + r + 6);
          ctx.fillStyle = f.id === selectedId ? accent : "#e6e4dd";
          ctx.fillText(f.name, cx, cy + r + 6);
          if (mode === "edit" && f.address) { ctx.strokeText(`@${f.address}`, cx, cy + r + 19); ctx.fillStyle = "#b9b7b0"; ctx.fillText(`@${f.address}`, cx, cy + r + 19); }
        }
      }
      void bg; void compact;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // Pointer interaction
  const hit = (px: number, py: number): Fixture | null => {
    const s = state.current; const { rig } = propsRef.current;
    let best: Fixture | null = null, bd = Infinity;
    for (const f of rig.fixtures) {
      const p = findProfile(f.profileId, rig.customProfiles);
      const r = Math.max(14, ((p?.size ?? 0.3) / 2) * s.scale + 6);
      const d = Math.hypot(s.ox + f.x * s.scale - px, s.oy + f.y * s.scale - py);
      if (d < r && d < bd) { bd = d; best = f; }
    }
    return best;
  };
  const local = (e: React.PointerEvent) => { const r = (e.target as HTMLElement).getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onPointerDown = (e: React.PointerEvent) => {
    const { x, y } = local(e); const s = state.current; const { mode, onSelect } = propsRef.current;
    const f = hit(x, y);
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    if (f) {
      onSelect?.(f.id);
      if (mode === "edit") s.drag = { id: f.id, dx: x - (s.ox + f.x * s.scale), dy: y - (s.oy + f.y * s.scale), moved: false };
    } else {
      onSelect?.(null);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const { x, y } = local(e); const s = state.current; const { rig, onMove } = propsRef.current;
    if (s.drag) {
      const step = rig.room.gridStep || 0.5;
      let fx = (x - s.drag.dx - s.ox) / s.scale, fy = (y - s.drag.dy - s.oy) / s.scale;
      if (!e.altKey) { fx = Math.round(fx / step) * step; fy = Math.round(fy / step) * step; }
      s.drag.moved = true;
      onMove?.(s.drag.id, Math.round(fx * 100) / 100, Math.round(fy * 100) / 100, false);
    } else {
      const h = hit(x, y);
      const id = h?.id ?? null;
      if (id !== s.hover) { s.hover = id; (e.target as HTMLElement).style.cursor = id ? (propsRef.current.mode === "edit" ? "grab" : "pointer") : "default"; }
    }
  };
  const onPointerUp = () => {
    const s = state.current; const { rig, onMove } = propsRef.current;
    if (s.drag?.moved) { const f = rig.fixtures.find((x) => x.id === s.drag!.id); if (f) onMove?.(f.id, f.x, f.y, true); }
    s.drag = null; s.pan = null;
  };
  return <canvas ref={canvasRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} aria-label="Room plan" />;
}
