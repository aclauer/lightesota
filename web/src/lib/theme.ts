export type ThemePref = "system" | "light" | "dark";

export function readThemePref(): ThemePref {
  try {
    const t = localStorage.getItem("lt-theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch { return "system"; }
}

export function applyTheme(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === "system") delete root.dataset.theme; else root.dataset.theme = pref;
  try { if (pref === "system") localStorage.removeItem("lt-theme"); else localStorage.setItem("lt-theme", pref); } catch { /* ignore */ }
}

export function effectiveTheme(pref: ThemePref): "light" | "dark" {
  if (pref !== "system") return pref;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
