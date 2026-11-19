/** App themes: "system" follows the OS light/dark setting (stylesheet defaults); every other theme
 * sets the colour tokens inline. Choice and accent are saved per browser. */

export interface ThemeDef {
  id: string;
  name: string;
  dark: boolean;
  bg: string;
  surface: string;
  surface2: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
}

const t = (id: string, name: string, dark: boolean, bg: string, surface: string, surface2: string,
  text: string, muted: string, border: string, accent: string): ThemeDef =>
  ({ id, name, dark, bg, surface, surface2, text, muted, border, accent });

export const THEMES: ThemeDef[] = [
  t("dark", "Dark", true, "#0b0e14", "#141924", "#1a2030", "#e7eaf0", "#8a93a4", "#262d3b", "#5b7cfa"),
  t("light", "Light", false, "#f4f5f8", "#ffffff", "#f8f9fb", "#11151c", "#616b7a", "#e5e8ee", "#3b5bdb"),
  t("midnight", "Midnight", true, "#000000", "#0a0a0a", "#141414", "#e6e6e6", "#8a8a8a", "#232323", "#3b82f6"),
  t("dracula", "Dracula", true, "#21222c", "#282a36", "#343746", "#f8f8f2", "#a4acc8", "#44475a", "#bd93f9"),
  t("nord", "Nord", true, "#2e3440", "#3b4252", "#434c5e", "#eceff4", "#a8b0bd", "#4c566a", "#88c0d0"),
  t("tokyo-night", "Tokyo Night", true, "#16161e", "#1a1b26", "#24283b", "#c0caf5", "#7f84a3", "#2a2f45", "#7aa2f7"),
  t("catppuccin-mocha", "Catppuccin Mocha", true, "#11111b", "#1e1e2e", "#313244", "#cdd6f4", "#9399b2", "#45475a", "#cba6f7"),
  t("one-dark", "One Dark", true, "#21252b", "#282c34", "#2f343f", "#abb2bf", "#7f848e", "#3e4451", "#61afef"),
  t("gruvbox", "Gruvbox", true, "#1d2021", "#282828", "#32302f", "#ebdbb2", "#a89984", "#3c3836", "#fe8019"),
  t("monokai", "Monokai", true, "#1e1f1c", "#272822", "#31322c", "#f8f8f2", "#a59f85", "#3e3d32", "#a6e22e"),
  t("solarized-dark", "Solarized Dark", true, "#002b36", "#073642", "#0a4250", "#eee8d5", "#93a1a1", "#174652", "#268bd2"),
  t("rose-pine", "Rosé Pine", true, "#191724", "#1f1d2e", "#26233a", "#e0def4", "#908caa", "#403d52", "#c4a7e7"),
  t("github-dark", "GitHub Dark", true, "#010409", "#0d1117", "#161b22", "#e6edf3", "#8d96a0", "#30363d", "#2f81f7"),
  t("everforest", "Everforest", true, "#272e33", "#2e383c", "#374145", "#d3c6aa", "#9da9a0", "#414b50", "#a7c080"),
  t("kanagawa", "Kanagawa", true, "#16161d", "#1f1f28", "#2a2a37", "#dcd7ba", "#9c9a8a", "#363646", "#7e9cd8"),
  t("solarized-light", "Solarized Light", false, "#eee8d5", "#fdf6e3", "#f5efdc", "#073642", "#5f747c", "#ddd6c1", "#268bd2"),
  t("github-light", "GitHub Light", false, "#f6f8fa", "#ffffff", "#f6f8fa", "#1f2328", "#59636e", "#d1d9e0", "#0969da"),
  t("catppuccin-latte", "Catppuccin Latte", false, "#dce0e8", "#eff1f5", "#e6e9ef", "#4c4f69", "#6c6f85", "#ccd0da", "#8839ef"),
  t("rose-pine-dawn", "Rosé Pine Dawn", false, "#f2e9e1", "#fffaf3", "#faf4ed", "#575279", "#797593", "#dfdad9", "#907aa9"),
  t("nord-light", "Nord Light", false, "#e5e9f0", "#eceff4", "#f3f5f8", "#2e3440", "#4c566a", "#d8dee9", "#5e81ac"),
  t("paper", "Paper", false, "#f3efe6", "#fbf8f1", "#f6f2e8", "#2b2a26", "#6b6658", "#e2dccd", "#b45309"),
];

export const ACCENTS = ["#3b82f6", "#8b5cf6", "#ec4899", "#ef4444", "#f97316", "#eab308",
  "#22c55e", "#14b8a6", "#06b6d4", "#64748b"];

const KEY = "mt5-theme";
const ACCENT_KEY = "mt5-accent";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode: lasts for this page only */
  }
}

export function savedTheme(): string {
  const id = read(KEY);
  return id && THEMES.some((x) => x.id === id) ? id : "system";
}

export function savedAccent(): string | null {
  const a = read(ACCENT_KEY);
  return a && /^#[0-9a-f]{6}$/i.test(a) ? a : null;
}

/** Black or white, whichever reads better on the colour. */
function textOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.62 ? "#111111" : "#ffffff";
}

const VARS = ["--bg", "--bg-grad", "--surface", "--surface-2", "--text", "--muted", "--border",
  "--border-strong", "--accent", "--accent-hover", "--accent-soft", "--accent-text", "--ring"];

/** Applies a theme id ("system" or one of THEMES) plus an optional accent override, and saves both. */
export function applyTheme(id: string, accent: string | null = savedAccent()): void {
  const root = document.documentElement;
  const def = THEMES.find((x) => x.id === id);
  VARS.forEach((v) => root.style.removeProperty(v));
  if (!def) {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", def.dark ? "dark" : "light");
    const set = (k: string, v: string) => root.style.setProperty(k, v);
    set("--bg", def.bg);
    set("--bg-grad", "none");
    set("--surface", def.surface);
    set("--surface-2", def.surface2);
    set("--text", def.text);
    set("--muted", def.muted);
    set("--border", def.border);
    set("--border-strong", `color-mix(in srgb, ${def.border} 75%, ${def.text})`);
  }
  const a = accent ?? def?.accent ?? null;
  if (a) {
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-hover", `color-mix(in srgb, ${a} 82%, ${def?.dark === false ? "#000" : "#fff"})`);
    root.style.setProperty("--accent-soft", `color-mix(in srgb, ${a} 16%, transparent)`);
    root.style.setProperty("--accent-text", textOn(a));
    root.style.setProperty("--ring", `0 0 0 3px color-mix(in srgb, ${a} 28%, transparent)`);
  }
  write(KEY, def ? def.id : null);
  write(ACCENT_KEY, accent);
}
