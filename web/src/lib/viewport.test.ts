import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trackVisibleViewport } from "./viewport";

let stop: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersToNextFrame();

function setup({ height = 780, inner = 780 } = {}) {
  const viewport = Object.assign(new EventTarget(), { height, width: 393, offsetTop: 0, scale: 1 });
  vi.stubGlobal("visualViewport", viewport);
  vi.stubGlobal("innerHeight", inner);
  vi.stubGlobal("innerWidth", 393);
  stop = trackVisibleViewport();
  return viewport;
}

describe("mobile viewport", () => {
  it("leaves the shell at the layout viewport size when iOS reports a stale visual viewport", () => {
    const viewport = setup({ height: 714, inner: 812 });
    viewport.height = 600;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("handles keyboard resize and panning, ignores pinch zoom, and restores CSS sizing on dismissal", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    expect(root.hasAttribute("data-keyboard-open")).toBe(true);
    viewport.offsetTop = 90;
    viewport.dispatchEvent(new Event("scroll"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("90px");
    viewport.scale = 2;
    viewport.height = 230;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    viewport.scale = 1;
    viewport.height = 780;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("");
    expect(root.hasAttribute("data-keyboard-open")).toBe(false);
    stop?.();
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("");
  });

  it("keeps the composer above the keyboard after blur and throughout dismissal", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    input.blur();
    flush();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    expect(root.hasAttribute("data-keyboard-open")).toBe(true);
    viewport.height = 730;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("730px");
    expect(root.hasAttribute("data-keyboard-open")).toBe(true);
    viewport.height = 780;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(root.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("detects a keyboard when the browser shrinks both innerHeight and VisualViewport", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    vi.stubGlobal("innerHeight", 460);
    viewport.height = 460;
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(true);
  });

  it("preserves keyboard panning when Safari also shrinks innerHeight", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    vi.stubGlobal("innerHeight", 460);
    viewport.height = 460;
    viewport.offsetTop = 240;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("240px");

    // The offset can lag behind the height during the closing animation.
    input.blur();
    vi.stubGlobal("innerHeight", 730);
    viewport.height = 730;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("50px");
  });

  it("clears iOS document scrolling without scrolling the message list", () => {
    const viewport = setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const messages = document.createElement("div");
    messages.scrollTop = 180;
    const input = document.createElement("textarea");
    document.body.append(messages, input);
    input.focus();
    viewport.height = 460;
    vi.stubGlobal("scrollY", 120);
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    expect(messages.scrollTop).toBe(180);

    scrollTo.mockClear();
    vi.stubGlobal("scrollY", 0);
    viewport.dispatchEvent(new Event("scroll"));
    flush();
    expect(scrollTo).not.toHaveBeenCalled();

    input.blur();
    vi.stubGlobal("scrollY", 34);
    viewport.height = 780;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "instant" });
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("leaves document scrolling alone at rest and on desktop", () => {
    const viewport = setup();
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.stubGlobal("scrollY", 120);
    window.dispatchEvent(new Event("scroll"));
    flush();
    expect(scrollTo).not.toHaveBeenCalled();

    vi.stubGlobal("innerWidth", 1200);
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("reveals a dialog field in its own scroll container when the keyboard opens", () => {
    const viewport = setup();
    const dialog = document.createElement("div");
    dialog.className = "dialog-content";
    const body = document.createElement("div");
    body.style.overflowY = "auto";
    Object.defineProperties(body, { scrollHeight: { value: 800 }, clientHeight: { value: 200 } });
    body.getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect);
    const input = document.createElement("textarea");
    input.getBoundingClientRect = () => ({ top: 330, bottom: 390, height: 60 } as DOMRect);
    body.append(input);
    dialog.append(body);
    document.body.append(dialog);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(body.scrollTop).toBe(102);

    // The same focused field can be above the visible body after panning.
    input.getBoundingClientRect = () => ({ top: 90, bottom: 150, height: 60 } as DOMRect);
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("scroll"));
    flush();
    expect(body.scrollTop).toBe(80);
  });

  it("does not scroll the conversation while tracking a focused composer", () => {
    const viewport = setup();
    const conversation = document.createElement("div");
    conversation.style.overflowY = "auto";
    Object.defineProperties(conversation, { scrollHeight: { value: 800 }, clientHeight: { value: 200 } });
    conversation.scrollTop = 180;
    const input = document.createElement("textarea");
    conversation.append(input);
    document.body.append(conversation);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(conversation.scrollTop).toBe(180);
  });

  it("uses the resting visual height rather than mistaking a stale iOS inset for a keyboard", () => {
    const viewport = setup({ height: 714, inner: 812 });
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    flush();
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
    viewport.height = 500;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("500px");
  });

  it("coalesces viewport panning and clamps transient offsets within the layout viewport", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    viewport.offsetTop = 100;
    viewport.dispatchEvent(new Event("scroll"));
    viewport.offsetTop = 400;
    window.dispatchEvent(new Event("scroll"));
    flush();
    const root = document.documentElement;
    expect(root.style.getPropertyValue("--app-viewport-height")).toBe("460px");
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("320px");
    viewport.height = 760;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(root.style.getPropertyValue("--app-viewport-top")).toBe("20px");
  });

  it("recalibrates the resting height when the phone rotates with a focused input", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.width = 852;
    viewport.height = 393;
    vi.stubGlobal("innerHeight", 393);
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
    viewport.height = 200;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("200px");
  });

  it("cancels pending frame updates on cleanup", () => {
    const viewport = setup();
    const input = document.createElement("textarea");
    document.body.append(input);
    input.focus();
    viewport.height = 460;
    viewport.dispatchEvent(new Event("resize"));
    stop?.();
    flush();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
    expect(document.documentElement.hasAttribute("data-keyboard-open")).toBe(false);
  });

  it("uses CSS sizing when VisualViewport is unavailable", () => {
    setup();
    vi.stubGlobal("visualViewport", undefined);
    stop?.();
    stop = trackVisibleViewport();
    window.dispatchEvent(new Event("resize"));
    flush();
    expect(document.documentElement.style.getPropertyValue("--app-viewport-height")).toBe("");
  });
});
