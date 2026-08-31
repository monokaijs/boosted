# Remote Viewer

Remote Viewer streams a selected application window or host display into a dedicated, maximized workspace group. It never shares a tab group with Git changes, files, plans, chats, or other tools. Open it from the right rail; use the `+` action in its viewer-only tab group to view several sources at once. A compact source drawer leaves the rest of the workspace to the stream. Every restored viewer tab starts stopped. Viewing, control, and machine-wide quality limits are configured under **Settings → Global → Remote Viewer** and are disabled by default.

Hover or tap the stream to reveal its media controls. The viewer can zoom from 50% to 400%, reset to the fitted 100% size, maximize its workspace panel, or place the stream itself in browser fullscreen. Trackpad and touchscreen pinch gestures zoom around the gesture center; a one-finger drag pans a zoomed touchscreen view. These operations scale only the local canvas and do not restart the stream or change its configured capture resolution.

The host must be macOS or Windows with a logged-in graphical desktop. macOS requires Screen Recording permission for viewing and Accessibility permission for control. Windows capture uses Windows Graphics Capture; input into elevated applications can be rejected by Windows integrity-level isolation. Linux reports the feature as unsupported.

Remote Viewer uses only the existing Boosted HTTP(S) origin:

- Authenticated REST enumerates ephemeral window/display IDs, loads lazy thumbnails, and creates, updates, or stops viewer sessions.
- Window mode lists user application windows only: operating-system surfaces such as macOS Control Center and Notification Center or Windows shell hosts are excluded. A selected window is captured independently, so unrelated overlays are not part of its stream. Display mode intentionally mirrors the complete selected display.
- Each session opens a media WebSocket and a separate control WebSocket. Both require the normal bearer token as their first message and verify session ownership.
- Video is H.264 or VP8. Tabs using the same source, codec, resolution, and FPS share one capture/encoder pipeline. System output is encoded as 48 kHz stereo Opus and is shared machine-wide. The active viewer tab is the only tab that plays audio by default.
- Control uses a single heartbeat-backed lease per source. Blur, a hidden tab, a source change, socket loss, or disabling control releases held buttons and keys.

The binary media envelope is network-byte-order and begins with this fixed 24-byte header:

| Offset | Size | Meaning |
| --- | ---: | --- |
| 0 | 4 | ASCII `BRV1` |
| 4 | 1 | Kind: `1` video, `2` audio |
| 5 | 1 | Flags: bit 0 is key frame |
| 6 | 2 | Reserved |
| 8 | 8 | Sequence number |
| 16 | 8 | Presentation timestamp in microseconds |
| 24 | rest | Encoded payload |

Text messages carry decoder configuration, discontinuities, state, and statistics. Media queues are bounded; lagging clients discard stale frames and request a fresh keyframe. Changing source, FPS, or resolution keeps the session ID but resets the client decoders.

## Tunnels and security

An HTTPS tunnel or reverse proxy must forward WebSocket upgrades and allow long-lived connections. Remote Viewer needs no UDP ports, TURN server, or separate media hostname, so it works through a normal cloudflared HTTPS hostname. Tunnel interruption triggers bounded reconnect attempts; control is never reacquired automatically.

Every authenticated Boosted member can see and control the graphical desktop when the administrator enables the corresponding policy. Treat this as host-level access, use only trusted accounts, and protect internet-facing instances with TLS and appropriate tunnel access policy.

System audio is the complete output mix even for a single-window session. Boosted excludes its own process audio where the operating system supports it, but other private notifications or applications may be audible. Protected media may produce black video or silence. Microphone capture, HDR, clipboard and file transfer, Linux capture, and synthesized multi-touch are not supported.
