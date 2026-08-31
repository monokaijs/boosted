import { useEffect, useState, type DragEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen, Grip, LoaderCircle, X } from "lucide-react";
import {
  macOSPermissionAppInfo,
  macOSPermissionLabel,
  revealMacOSPermissionApp,
  type MacOSPermissionAppInfo,
  type MacOSRemoteViewerPermission,
} from "@/lib/macos-permissions";

declare global {
  interface Window {
    __BOOSTED_MACOS_PERMISSION_HELPER__?: MacOSRemoteViewerPermission;
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function pngDataUrl(path: string) {
  return fetch(path)
    .then((response) => {
      if (!response.ok) throw new Error("Could not load the Boosted drag icon");
      return response.blob();
    })
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)));
      reader.addEventListener("error", () => reject(reader.error));
      reader.readAsDataURL(blob);
    }));
}

export function MacOSPermissionHelper({ permission }: { permission: MacOSRemoteViewerPermission }) {
  const [info, setInfo] = useState<MacOSPermissionAppInfo>();
  const [icon, setIcon] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [hasError, setHasError] = useState(false);
  const [dragging, setDragging] = useState(false);
  const label = macOSPermissionLabel(permission);

  useEffect(() => {
    let cancelled = false;
    Promise.all([macOSPermissionAppInfo(), pngDataUrl("/pwa-192x192.png")])
      .then(([appInfo, iconData]) => {
        if (cancelled) return;
        setInfo(appInfo);
        setIcon(iconData);
      })
      .catch((error) => {
        if (cancelled) return;
        setHasError(true);
        setStatus(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);

  async function startAppDrag(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (!info || !icon) return;
    setHasError(false);
    setStatus(undefined);
    setDragging(true);
    try {
      const { startDrag } = await import("@crabnebula/tauri-plugin-drag");
      await startDrag({ item: [info.appPath], icon, mode: "copy" }, ({ result }) => {
        setDragging(false);
        setStatus(result === "Dropped" ? "Now turn on its switch in Settings." : undefined);
      });
    } catch (error) {
      setDragging(false);
      setHasError(true);
      setStatus(errorMessage(error));
    }
  }

  async function run(action: () => Promise<unknown>) {
    setHasError(false);
    setStatus(undefined);
    try { await action(); } catch (error) {
      setHasError(true);
      setStatus(errorMessage(error));
    }
  }

  return <main className="macos-permission-helper">
    <header className="macos-permission-helper-title" data-tauri-drag-region>
      <strong data-tauri-drag-region>Add Boosted to {label}</strong>
      <button type="button" aria-label="Close permission helper" onClick={() => void getCurrentWindow().close()}><X /></button>
    </header>
    <section className="macos-permission-helper-body">
      <p className={hasError ? "is-error" : undefined}>{status ?? "Drag the app below into the open settings list."}</p>
      <button
        type="button"
        className="macos-permission-app-drag"
        draggable={Boolean(info && icon)}
        disabled={!info || !icon}
        onDragStart={(event) => void startAppDrag(event)}
        title={`Drag ${info?.appPath ?? "Boosted.app"} into System Settings`}
      >
        <img src="/pwa-192x192.png" alt="" draggable={false} />
        <span><strong>{info?.appName ?? "Boosted"}</strong><small>{dragging ? "Dragging…" : "Drag into Screen Recording"}</small></span>
        {dragging ? <LoaderCircle className="animate-spin" /> : <Grip />}
      </button>
      <footer>
        <button type="button" onClick={() => void run(revealMacOSPermissionApp)}><FolderOpen />Show in Finder</button>
        <span>Then enable Boosted and relaunch.</span>
      </footer>
    </section>
  </main>;
}
