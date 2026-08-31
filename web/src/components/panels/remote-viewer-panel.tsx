import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, AudioLines, CircleStop, Eye, Fullscreen, Gamepad2, LoaderCircle, Maximize2, Minimize2, Monitor, RefreshCw, Search, Volume2, VolumeX, X, ZoomIn, ZoomOut } from "lucide-react";
import type { IDockviewPanelProps } from "dockview-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api, apiWebSocket, getToken } from "@/lib/api";
import { useMachineStore } from "@/lib/machines";
import type { CaptureSource, RemoteViewerResolution, ViewerSession } from "@/lib/types";
import { cn } from "@/lib/utils";

type StreamStats = { bitrateKbps?: number; videoSequence?: number; dropped?: number };
type ConfigMessage = {
  type: "config";
  generation: number;
  video: VideoDecoderConfig;
  audio?: { codec: string; sampleRate: number; numberOfChannels: number };
};
type AudioFrame = {
  numberOfChannels: number;
  numberOfFrames: number;
  sampleRate: number;
  timestamp: number;
  copyTo: (destination: Float32Array, options: { planeIndex: number }) => void;
  close: () => void;
};
type AudioDecoderLike = {
  state: string;
  configure: (config: Record<string, unknown>) => void;
  decode: (chunk: unknown) => void;
  close: () => void;
};
type AudioDecoderConstructor = new (options: { output: (frame: AudioFrame) => void; error: (error: Error) => void }) => AudioDecoderLike;
type EncodedAudioChunkConstructor = new (options: { type: "key"; timestamp: number; data: Uint8Array }) => unknown;

const resolutionOrder: RemoteViewerResolution[] = ["720p", "1080p", "1440p", "native"];
const activeViewerEvent = "boosted:active-viewer";
const minimumZoom = 0.5;
const maximumZoom = 4;
const zoomStep = 0.25;

type TouchPoint = { x: number; y: number; startX: number; startY: number; moved: boolean };
type ZoomAnchor = { ratioX: number; ratioY: number; viewportX: number; viewportY: number };

function clampZoom(value: number) {
  return Math.min(maximumZoom, Math.max(minimumZoom, Math.round(value * 100) / 100));
}

function touchDistance(points: TouchPoint[]) {
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Remote Viewer failed";
}

function SourceThumbnail({ source }: { source: CaptureSource }) {
  const host = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry?.isIntersecting) setVisible(true); }, { rootMargin: "100px" });
    observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let objectUrl: string | undefined;
    api.remoteViewerThumbnail(source.id).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [source.id, visible]);
  return <div ref={host} className="remote-viewer-thumbnail">{url ? <img src={url} alt="" /> : <Monitor />}</div>;
}

function SourcePicker({ kind, search, selectedId, onKind, onSearch, onSelect }: {
  kind: CaptureSource["kind"];
  search: string;
  selectedId?: string;
  onKind: (kind: CaptureSource["kind"]) => void;
  onSearch: (search: string) => void;
  onSelect: (source: CaptureSource) => void;
}) {
  const sources = useQuery({ queryKey: ["remote-viewer-sources", kind], queryFn: () => api.remoteViewerSources(kind), refetchInterval: 10_000 });
  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase();
    return sources.data?.filter((source) => !needle || `${source.appName ?? ""} ${source.name}`.toLocaleLowerCase().includes(needle)) ?? [];
  }, [search, sources.data]);
  return <div className="remote-viewer-source-picker">
    <div className="remote-viewer-source-kinds"><button type="button" className={cn(kind === "window" && "active")} onClick={() => onKind("window")}>Window</button><button type="button" className={cn(kind === "display" && "active")} onClick={() => onKind("display")}>Display</button></div>
    <label className="relative block"><Search className="pointer-events-none absolute left-2 top-2 size-3.5 text-muted-foreground" /><Input autoFocus className="h-8 pl-7 text-xs" value={search} onChange={(event) => onSearch(event.target.value)} placeholder={`Search ${kind}s`} /></label>
    <div className="remote-viewer-source-list">
      {sources.isLoading && <div className="grid min-h-28 place-items-center"><LoaderCircle className="size-4 animate-spin text-primary" /></div>}
      {sources.error && <div className="p-3 text-xs text-destructive">{sources.error.message}</div>}
      {filtered.map((source) => <button type="button" key={source.id} className={cn("remote-viewer-source", selectedId === source.id && "selected")} onClick={() => onSelect(source)}>
        <SourceThumbnail source={source} />
        <span className="min-w-0"><strong>{source.name}</strong><small>{source.appName ? `${source.appName} · ` : ""}{source.width}×{source.height} · {source.scale.toFixed(1)}×</small></span>
      </button>)}
      {!sources.isLoading && !filtered.length && <p className="p-4 text-center text-[11px] text-muted-foreground">No matching {kind}s.</p>}
    </div>
    <div className="remote-viewer-source-footer"><span>{filtered.length} {kind}{filtered.length === 1 ? "" : "s"}</span><Button variant="ghost" size="sm" onClick={() => void sources.refetch()}><RefreshCw />Refresh</Button></div>
  </div>;
}

