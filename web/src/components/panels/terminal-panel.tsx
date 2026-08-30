import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { LoaderCircle, TerminalSquare } from "lucide-react";
import { api, apiWebSocket, getToken } from "@/lib/api";
import { terminalPalette } from "@/lib/palette";
import { useAppStore } from "@/lib/store";

export const newTerminalEvent = "boosted:terminal:new";

export function TerminalPanel() {
  const projectId = useAppStore((state) => state.selectedProjectId);
  const hostRef = useRef<HTMLDivElement>(null);
  const [terminalId, setTerminalId] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => { setTerminalId(undefined); setError(undefined); }, [projectId]);
  useEffect(() => {
    const restart = () => { setTerminalId(undefined); setError(undefined); };
    window.addEventListener(newTerminalEvent, restart);
    return () => window.removeEventListener(newTerminalEvent, restart);
  }, []);

  useEffect(() => {
    if (!projectId || terminalId) return;
    let cancelled = false;
    api.createProjectTerminal(projectId).then((value) => { if (!cancelled) setTerminalId(value.id); }).catch((caught) => setError(caught instanceof Error ? caught.message : "Unable to start terminal"));
    return () => { cancelled = true; };
  }, [projectId, terminalId]);

  useEffect(() => {
    if (!terminalId || !hostRef.current) return;
    const terminal = new Terminal({ convertEol: true, cursorBlink: true, fontFamily: "JetBrains Mono, SFMono-Regular, Consolas, monospace", fontSize: 12, lineHeight: 1.25, scrollback: 8_000, theme: terminalPalette });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    const socket = new WebSocket(apiWebSocket(`/terminals/${terminalId}/ws`));
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "authenticate", token: getToken(), cols: terminal.cols, rows: terminal.rows })));
    socket.addEventListener("message", (event) => {
      if (event.data instanceof ArrayBuffer) terminal.write(new Uint8Array(event.data));
      else { try { const value = JSON.parse(event.data); if (value.type === "output") terminal.write(value.data); if (value.type === "error") setError(value.message); } catch { terminal.write(String(event.data)); } }
    });
    const input = terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "input", data })); });
    const resize = new ResizeObserver(() => { fit.fit(); if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); });
    resize.observe(hostRef.current);
    return () => { input.dispose(); resize.disconnect(); socket.close(); terminal.dispose(); };
  }, [terminalId]);

  if (!projectId) return <div className="empty-state"><TerminalSquare className="size-8" /><p>Open a project to start a workspace terminal.</p></div>;
  return (
    <div className="panel-root">
      <div className="relative min-h-0 flex-1 p-2" ref={hostRef}>{!terminalId && !error && <div className="absolute inset-0 z-10 grid place-items-center bg-background"><LoaderCircle className="size-5 animate-spin text-primary" /></div>}</div>
      {error && <div className="border-t border-border px-3 py-2 text-xs text-destructive">{error}</div>}
    </div>
  );
}
