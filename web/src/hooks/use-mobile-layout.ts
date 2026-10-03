import { useSyncExternalStore } from "react";

const mobileQuery = "(max-width: 900px)";

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(mobileQuery);
  if (query) {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

export function useMobileLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia?.(mobileQuery).matches ?? window.innerWidth <= 900, () => false);
}
