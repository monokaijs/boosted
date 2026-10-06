import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeTheme, useThemeStore } from "./theme";

let media: EventTarget & { matches: boolean };
let stop: (() => void) | undefined;

beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal("matchMedia", () => media);
  document.head.innerHTML = '<meta name="theme-color"><meta name="color-scheme">';
});
afterEach(() => {
  stop?.();
  stop = undefined;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("color-scheme");
  document.head.innerHTML = "";
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function systemTheme(dark: boolean) {
  media.matches = dark;
  media.dispatchEvent(new Event("change"));
}

describe("device theme", () => {
  it("follows system changes and updates browser chrome by default", () => {
    stop = initializeTheme();
    expect(useThemeStore.getState().preference).toBe("system");
    expect(document.documentElement.style.colorScheme).toBe("light");
    systemTheme(true);
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    expect(document.documentElement).toHaveClass("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#08090b");
    expect(document.querySelector('meta[name="color-scheme"]')).toHaveAttribute("content", "dark");
    systemTheme(false);
    expect(document.documentElement).not.toHaveClass("dark");
    expect(document.querySelector('meta[name="theme-color"]')).toHaveAttribute("content", "#edf0f3");
  });

  it("restores the saved choice and ignores system changes until System is selected", () => {
    localStorage.setItem("boosted.theme", "dark");
    stop = initializeTheme();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    systemTheme(false);
    expect(document.documentElement).toHaveClass("dark");
    useThemeStore.getState().setTheme("light");
    expect(localStorage.getItem("boosted.theme")).toBe("light");
    systemTheme(true);
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
    useThemeStore.getState().setTheme("system");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    expect(localStorage.getItem("boosted.theme")).toBe("system");
  });

  it("falls back to the system for an invalid saved preference", () => {
    localStorage.setItem("boosted.theme", "invalid");
    media.matches = true;
    stop = initializeTheme();
    expect(useThemeStore.getState()).toMatchObject({ preference: "system", resolvedTheme: "dark" });
  });

  it("applies changes even when browser storage is blocked", () => {
    vi.spyOn(localStorage, "getItem").mockImplementation(() => { throw new Error("Blocked"); });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("Blocked"); });
    stop = initializeTheme();
    useThemeStore.getState().setTheme("dark");
    expect(document.documentElement).toHaveClass("dark");
    useThemeStore.getState().setTheme("system");
    systemTheme(true);
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });

  it("syncs saved preferences across tabs and removes listeners on disposal", () => {
    stop = initializeTheme();
    localStorage.setItem("boosted.theme", "dark");
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "boosted.theme", storageArea: localStorage }));
    expect(useThemeStore.getState()).toMatchObject({ preference: "dark", resolvedTheme: "dark" });
    localStorage.clear();
    window.dispatchEvent(Object.assign(new Event("storage"), { key: null, storageArea: localStorage }));
    expect(useThemeStore.getState()).toMatchObject({ preference: "system", resolvedTheme: "light" });
    stop();
    systemTheme(true);
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });
});
