import express from "express";
import fs from "node:fs";
import path from "node:path";
import { PATTERN_API_DOC } from "../../../shared/src/index.js";
import { config } from "../config.js";
import type { AppContext } from "./context.js";
import { roleAllows } from "../../../shared/src/index.js";

export function createApp(ctx: AppContext) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  // Share links: /join/<token> or /?t=<token> set a cookie and land on the app.
  app.get("/join/:token", (req, res) => {
    res.cookie("lt_token", req.params.token, { httpOnly: false, sameSite: "lax", maxAge: 365 * 24 * 3600 * 1000, path: "/" });
    res.redirect("/");
  });
  app.get("/", (req, res, next) => {
    const t = req.query.t;
    if (typeof t === "string" && t) {
      res.cookie("lt_token", t, { httpOnly: false, sameSite: "lax", maxAge: 365 * 24 * 3600 * 1000, path: "/" });
      return res.redirect("/");
    }
    next();
  });

  app.get("/api/health", (_req, res) => res.json({ ok: true, status: ctx.output.status(ctx.agent.hasCredentials()) }));
  app.get("/api/me", (req, res) => res.json({ role: ctx.auth.roleForRequest(req) }));
  app.get("/api/pattern-api.md", (_req, res) => res.type("text/markdown").send(PATTERN_API_DOC));

  // Admin-only: share links + export/import.
  const admin = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!roleAllows(ctx.auth.roleForRequest(req), "admin")) return res.status(403).json({ error: "admin only" });
    next();
  };
  app.get("/api/share", admin, (req, res) => {
    const s = ctx.settingsFile.get();
    const base = s.sharing.publicUrl || `${req.protocol}://${req.get("host")}`;
    res.json({
      guest: `${base}/join/${ctx.auth.guestToken}`,
      admin: `${base}/join/${ctx.auth.adminToken}`,
      guestPermission: s.sharing.guestPermission,
    });
  });
  app.post("/api/share/regenerate", admin, (req, res) => {
    const which = req.body?.which === "admin" ? "admin" : "guest";
    if (which === "admin") ctx.auth.regenerateAdmin(); else ctx.auth.regenerateGuest();
    res.json({ ok: true });
  });
  app.get("/api/export", admin, (_req, res) => {
    const patterns = ctx.library.listPatterns().filter((p) => !p.builtin).map((p) => ({ id: p.id, source: ctx.library.getPattern(p.id)!.source }));
    res.setHeader("Content-Disposition", `attachment; filename="lightesota-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ version: 1, rig: ctx.rigFile.get(), settings: ctx.settingsFile.get(), scenes: ctx.library.scenes, playlists: ctx.library.playlists, patterns });
  });
  app.post("/api/import", admin, (req, res) => {
    const body = req.body ?? {};
    try {
      if (body.rig) ctx.rigFile.set(body.rig);
      if (Array.isArray(body.patterns)) for (const p of body.patterns) if (p?.source) ctx.library.savePattern({ id: p.id, source: p.source });
      if (Array.isArray(body.scenes)) for (const s of body.scenes) ctx.library.upsertScene(s);
      if (Array.isArray(body.playlists)) for (const p of body.playlists) ctx.library.upsertPlaylist(p);
      ctx.applyConfig();
      res.json({ ok: true });
    } catch (e) { res.status(400).json({ error: (e as Error).message }); }
  });

  // Static web app (built) with SPA fallback.
  if (fs.existsSync(config.webDist)) {
    app.use(express.static(config.webDist, {
      index: "index.html", maxAge: "1h",
      setHeaders: (res, file) => { if (file.endsWith(".html") || file.endsWith(".webmanifest")) res.setHeader("Cache-Control", "no-cache"); },
    }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api") || req.path.startsWith("/ws")) return next();
      res.sendFile(path.join(config.webDist, "index.html"));
    });
  } else {
    app.get("/", (_req, res) => res.type("text/plain").send("Lightesota server is running. Build the web app (npm run build) or use the Vite dev server on :5173."));
  }
  return app;
}
