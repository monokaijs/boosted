import { useSyncExternalStore } from "react";

const mobileQuery = "(max-width: 900px)";
const compactQuery = "(max-width: 1400px)";

function subscribe(queryText: string, onChange: () => void) {
  const query = window.matchMedia?.(queryText);
  if (query) {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

const subscribeMobile = (onChange: () => void) => subscribe(mobileQuery, onChange);
const subscribeCompact = (onChange: () => void) => subscribe(compactQuery, onChange);

export function useMobileLayout() {
  return useSyncExternalStore(subscribeMobile, () => window.matchMedia?.(mobileQuery).matches ?? window.innerWidth <= 900, () => false);
}

export function useCompactLayout() {
  return useSyncExternalStore(subscribeCompact, () => window.matchMedia?.(compactQuery).matches ?? window.innerWidth <= 1400, () => false);
}
