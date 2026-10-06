import { create } from "zustand";
import { themePalettes } from "@/lib/palette";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = Exclude<ThemePreference, "system">;
const themeKey = "boosted.theme";

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* The theme still works when browser storage is unavailable. */ }
  return "system";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ResolvedTheme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", themePalettes[theme].canvas);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
}

type ThemeStore = {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setTheme: (preference: ThemePreference) => void;
};

const initialPreference = readPreference();
export const useThemeStore = create<ThemeStore>((set) => ({
  preference: initialPreference,
  resolvedTheme: resolveTheme(initialPreference),
  setTheme: (preference) => {
    try { localStorage.setItem(themeKey, preference); } catch { /* Apply without persistence. */ }
    const resolvedTheme = resolveTheme(preference);
    set({ preference, resolvedTheme });
    applyTheme(resolvedTheme);
  },
}));

export function initializeTheme() {
  const refresh = () => {
    const preference = readPreference();
    const resolvedTheme = resolveTheme(preference);
    useThemeStore.setState({ preference, resolvedTheme });
    applyTheme(resolvedTheme);
  };
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    const preference = useThemeStore.getState().preference;
    if (preference !== "system") return;
    const resolvedTheme = resolveTheme(preference);
    useThemeStore.setState({ resolvedTheme });
    applyTheme(resolvedTheme);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && (event.key === themeKey || event.key === null)) refresh();
  };
  refresh();
  media?.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  return () => {
    media?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}
