import type { ReactNode } from "react";
import { ThreadPrimitive } from "@assistant-ui/react";

/** The transcript owns scrolling; composer gestures must never scroll it. */
export function CodexThreadLayout({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return <ThreadPrimitive.ViewportProvider>
    <ThreadPrimitive.Root className="codex-thread-root flex min-h-0 flex-1 flex-col overflow-hidden">
      <ThreadPrimitive.Viewport className="codex-thread-viewport relative flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-6">{children}</ThreadPrimitive.Viewport>
      {/* This footer occupies its own space, so it has no overlapping viewport inset. */}
      <div className="codex-composer-footer relative z-10 shrink-0 bg-[var(--surface)] px-4 pb-4 pt-2">{footer}</div>
    </ThreadPrimitive.Root>
  </ThreadPrimitive.ViewportProvider>;
}
