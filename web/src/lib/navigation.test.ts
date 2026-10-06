import { afterEach, describe, expect, it, vi } from "vitest";
import { backToSettings, navigateSettings, pageFromHash, settingsSectionFromHash } from "./navigation";

afterEach(() => { window.history.replaceState(null, "", "/"); vi.restoreAllMocks(); });
describe("settings routes", () => {
  it("recognizes subpages and legacy usage links", () => {
    for (const [hash, section] of [["#settings", undefined], ["#settings/appearance", "appearance"], ["#settings/codex", undefined], ["#usage", "usage"], ["#settings/unknown", undefined]]) {
      window.history.replaceState(null, "", hash);
      expect(pageFromHash()).toBe("settings");
      expect(settingsSectionFromHash()).toBe(section);
    }
  });
  it("pushes a subpage and uses its category history entry for Back", () => {
    window.history.replaceState(null, "", "#settings");
    const changed = vi.fn();
    window.addEventListener("hashchange", changed);
    navigateSettings("notifications");
    expect(settingsSectionFromHash()).toBe("notifications");
    expect(changed).toHaveBeenCalledOnce();
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {});
    backToSettings();
    expect(back).toHaveBeenCalledOnce();
    window.removeEventListener("hashchange", changed);
  });
  it("returns a directly opened subpage to categories without leaving the app", () => {
    window.history.replaceState(null, "", "#settings/application");
    const back = vi.spyOn(window.history, "back");
    backToSettings();
    expect(window.location.hash).toBe("#settings");
    expect(back).not.toHaveBeenCalled();
  });
});
