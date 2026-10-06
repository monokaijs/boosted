import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type PreviewLayout = {
  canSplit: boolean;
  activeId?: string;
  target: HTMLElement | null;
  claim(id: string): boolean;
  release(id: string): void;
};

const PreviewLayoutContext = createContext<PreviewLayout | undefined>(undefined);

export function useAttachmentPreviewLayout() {
  return useContext(PreviewLayoutContext);
}

export function AttachmentPreviewLayout({ children, alreadySplit = false }: { children: ReactNode; alreadySplit?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const owner = useRef<string | undefined>(undefined);
  const [activeId, setActiveId] = useState<string>();
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    // Measure the whole chat area, including an open preview, so opening a pane
    // does not immediately make the remaining conversation look too narrow.
    const measure = () => setWide(element.getBoundingClientRect().width >= 880);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  const canSplit = wide && !alreadySplit;
  const claim = useCallback((id: string) => {
    if (!canSplit || (owner.current && owner.current !== id)) return false;
    owner.current = id;
    setActiveId(id);
    return true;
  }, [canSplit]);
  const release = useCallback((id: string) => {
    if (owner.current !== id) return;
    owner.current = undefined;
    setActiveId(undefined);
  }, []);
  const value = useMemo(() => ({ canSplit, activeId, target, claim, release }), [canSplit, activeId, target, claim, release]);
  return <PreviewLayoutContext.Provider value={value}>
    <div ref={container} className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{children}</div>
      <aside ref={setTarget} hidden={!activeId || !canSplit} aria-label="File preview" className="h-full min-h-0 w-[45%] shrink-0 border-l border-border bg-background/25" />
    </div>
  </PreviewLayoutContext.Provider>;
}

export function AttachmentPreviewSplitGuard({ blocked, children }: { blocked: boolean; children: ReactNode }) {
  const layout = useAttachmentPreviewLayout();
  const value = useMemo(() => layout && blocked ? { ...layout, canSplit: false, claim: () => false } : layout, [layout, blocked]);
  return <PreviewLayoutContext.Provider value={value}>{children}</PreviewLayoutContext.Provider>;
}
