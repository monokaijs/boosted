import { afterEach, describe, expect, it, vi } from "vitest";
import { trackVisibleViewport } from "./viewport";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function setup({ height = 780, inner = 780, screenHeight = 852, standalone = false } = {}) {
  const viewport = Object.assign(new EventTarget(), { height, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", inner);
  vi.stubGlobal("screen", { height: screenHeight });
  vi.stubGlobal("matchMedia", () => ({ matches: standalone }));
  stop = trackVisibleViewport();
  return viewport;
}

describe("mobile viewport", () => {
  it("leaves the shell at the layout viewport size when iOS reports a stale visual viewport", () => {
    const viewport = setup({ height: 714, inner: 812 });
    viewport.height = 600;
    viewport.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("does not add safe padding for the system strip already outside an installed app", () => {
    setup({ height: 812, inner: 812, screenHeight: 874, standalone: true });
    expect(document.documentElement.style.getPropertyValue("--app-excluded-bottom")).toBe("62px");
  });

  it("keeps the real safe inset when the installed app covers the screen", () => {
    setup({ height: 874, inner: 874, screenHeight: 874, standalone: true });
    expect(document.documentElement.style.getPropertyValue("--app-excluded-bottom")).toBe("0px");
  });

  it("does not treat Safari browser controls as a standalone system strip", () => {
    setup({ height: 714, inner: 714, screenHeight: 874 });
    expect(document.documentElement.style.getPropertyValue("--app-excluded-bottom")).toBe("0px");
  });

  it("handles keyboard resize and panning, ignores pinch zoom, and restores CSS sizing on dismissal", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    expect(root.hasAttribute("data-keyboard-open")).toBe(true);
    viewport.offsetTop = 90;
    viewport.dispatchEvent(new Event("scroll"));
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("90px");
    viewport.scale = 2;
    viewport.height = 230;
    viewport.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    viewport.scale = 1;
    viewport.height = 780;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("");
    expect(root.hasAttribute("data-keyboard-open")).toBe(false);
    stop?.();
    viewport.dispatchEvent(new Event("resize"));
    expect(root.style.getPropertyValue("--app-excluded-bottom")).toBe("");
  });

  it("uses CSS sizing when VisualViewport is unavailable", () => {
    setup();
    vi.stubGlobal("visualViewport", undefined);
    stop?.();
    stop = trackVisibleViewport();
    window.dispatchEvent(new Event("resize"));
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
  });
});
