/** Apply a visual viewport override only while the keyboard obscures a text input. */
export function trackVisibleViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  const update = () => {
    // Pinch zoom should magnify the page rather than resize its layout.
    if (viewport && viewport.scale !== 1) return;
    const input = document.activeElement;
    const editing = input instanceof HTMLElement && (input.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit])") || input.isContentEditable);
    const keyboard = editing && viewport && window.innerHeight - viewport.height > 150;
    if (keyboard) {
      root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
      root.style.setProperty("--app-viewport-top", `${viewport.offsetTop}px`);
    } else {
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
    }
    // Some installed iOS web apps exclude a bottom system strip from their layout
    // viewport but still include it in env(safe-area-inset-bottom). Don't reserve it twice.
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone;
    const excluded = standalone ? Math.max(0, window.screen.height - window.innerHeight) : 0;
    root.style.setProperty("--app-excluded-bottom", `${excluded}px`);
    root.toggleAttribute("data-keyboard-open", Boolean(keyboard));
  };
  update();
  window.addEventListener("resize", update);
  window.addEventListener("focusin", update);
  window.addEventListener("focusout", update);
  window.addEventListener("pageshow", update);
  viewport?.addEventListener("resize", update);
  viewport?.addEventListener("scroll", update);
  return () => {
    window.removeEventListener("resize", update);
    window.removeEventListener("focusin", update);
    window.removeEventListener("focusout", update);
    window.removeEventListener("pageshow", update);
    viewport?.removeEventListener("resize", update);
    viewport?.removeEventListener("scroll", update);
    root.style.removeProperty("--app-viewport-height");
    root.style.removeProperty("--app-viewport-top");
    root.style.removeProperty("--app-excluded-bottom");
    root.removeAttribute("data-keyboard-open");
  };
}
