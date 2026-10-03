const keyboardThreshold = 80;

function isEditing() {
  const input = document.activeElement;
  return input instanceof HTMLElement && (input.matches("textarea, input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=button]):not([type=submit])") || input.isContentEditable);
}

/** Keep the shell inside the visual viewport throughout keyboard opening and dismissal. */
export function trackVisibleViewport() {
  const viewport = window.visualViewport;
  const root = document.documentElement;
  let restingHeight = viewport?.height ?? window.innerHeight;
  let restingWidth = viewport?.width ?? window.innerWidth;
  let keyboardOpen = false;
  let frame = 0;

  const update = () => {
    // Pinch zoom should magnify the page rather than resize its layout.
    if (!viewport || viewport.scale !== 1 || viewport.height <= 0) return;
    const editing = isEditing();
    if (viewport.width !== restingWidth) {
      // Rotation changes the unoccluded height; iOS keeps innerHeight at that height.
      restingWidth = viewport.width;
      restingHeight = Math.max(window.innerHeight, viewport.height);
    }
    const reduced = restingHeight - viewport.height > keyboardThreshold;
    // A blur (send button, menu, Done) can precede the keyboard's closing animation.
    // Keep tracking every intermediate size until the viewport has actually recovered.
    keyboardOpen = keyboardOpen ? viewport.height < restingHeight - 1 : editing && reduced;
    if (keyboardOpen) {
      root.style.setProperty("--app-viewport-height", `${viewport.height}px`);
      const top = Math.min(Math.max(0, viewport.offsetTop), Math.max(0, window.innerHeight - viewport.height));
      root.style.setProperty("--app-viewport-top", `${top}px`);
    } else {
      root.style.removeProperty("--app-viewport-height");
      root.style.removeProperty("--app-viewport-top");
      // Use the actual resting visual height, including Safari's current browser controls.
      // Once editing begins, preserve it even if innerHeight shrinks with the keyboard.
      if (!editing) restingHeight = viewport.height;
    }
    root.toggleAttribute("data-keyboard-open", keyboardOpen);
  };
  const schedule = () => {
    // iOS can send focus, scroll and resize together with different intermediate values.
    if (!frame) frame = window.requestAnimationFrame(() => { frame = 0; update(); });
  };
  update();
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule);
  window.addEventListener("focusin", schedule);
  window.addEventListener("focusout", schedule);
  window.addEventListener("pageshow", schedule);
  viewport?.addEventListener("resize", schedule);
  viewport?.addEventListener("scroll", schedule);
  return () => {
    window.cancelAnimationFrame(frame);
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("focusin", schedule);
    window.removeEventListener("focusout", schedule);
    window.removeEventListener("pageshow", schedule);
    viewport?.removeEventListener("resize", schedule);
    viewport?.removeEventListener("scroll", schedule);
    root.style.removeProperty("--app-viewport-height");
    root.style.removeProperty("--app-viewport-top");
    root.removeAttribute("data-keyboard-open");
  };
}