export function RemoteViewerPanel(props: IDockviewPanelProps) {
  const panelId = props.api.id;
  const machineId = useMachineStore((state) => state.activeId);
  const settings = useQuery({ queryKey: ["remote-viewer-settings"], queryFn: api.remoteViewerSettings });
  const capabilities = useQuery({ queryKey: ["remote-viewer-capabilities"], queryFn: api.remoteViewerCapabilities });
  const [kind, setKind] = useState<CaptureSource["kind"]>("window");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<CaptureSource>();
  const [session, setSession] = useState<ViewerSession>();
  const sessionRef = useRef<ViewerSession | undefined>(undefined);
  const [fps, setFps] = useState(30);
  const [resolution, setResolution] = useState<RemoteViewerResolution>("1080p");
  const qualityInitialized = useRef(false);
  const [status, setStatus] = useState("Stopped");
  const [error, setError] = useState<string>();
  const [stats, setStats] = useState<StreamStats>({});
  const [sourceDialogOpen, setSourceDialogOpen] = useState(false);
  const [muted, setMuted] = useState(false);
  const [active, setActive] = useState(() => props.containerApi.activePanel?.id === panelId);
  const [control, setControl] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [fitSize, setFitSize] = useState<{ width: number; height: number }>();
  const [fullscreen, setFullscreen] = useState(false);
  const pendingControl = useRef(false);
  const stageRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zoomRef = useRef(1);
  const zoomAnchor = useRef<ZoomAnchor | undefined>(undefined);
  const touchPoints = useRef(new Map<number, TouchPoint>());
  const touchGesture = useRef({ pinched: false, remotePressed: false });
  const pinchStart = useRef<{ distance: number; zoom: number } | undefined>(undefined);
  const mediaSocket = useRef<WebSocket | undefined>(undefined);
  const controlSocket = useRef<WebSocket | undefined>(undefined);
  const audible = useRef(false);
  const audioContext = useRef<AudioContext | undefined>(undefined);
  const audioClock = useRef<{ pts: number; contextTime: number } | undefined>(undefined);
  const nextAudioTime = useRef(0);
  const pendingPointer = useRef<{ x: number; y: number } | undefined>(undefined);
  const pointerFrame = useRef<number | undefined>(undefined);
  const previousMachine = useRef(machineId);

  useEffect(() => {
    if (!settings.data || qualityInitialized.current) return;
    qualityInitialized.current = true;
    setFps(settings.data.defaultFps);
    setResolution(settings.data.defaultResolution);
  }, [settings.data]);
  useEffect(() => { sessionRef.current = session; }, [session]);
  useEffect(() => { audible.current = active && !muted; }, [active, muted]);
  useEffect(() => {
    const listener = (event: Event) => setActive((event as CustomEvent<string | undefined>).detail === panelId);
    window.addEventListener(activeViewerEvent, listener);
    return () => window.removeEventListener(activeViewerEvent, listener);
  }, [panelId]);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || !session) {
      setFitSize(undefined);
      return;
    }
    const update = () => {
      const scale = Math.min(stage.clientWidth / session.width, stage.clientHeight / session.height);
      if (!Number.isFinite(scale) || scale <= 0) return;
      setFitSize({
        width: Math.max(1, Math.floor(session.width * scale)),
        height: Math.max(1, Math.floor(session.height * scale)),
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(stage);
    update();
    return () => observer.disconnect();
  }, [session?.height, session?.id, session?.width]);
  useEffect(() => {
    const update = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  useEffect(() => {
    zoomRef.current = 1;
    zoomAnchor.current = undefined;
    setZoom(1);
    viewportRef.current?.scrollTo({ left: 0, top: 0 });
  }, [session?.source.id]);

  const sendControl = useCallback((event: Record<string, unknown>) => {
    if (controlSocket.current?.readyState === WebSocket.OPEN) controlSocket.current.send(JSON.stringify(event));
  }, []);

  const clearQueuedPointer = useCallback(() => {
    pendingPointer.current = undefined;
    if (pointerFrame.current !== undefined) window.cancelAnimationFrame(pointerFrame.current);
    pointerFrame.current = undefined;
  }, []);

  const changeZoom = useCallback((requestedZoom: number, clientX?: number, clientY?: number) => {
    const nextZoom = clampZoom(requestedZoom);
    if (nextZoom === zoomRef.current) return;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (viewport && canvas) {
      const viewportBounds = viewport.getBoundingClientRect();
      const canvasBounds = canvas.getBoundingClientRect();
      const focalX = clientX ?? viewportBounds.left + viewportBounds.width / 2;
      const focalY = clientY ?? viewportBounds.top + viewportBounds.height / 2;
      zoomAnchor.current = {
        ratioX: Math.min(1, Math.max(0, (focalX - canvasBounds.left) / canvasBounds.width)),
        ratioY: Math.min(1, Math.max(0, (focalY - canvasBounds.top) / canvasBounds.height)),
        viewportX: focalX - viewportBounds.left,
        viewportY: focalY - viewportBounds.top,
      };
    }
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
  }, []);

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    const viewport = viewportRef.current;
    const canvas = canvasRef.current;
    if (!anchor || !viewport || !canvas) return;
    const viewportBounds = viewport.getBoundingClientRect();
    const canvasBounds = canvas.getBoundingClientRect();
    viewport.scrollLeft += canvasBounds.left - viewportBounds.left + anchor.ratioX * canvasBounds.width - anchor.viewportX;
    viewport.scrollTop += canvasBounds.top - viewportBounds.top + anchor.ratioY * canvasBounds.height - anchor.viewportY;
    zoomAnchor.current = undefined;
  }, [zoom]);

  const releaseControl = useCallback(() => {
    clearQueuedPointer();
    pendingControl.current = false;
    sendControl({ type: "release-all" });
    setControl(false);
  }, [clearQueuedPointer, sendControl]);

  function requestControlLease() {
    if (!canControl) return;
    if (controlSocket.current?.readyState === WebSocket.OPEN) {
      pendingControl.current = false;
      sendControl({ type: "lease" });
    } else {
      pendingControl.current = true;
    }
  }

  const stop = useCallback((reason = "Stopped") => {
    const current = sessionRef.current;
    releaseControl();
    mediaSocket.current?.close();
    controlSocket.current?.close();
    mediaSocket.current = undefined;
    controlSocket.current = undefined;
    if (current) void api.deleteRemoteViewerSession(current.id).catch(() => undefined);
    sessionRef.current = undefined;
    setSession(undefined);
    setStatus(reason);
    setStats({});
    setSourceDialogOpen(false);
  }, [releaseControl]);

  useEffect(() => {
    if (previousMachine.current && previousMachine.current !== machineId) stop("Machine changed");
    previousMachine.current = machineId;
  }, [machineId, stop]);
  useEffect(() => () => {
    const current = sessionRef.current;
    mediaSocket.current?.close();
    controlSocket.current?.close();
    if (current) void api.deleteRemoteViewerSession(current.id).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!control) return;
    const heartbeat = window.setInterval(() => sendControl({ type: "heartbeat" }), 3_000);
    const release = () => releaseControl();
    const visibility = () => { if (document.hidden) release(); };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(heartbeat);
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [control, releaseControl, sendControl]);
  useEffect(() => { if (!active && control) releaseControl(); }, [active, control, releaseControl]);

  useEffect(() => {
    if (!session) return;
    let disposed = false;
    let mediaReconnect: number | undefined;
    let controlReconnect: number | undefined;
    let mediaAttempt = 0;
    let controlAttempt = 0;
    let videoDecoder: VideoDecoder | undefined;
    let audioDecoder: AudioDecoderLike | undefined;
    let wasmDecoder: { ready: Promise<void>; decodeFrame: (data: Uint8Array) => Promise<{ channelData: Float32Array[]; sampleRate: number }>; free: () => Promise<void> } | undefined;
    let pendingFrame: VideoFrame | undefined;
    let animation = 0;
    let lastVideoSequence = 0;

    const draw = () => {
      const frame = pendingFrame;
      pendingFrame = undefined;
      if (frame && canvasRef.current) {
        const context = audioContext.current;
        const clock = audioClock.current;
        if (audible.current && context && clock) {
          const audioPts = clock.pts + (context.currentTime - clock.contextTime) * 1_000_000;
          const skew = frame.timestamp - audioPts;
          if (skew > 100_000) {
            pendingFrame = frame;
            animation = requestAnimationFrame(draw);
            return;
          }
          if (skew < -100_000) {
            frame.close();
            setStats((current) => ({ ...current, dropped: (current.dropped ?? 0) + 1 }));
            animation = requestAnimationFrame(draw);
            return;
          }
        }
        const canvas = canvasRef.current;
        if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
          canvas.width = frame.displayWidth;
          canvas.height = frame.displayHeight;
        }
        canvas.getContext("2d", { alpha: false })?.drawImage(frame, 0, 0, canvas.width, canvas.height);
        frame.close();
      }
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);

    const scheduleAudio = (channels: Float32Array[], sampleRate: number, timestamp: number) => {
      if (!audible.current || !channels[0]?.length) return;
      const context = audioContext.current ?? new AudioContext({ latencyHint: "interactive", sampleRate: 48_000 });
      audioContext.current = context;
      if (context.state === "suspended") void context.resume();
      const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
      channels.forEach((channel, index) => buffer.copyToChannel(Float32Array.from(channel), index));
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      const now = context.currentTime;
      const safetyTime = now + 0.04;
      let clock = audioClock.current;
      let targetTime = clock ? clock.contextTime + (timestamp - clock.pts) / 1_000_000 : safetyTime;
      if (!clock || targetTime < now - 0.05 || targetTime > now + 0.2) {
        clock = { pts: timestamp, contextTime: safetyTime };
        audioClock.current = clock;
        targetTime = safetyTime;
      }
      targetTime = Math.max(targetTime, nextAudioTime.current, now + 0.005);
      source.start(targetTime);
      nextAudioTime.current = targetTime + buffer.duration;
    };

    const resetDecoders = () => {
      pendingFrame?.close();
      pendingFrame = undefined;
      if (videoDecoder?.state !== "closed") videoDecoder?.close();
      if (audioDecoder?.state !== "closed") audioDecoder?.close();
      videoDecoder = undefined;
      audioDecoder = undefined;
      if (wasmDecoder) void wasmDecoder.free();
      wasmDecoder = undefined;
      lastVideoSequence = 0;
      audioClock.current = undefined;
      nextAudioTime.current = 0;
    };

    const configure = async (config: ConfigMessage) => {
      resetDecoders();
      try {
        const supported = await VideoDecoder.isConfigSupported(config.video);
        if (!supported.supported) throw new Error(`${config.video.codec} is not supported by this client`);
        videoDecoder = new VideoDecoder({
          output: (frame) => {
            if (pendingFrame) {
              pendingFrame.close();
              setStats((current) => ({ ...current, dropped: (current.dropped ?? 0) + 1 }));
            }
            pendingFrame = frame;
          },
          error: (caught) => {
            setError(errorMessage(caught));
            mediaSocket.current?.send(JSON.stringify({ type: "keyframe" }));
          },
        });
        videoDecoder.configure(config.video);
        if (!config.audio) return;
        const AudioDecoderCtor = (globalThis as unknown as { AudioDecoder?: AudioDecoderConstructor }).AudioDecoder;
        const AudioChunkCtor = (globalThis as unknown as { EncodedAudioChunk?: EncodedAudioChunkConstructor }).EncodedAudioChunk;
        if (AudioDecoderCtor && AudioChunkCtor) {
          audioDecoder = new AudioDecoderCtor({
            output: (frame) => {
              const channels = Array.from({ length: frame.numberOfChannels }, (_, index) => {
                const channel = new Float32Array(frame.numberOfFrames);
                frame.copyTo(channel, { planeIndex: index });
                return channel;
              });
              frame.close();
              scheduleAudio(channels, frame.sampleRate, frame.timestamp);
            },
            error: (caught) => setError(`Audio decoder: ${errorMessage(caught)}`),
          });
          audioDecoder.configure(config.audio as unknown as Record<string, unknown>);
        } else {
          const { OpusDecoderWebWorker } = await import("opus-decoder");
          wasmDecoder = new OpusDecoderWebWorker({ sampleRate: 48_000, channels: 2, forceStereo: true });
          await wasmDecoder.ready;
        }
      } catch (caught) {
        setError(errorMessage(caught));
      }
    };

    const handleBinary = (buffer: ArrayBuffer) => {
      if (buffer.byteLength < 24) return;
      const bytes = new Uint8Array(buffer);
      if (String.fromCharCode(...bytes.subarray(0, 4)) !== "BRV1") return;
      const view = new DataView(buffer);
      const kind = bytes[4];
      const key = (bytes[5] & 1) !== 0;
      const sequence = Number(view.getBigUint64(8));
      const timestamp = Number(view.getBigUint64(16));
      const payload = bytes.subarray(24);
      if (kind === 1 && videoDecoder?.state === "configured") {
        if (lastVideoSequence && sequence !== lastVideoSequence + 1 && !key) mediaSocket.current?.send(JSON.stringify({ type: "keyframe" }));
        lastVideoSequence = sequence;
        if (videoDecoder.decodeQueueSize > 3 && !key) {
          setStats((current) => ({ ...current, dropped: (current.dropped ?? 0) + 1 }));
          return;
        }
        videoDecoder.decode(new EncodedVideoChunk({ type: key ? "key" : "delta", timestamp, data: payload }));
      } else if (kind === 2 && audible.current) {
        const AudioChunkCtor = (globalThis as unknown as { EncodedAudioChunk?: EncodedAudioChunkConstructor }).EncodedAudioChunk;
        if (audioDecoder?.state === "configured" && AudioChunkCtor) audioDecoder.decode(new AudioChunkCtor({ type: "key", timestamp, data: payload }));
        else if (wasmDecoder) void wasmDecoder.decodeFrame(payload.slice()).then((decoded) => scheduleAudio(decoded.channelData, decoded.sampleRate, timestamp)).catch((caught) => setError(`Audio decoder: ${errorMessage(caught)}`));
      }
    };

    const connectMedia = () => {
      if (disposed) return;
      const socket = new WebSocket(apiWebSocket(`/remote-viewer/sessions/${session.id}/media`));
      mediaSocket.current = socket;
      socket.binaryType = "arraybuffer";
      socket.addEventListener("open", () => {
        mediaAttempt = 0;
        setStatus("Connected");
        socket.send(JSON.stringify({ type: "authenticate", token: getToken() }));
      });
      socket.addEventListener("message", (event) => {
        if (event.data instanceof ArrayBuffer) { handleBinary(event.data); return; }
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "config") void configure(message as ConfigMessage);
          else if (message.type === "discontinuity") resetDecoders();
          else if (message.type === "stats") setStats((current) => ({ ...current, ...message }));
          else if (message.type === "status") {
            setStatus(message.state === "error" ? "Stream error" : message.state);
            if (message.message) setError(message.message);
            if (message.state === "stopped") setSession(undefined);
          }
        } catch { /* Ignore unknown server status. */ }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        resetDecoders();
        releaseControl();
        setStatus("Reconnecting media…");
        const delay = Math.min(5_000, 400 * 2 ** mediaAttempt++);
        mediaReconnect = window.setTimeout(connectMedia, delay);
      });
      socket.addEventListener("error", () => socket.close());
    };

    const connectControl = () => {
      if (disposed) return;
      const socket = new WebSocket(apiWebSocket(`/remote-viewer/sessions/${session.id}/control`));
      controlSocket.current = socket;
      socket.addEventListener("open", () => {
        controlAttempt = 0;
        socket.send(JSON.stringify({ type: "authenticate", token: getToken() }));
        if (pendingControl.current) {
          pendingControl.current = false;
          socket.send(JSON.stringify({ type: "lease" }));
        }
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (message.type === "lease") setControl(message.state === "granted" || message.state === "active");
          if (message.type === "error") { setControl(false); setError(message.message); }
        } catch { /* Ignore unknown control status. */ }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setControl(false);
        const delay = Math.min(5_000, 400 * 2 ** controlAttempt++);
        controlReconnect = window.setTimeout(connectControl, delay);
      });
      socket.addEventListener("error", () => socket.close());
    };

    connectMedia();
    connectControl();
    return () => {
      disposed = true;
      if (mediaReconnect) window.clearTimeout(mediaReconnect);
      if (controlReconnect) window.clearTimeout(controlReconnect);
      mediaSocket.current?.close();
      controlSocket.current?.close();
      cancelAnimationFrame(animation);
      resetDecoders();
    };
  }, [session?.id]);

  async function selectSource(source: CaptureSource) {
    setError(undefined);
    setSelected(source);
    setSourceDialogOpen(false);
    if (!session) {
      await start(source, canControl);
      return;
    }
    releaseControl();
    try {
      setStatus("Switching source…");
      const updated = await api.updateRemoteViewerSession(session.id, { sourceId: source.id, fps, resolution });
      setSession(updated);
      setStatus("Connected");
      props.api.setTitle(`Viewer · ${source.name}`);
      if (canControl) requestControlLease();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function start(source: CaptureSource, requestControl: boolean) {
    if (!settings.data) return;
    setError(undefined);
    setStatus("Checking decoder…");
    pendingControl.current = requestControl;
    try {
      if (!("VideoDecoder" in globalThis)) throw new Error("This client does not provide WebCodecs VideoDecoder support.");
      const candidates = await Promise.all([
        VideoDecoder.isConfigSupported({ codec: "avc1.42E01F", codedWidth: source.width, codedHeight: source.height }).then((result) => result.supported ? "h264" as const : undefined).catch(() => undefined),
        VideoDecoder.isConfigSupported({ codec: "vp8", codedWidth: source.width, codedHeight: source.height }).then((result) => result.supported ? "vp8" as const : undefined).catch(() => undefined),
      ]);
      const supportedCodecs = candidates.filter((codec): codec is "h264" | "vp8" => codec !== undefined);
      if (!supportedCodecs.length) throw new Error("This client supports neither H.264 nor VP8 video decoding.");
      if (settings.data.preferredCodec !== "auto" && !supportedCodecs.includes(settings.data.preferredCodec)) throw new Error(`${settings.data.preferredCodec.toUpperCase()} is required by administrator policy but unsupported by this client.`);
      if (settings.data.audioEnabled && !("AudioDecoder" in globalThis)) await import("opus-decoder");
      const created = await api.createRemoteViewerSession({ sourceId: source.id, fps, resolution, supportedCodecs });
      setSession(created);
      setStatus("Connecting…");
      props.api.setTitle(`Viewer · ${source.name}`);
    } catch (caught) {
      pendingControl.current = false;
      setStatus("Stopped");
      setError(errorMessage(caught));
    }
  }

  async function applyQuality(nextFps: number, nextResolution: RemoteViewerResolution) {
    const current = sessionRef.current;
    if (!current) return;
    releaseControl();
    try {
      setStatus("Restarting stream…");
      setSession(await api.updateRemoteViewerSession(current.id, { fps: nextFps, resolution: nextResolution }));
      setStatus("Connected");
      if (canControl) requestControlLease();
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }

  async function toggleFullscreen() {
    const stage = stageRef.current;
    if (!stage) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch (caught) {
      setError(`Fullscreen: ${errorMessage(caught)}`);
    }
  }

  function normalizedClientPoint(clientX: number, clientY: number) {
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    return { x: (clientX - bounds.left) / bounds.width, y: (clientY - bounds.top) / bounds.height };
  }

  function normalizedPointer(event: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) {
    return normalizedClientPoint(event.clientX, event.clientY) ?? { x: 0, y: 0 };
  }

  function queuePoint(point: { x: number; y: number }) {
    pendingPointer.current = point;
    if (pointerFrame.current !== undefined) return;
    pointerFrame.current = window.requestAnimationFrame(() => {
      pointerFrame.current = undefined;
      const point = pendingPointer.current;
      pendingPointer.current = undefined;
      if (point) sendControl({ type: "pointer", ...point });
    });
  }

  function queuePointer(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (!control || document.activeElement !== event.currentTarget) return;
    queuePoint(normalizedPointer(event));
  }

  function pointerButton(event: ReactPointerEvent<HTMLCanvasElement>, pressed: boolean) {
    if (!control) return;
    if (pressed) {
      event.preventDefault();
      event.currentTarget.focus();
    }
    const point = normalizedPointer(event);
    sendControl({ type: "button", button: String(event.button), pressed, ...point });
  }

  function touchPointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    touchPoints.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    });
    const points = [...touchPoints.current.values()];
    if (points.length === 1) touchGesture.current = { pinched: false, remotePressed: false };
    if (points.length === 2) {
      touchGesture.current.pinched = true;
      if (touchGesture.current.remotePressed) sendControl({ type: "release-all" });
      touchGesture.current.remotePressed = false;
      pinchStart.current = { distance: Math.max(1, touchDistance(points)), zoom: zoomRef.current };
    }
  }

  function touchPointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const point = touchPoints.current.get(event.pointerId);
    if (!point) return;
    const deltaX = event.clientX - point.x;
    const deltaY = event.clientY - point.y;
    point.x = event.clientX;
    point.y = event.clientY;
    if (Math.hypot(point.x - point.startX, point.y - point.startY) > 6) point.moved = true;
    const points = [...touchPoints.current.values()];
    if (points.length >= 2 && pinchStart.current) {
      const distance = touchDistance(points);
      const centerX = (points[0].x + points[1].x) / 2;
      const centerY = (points[0].y + points[1].y) / 2;
      changeZoom(pinchStart.current.zoom * distance / pinchStart.current.distance, centerX, centerY);
      return;
    }
    if (zoomRef.current > 1) {
      viewportRef.current?.scrollBy({ left: -deltaX, top: -deltaY });
      return;
    }
    if (!control || !point.moved) return;
    const current = normalizedClientPoint(event.clientX, event.clientY);
    if (!current) return;
    if (!touchGesture.current.remotePressed) {
      const start = normalizedClientPoint(point.startX, point.startY);
      if (start) sendControl({ type: "button", button: "0", pressed: true, ...start });
      touchGesture.current.remotePressed = true;
    }
    queuePoint(current);
  }

  function touchPointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    event.preventDefault();
    const point = touchPoints.current.get(event.pointerId);
    if (!point) return;
    const remotePoint = normalizedClientPoint(event.clientX, event.clientY);
    const pinched = touchGesture.current.pinched;
    touchPoints.current.delete(event.pointerId);
    if (!pinched && control && remotePoint) {
      if (touchGesture.current.remotePressed) {
        sendControl({ type: "button", button: "0", pressed: false, ...remotePoint });
      } else if (!point.moved) {
        sendControl({ type: "button", button: "0", pressed: true, ...remotePoint });
        sendControl({ type: "button", button: "0", pressed: false, ...remotePoint });
      }
    }
    if (touchPoints.current.size < 2) pinchStart.current = undefined;
    if (touchPoints.current.size === 0) touchGesture.current = { pinched: false, remotePressed: false };
  }

  function touchPointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    touchPoints.current.delete(event.pointerId);
    pinchStart.current = undefined;
    if (touchGesture.current.remotePressed) sendControl({ type: "release-all" });
    if (touchPoints.current.size === 0) touchGesture.current = { pinched: false, remotePressed: false };
  }

  function handleWheel(event: ReactWheelEvent<HTMLCanvasElement>) {
    if (event.ctrlKey) {
      event.preventDefault();
      const delta = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
      changeZoom(zoomRef.current * Math.exp(-delta * 0.01), event.clientX, event.clientY);
      return;
    }
    if (!control) return;
    event.preventDefault();
    sendControl({ type: "wheel", delta_x: event.deltaX, delta_y: event.deltaY });
  }

  const maxResolutionIndex = resolutionOrder.indexOf(settings.data?.maxResolution ?? "720p");
  const availableResolutions = resolutionOrder.slice(0, maxResolutionIndex + 1);
  const availableFps = [...new Set([15, 24, 30, 45, 60, settings.data?.maxFps ?? 30])].filter((value) => value <= (settings.data?.maxFps ?? 0)).sort((a, b) => a - b);
  const unavailable = settings.data && !settings.data.enabled;
  const unsupported = capabilities.data && !capabilities.data.captureAvailable;
  const canControl = Boolean(settings.data?.controlEnabled && capabilities.data?.controlAvailable && capabilities.data.controlPermission === "granted");
  const controlMessage = !settings.data?.controlEnabled
    ? "Remote control is disabled in Settings → Global → Remote Viewer."
    : !capabilities.data?.controlAvailable || capabilities.data.controlPermission === "unavailable"
      ? "Remote control is unavailable on this host."
      : capabilities.data.controlPermission === "granted"
        ? "Control is released on blur, disconnect, or tab restore."
        : "Host input permission will be required for control.";

  if (settings.isLoading || capabilities.isLoading) return <div className="empty-state"><LoaderCircle className="size-5 animate-spin" /><p>Checking Remote Viewer…</p></div>;
  if (unavailable) return <div className="empty-state"><Eye className="size-8" /><p>Remote Viewer is disabled by an administrator.</p></div>;
  if (unsupported) return <div className="empty-state"><AlertTriangle className="size-8" /><p>Remote Viewer is unavailable on this host platform.</p></div>;

  return <div className="panel-root remote-viewer-panel">
    <header className="remote-viewer-toolbar">
      <Button variant="ghost" size="sm" onClick={() => setSourceDialogOpen(true)}><Monitor />{session?.source.name ?? selected?.name ?? "Choose source"}</Button>
      <div className="ml-auto flex items-center gap-1">
        <Select value={String(fps)} onValueChange={(value) => { const next = Number(value); setFps(next); void applyQuality(next, resolution); }}><SelectTrigger className="h-7 w-[78px] px-2 text-[10px]"><SelectValue /></SelectTrigger><SelectContent>{availableFps.map((value) => <SelectItem key={value} value={String(value)}>{value} FPS</SelectItem>)}</SelectContent></Select>
        <Select value={resolution} onValueChange={(value) => { const next = value as RemoteViewerResolution; setResolution(next); void applyQuality(fps, next); }}><SelectTrigger className="h-7 w-[84px] px-2 text-[10px]"><SelectValue /></SelectTrigger><SelectContent>{availableResolutions.map((value) => <SelectItem key={value} value={value}>{value === "native" ? "Native" : value}</SelectItem>)}</SelectContent></Select>
        {session?.audioEnabled && <Button variant="ghost" size="icon-sm" title={muted ? "Unmute" : "Mute"} onClick={() => setMuted((value) => !value)}>{muted || !active ? <VolumeX /> : <Volume2 />}</Button>}
        {session && canControl && <Button variant={control ? "secondary" : "ghost"} size="sm" onClick={() => control ? releaseControl() : requestControlLease()}><Gamepad2 />{control ? "Control on" : "Retry control"}</Button>}
        {session && !canControl && <Button variant="ghost" size="sm" disabled title={controlMessage}><Gamepad2 />Control disabled</Button>}
        {session && <Button variant="ghost" size="icon-sm" title="Stop stream" onClick={() => stop()}><CircleStop /></Button>}
      </div>
    </header>
    <div className="remote-viewer-body">
      <main ref={stageRef} className="remote-viewer-stage" data-fullscreen={fullscreen || undefined}>
        {session ? <>
          <div ref={viewportRef} className="remote-viewer-viewport">
            <div className="remote-viewer-media">
              <canvas
                ref={canvasRef}
                className={cn("remote-viewer-canvas", control && "controlling")}
                style={fitSize ? { width: fitSize.width * zoom, height: fitSize.height * zoom } : undefined}
                width={session.width}
                height={session.height}
                tabIndex={control ? 0 : -1}
                onContextMenu={(event) => { if (control) event.preventDefault(); }}
                onPointerMove={(event) => event.pointerType === "touch" ? touchPointerMove(event) : queuePointer(event)}
                onPointerDown={(event) => event.pointerType === "touch" ? touchPointerDown(event) : pointerButton(event, true)}
                onPointerUp={(event) => event.pointerType === "touch" ? touchPointerUp(event) : pointerButton(event, false)}
                onPointerCancel={(event) => event.pointerType === "touch" ? touchPointerCancel(event) : releaseControl()}
                onWheel={handleWheel}
                onKeyDown={(event) => { if (!control || event.repeat) return; event.preventDefault(); sendControl({ type: "keyboard", code: event.code, key: event.key, pressed: true }); }}
                onKeyUp={(event) => { if (!control) return; event.preventDefault(); sendControl({ type: "keyboard", code: event.code, key: event.key, pressed: false }); }}
                onBlur={() => { if (control) releaseControl(); }}
              />
            </div>
          </div>
          <div className="remote-viewer-hud"><span className={cn("remote-viewer-live-dot", status.toLocaleLowerCase().includes("connect") && "online")} />{status}<span>{session.effectiveCodec.toUpperCase()} · {session.width}×{session.height} · {session.effectiveFps} FPS</span>{stats.bitrateKbps !== undefined && <span>{stats.bitrateKbps} Kbps</span>}{stats.dropped ? <span>{stats.dropped} dropped</span> : null}{session.audioEnabled && <span><AudioLines className="inline size-3" /> {active && !muted ? "audio" : "audio paused"}</span>}</div>
          <div className="remote-viewer-media-controls">
            <Button variant="secondary" size="icon-sm" aria-label="Zoom out" title="Zoom out" disabled={zoom <= minimumZoom} onClick={() => changeZoom(zoomRef.current - zoomStep)}><ZoomOut /></Button>
            <Button className="remote-viewer-zoom-value" variant="secondary" size="sm" title="Reset zoom to fit" onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</Button>
            <Button variant="secondary" size="icon-sm" aria-label="Zoom in" title="Zoom in" disabled={zoom >= maximumZoom} onClick={() => changeZoom(zoomRef.current + zoomStep)}><ZoomIn /></Button>
            <span className="remote-viewer-control-separator" />
            <Button variant="secondary" size="icon-sm" aria-label={props.api.isMaximized() ? "Restore panel" : "Maximize panel"} title={props.api.isMaximized() ? "Restore panel" : "Maximize panel"} onClick={() => props.api.isMaximized() ? props.api.exitMaximized() : props.api.maximize()}><Maximize2 /></Button>
            <Button variant="secondary" size="icon-sm" aria-label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} title={fullscreen ? "Exit fullscreen" : "Enter fullscreen"} onClick={() => void toggleFullscreen()}>{fullscreen ? <Minimize2 /> : <Fullscreen />}</Button>
          </div>
        </> : <div className="remote-viewer-placeholder"><Monitor /><p>Choose a {kind}. Streaming{canControl ? " and control" : ""} will start automatically.</p><Button onClick={() => setSourceDialogOpen(true)}><Monitor />Choose source</Button><small>{controlMessage}</small></div>}
      </main>
    </div>
    <Dialog open={sourceDialogOpen} onOpenChange={setSourceDialogOpen}>
      <DialogContent className="remote-viewer-source-dialog max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12"><DialogTitle>Choose source</DialogTitle><DialogDescription>Select an application window or an entire display.</DialogDescription></DialogHeader>
        <SourcePicker kind={kind} search={search} selectedId={selected?.id ?? session?.source.id} onKind={setKind} onSearch={setSearch} onSelect={(source) => void selectSource(source)} />
      </DialogContent>
    </Dialog>
    {error && <div className="remote-viewer-error"><AlertTriangle /><span>{error}</span><button type="button" aria-label="Dismiss error" onClick={() => setError(undefined)}><X /></button></div>}
  </div>;
}
