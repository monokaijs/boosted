# Boosted

Boosted is a local-first, multi-user coding workspace with a task board, task-specific Codex planning conversations, and separate general Codex chats. It ships one Vite + React frontend as an installable Progressive Web App (PWA) and a Tauri desktop shell.

Planning happens in chats. Choose **Plan** in a chat's composer to explore the repository, answer questions, and refine a plan, then switch to **Chat** to implement it. Task chats also show plan revisions, progress, and approval controls. Project tools contain Files and Changes.

## Development

Prerequisites: Node 22+, pnpm 10+, Rust 1.88+, Git, and the Codex CLI.

```bash
pnpm install
pnpm dev
cargo run -p boosted-server -- --web-dev-url http://127.0.0.1:5173
```

The browser client uses its current origin; during Vite development, `/api` and WebSocket requests are proxied to `http://127.0.0.1:4782`. Set `VITE_BOOSTED_API_URL` when the service runs elsewhere. The server stores local state under the platform application-data directory, or under `BOOSTED_DATA_DIR` when set.

Desktop development automatically serves the live Vite frontend through port 4782, including hot reload, so remote browsers receive the same UI as the desktop. The headless development command above enables the same behavior (`BOOSTED_WEB_DEV_URL` is the environment equivalent). Vite stays on loopback port 5173; remote browsers only need the backend port. Release desktop and backend builds use the same bundled `web/dist` assets.

The first browser visit creates the administrator. The admin then creates member accounts. All authenticated users share projects, tasks, chats, and host-level execution access; only the first user can manage accounts and the shared Codex connection.

> Boosted currently starts Codex with full host access, matching the selected product policy. Only expose the server to trusted users, and put remote access behind your own authenticated TLS proxy or tunnel.

## Machine connections

The web/PWA and desktop frontends can save multiple Boosted servers and switch between them from the machine selector or **Settings → Connections**. A connection has its own session and workspace state; switching replaces the whole active workspace, and Boosted never polls or combines data from saved machines.

When adding a machine, enter its local alias, URL, and account credentials. A scheme-less host such as `office-pc.local` becomes `http://office-pc.local:4782`; explicit HTTP/HTTPS schemes and ports are preserved. The server must already have its first administrator. Only the automatically generated local browser or desktop connection can perform first-run setup.

Boosted connects directly to the URL you provide. It does not provide TLS, server discovery, QR pairing, a relay, VPN/tunnel setup, port forwarding, DNS, or other remote-access configuration. Configure trusted routing and exposure yourself. Browsers block a plain-HTTP server when the frontend itself was loaded over HTTPS; use an HTTPS reverse proxy or load Boosted over HTTP in that case.

Existing installations migrate automatically. Browser clients retain the current origin, desktop clients retain `http://127.0.0.1:4782`, and development builds continue to honor `VITE_BOOSTED_API_URL`. The existing session and selected workspace move into that generated connection.

## Agents and provider accounts

Open **Agents** from the workspace rail (or **More → Agents** on mobile). Agents have separate persistent conversations, names, personalities, and avatars, and can manage coding chats across all registered projects. Create additional agents with **New agent**. Update an agent's identity in conversation, upload an avatar from its profile, or ask it to generate one.

Agents can also execute terminal commands, inspect and edit files, run scripts and tests, access the network, search the web, and call MCP tools configured in their selected account's Codex home. They run directly on the Boosted server machine with full host access and no execution approvals. For example, an agent can check GitLab issues through an installed, authenticated `glab`, or GitHub issues through `gh`; no issue-specific tool is required. Install and authenticate service CLIs on that machine. Native tool activity and results appear in the conversation alongside Boosted action receipts. **Stop** interrupts the agent's turn and cleans its terminals; background terminals are also cleaned when the turn finishes. Use coding chats or scheduled follow-ups for work that needs to persist beyond a turn.

All agents also receive the bundled [computer-control skill](server/skills/computer-control/SKILL.md) and native desktop tools. Ask an agent to operate an app: it can inspect displays, take screenshots, click, drag, scroll, type Unicode text, and press keyboard shortcuts. Tools control the selected **Boosted server machine**, including when you connect from a phone or another computer. Screenshots reach the model as images; action history saves only their metadata. Each input requires a recent screenshot, and desktop inputs are serialized across agents. **Stop** cancels pending input and stops multi-step actions between input events; it cannot undo input already delivered.

On macOS, enable **Screen Recording** and **Accessibility** for Boosted under **System Settings → Privacy & Security**. For a headless server launched in a terminal, grant these permissions to the terminal or executable identified by macOS, then restart it. Windows needs an interactive logged-in desktop. Linux desktop control needs an X11 session with `DISPLAY` and `XAUTHORITY` access; Wayland sessions are rejected. A server running without a desktop cannot control the connecting client's screen. Missing permissions and unavailable desktops produce setup errors. Linux source builds also need `pkg-config`, `libclang-dev`, `libxcb1-dev`, `libxrandr-dev`, `libdbus-1-dev`, `libpipewire-0.3-dev`, `libwayland-dev`, `libegl-dev`, `libgbm-dev`, and `libxkbcommon-dev`; headless Linux releases require their corresponding runtime libraries.

Use **Settings → Providers** or the agent panel's provider button to add isolated Codex accounts, sign in with a device code, inspect quotas, and configure each account's model, reasoning, access, speed, personality, and Codex home. Administrators manage provider accounts; authenticated members can use connected accounts and agents. Existing shared Codex task and chat connections continue to work.

Agent conversations support queued messages, images and files, action receipts linking to coding chats, stopping, account switching with preserved history, and quota failover. Ask an agent to watch a coding run or schedule a follow-up. These commitments persist and execute while the Boosted server runs, including with the browser closed. Agent notifications use Boosted's existing live PWA notification delivery.

The conversation and provider UI, agent instructions, tool definitions, and conversation-state helpers are ported from PockCode. Their runtime is implemented in Rust using Boosted's authenticated API, SQLite storage, and live event stream; no Node sidecar is required by the desktop or headless binaries.

## Issue integrations

Install GitLab or Huly under **Settings → Integrations**. After connection details are entered, Boosted discovers the accessible projects, groups, and workspaces and presents them as a searchable multi-select. GitLab discovery uses the supplied access token and the instance's REST API, following pagination so paths or numeric IDs do not need to be copied from GitLab manually.

Huly remains connector-based so cloud and self-hosted deployments can use the same adapter. Boosted authenticates to the connector with the configured username and password using HTTP Basic authentication. In addition to the existing issue request (`GET` with `workspace`, `project`, and `state=open`), a connector should support a Basic-authenticated `GET` with `action=discover` and return its accessible workspaces and projects:

```json
{
  "workspaces": [
    {
      "id": "acme",
      "name": "Acme",
      "projects": [
        { "id": "BOOST", "name": "Boosted" }
      ]
    }
  ]
}
```

Boosted also accepts a flat `targets` array and a `data` wrapper for connector implementations that already expose a normalized catalog. Older saved targets keep working, and manual target entry remains available as an advanced fallback for issue-only connectors.

## Progressive Web App

Production builds include a web app manifest, install icons, and a service worker. Open Boosted over HTTPS (or on localhost), then use the browser’s install action. Chromium browsers also show an in-app installation prompt when installation is available.

```bash
pnpm build
pnpm preview
```

The PWA precaches the application shell and prompts before activating a newly downloaded version, so an open workspace is never silently replaced. The shell can launch without a network connection, but project data, authentication, and Codex features still require access to a running Boosted server and are deliberately not cached.

System notifications can be enabled under **Settings → Notifications**. Preferences are stored separately for each saved Boosted machine and browser. Users can choose background-only or always-on delivery and independently configure task, Codex chat, and integration sync events. Notification clicks focus Boosted and open the related task or Codex chat when available. Because notifications are driven by the authenticated live connection, the PWA must still be open or running in the background; a fully closed browser does not receive push notifications.

## Headless server

The quickest way to start the headless server is through npm (Node.js 18+):

```bash
npx boosted-cli
```

Or install it globally and run `boosted-cli`. The npm launcher downloads and caches the native CLI for Linux x64, macOS Intel/Apple Silicon, or Windows x64. The CLI has the web app embedded, so it does not need a desktop environment or WebKit. The server host still needs Git and the Codex CLI.

No data-directory argument is required. Boosted stores its database, uploads, and managed worktrees in the platform application-data directory by default (`BOOSTED_DATA_DIR` remains available when a custom location is needed).

Open `http://<server>:4782` in a browser. The first launch listens publicly on `0.0.0.0:4782`. Administrators can change the port, disable browser UI serving, or allowlist remote IPv4/IPv6 addresses under **Settings → Global → Web interface**; saved changes apply after restarting Boosted. Localhost remains available when an allowlist is active.

Run `npx boosted-cli --help` for launch overrides. `--bind`, `--port`, `--disable-web-ui`, repeated `--allow-ip`, and `--public` override saved settings for that launch. `BOOSTED_BIND`, `BOOSTED_PORT`, `BOOSTED_DISABLE_WEB_UI`, `BOOSTED_ALLOWED_IPS`, `BOOSTED_DATA_DIR`, and `BOOSTED_WEB_DIR` provide environment equivalents; an external web directory overrides the embedded frontend.

Public access gives authenticated users host-level execution access. Use the IP allowlist or a firewall for trusted networks, and put internet-facing access behind an authenticated TLS proxy or tunnel.

To build and run the self-contained CLI from source:

```bash
pnpm build
cargo run --release -p boosted-server --features embedded-web -- serve
```

GitHub Releases also provide the standalone native CLI executables used by the npm launcher.

## Releases

Run the **Release Boosted** workflow from the repository's Actions tab and choose a `patch`, `minor`, or `major` version increment. The workflow builds standalone CLIs for Linux x64, Windows x64, and macOS Intel/Apple Silicon, plus Linux (`.deb` and `.AppImage`), Windows (`.exe` and `.msi`), and universal macOS (`.dmg`) installers. Once every build succeeds, it commits the synchronized version bump, creates the version tag, publishes a GitHub Release with SHA-256 checksums, and publishes `boosted-cli` to npm through Trusted Publishing.

Trusted Publishing requires an existing npm package. Bootstrap `boosted-cli` with one authenticated manual publish, then configure its npm package settings with GitHub organization/user `monokaijs`, repository `boosted`, and workflow filename `release.yml`. No npm token is needed for later releases.

Desktop builds check `monokaijs/boosted` GitHub Releases shortly after startup and every six hours. When a newer signed release is available, Boosted downloads it, verifies its updater signature, installs it, and relaunches. Administrators can also use **Settings → Application → Update Boosted** from the web UI or desktop app. This updates the selected machine’s desktop app, bundled backend, and web UI together, then restarts Boosted and refreshes the browser.

The same **Update Boosted** action updates any self-contained headless release, whether it was launched directly or through `boosted-cli`. The server downloads the matching native release with its bundled web UI, verifies it against `SHA256SUMS.txt`, activates it atomically in its update cache, and restarts itself. The browser waits for the updated server, activates the latest cached web app, and refreshes automatically. Desktop-hosted servers use the signed desktop updater through the same administrator-only API; they install the full app bundle after responding to the browser. The npm launcher recognizes the same active release when present, but npm is not required for web-based updates. Development and source builds without the embedded web app remain manual-update installations.

Updater packages are signed with the Tauri key whose public half is embedded in `desktop/src-tauri/tauri.conf.json`. The release workflow requires its private half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. Keep an offline backup of the private key: losing or replacing it prevents installed copies from trusting future updates. For a local release build using an unencrypted key, set `TAURI_SIGNING_PRIVATE_KEY` to the key’s path, export `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`, then run `pnpm desktop:build`.

The release workflow requires a Developer ID certificate and Apple notarization credentials for macOS. Follow [the macOS signing guide](docs/macos-signing.md) before the first release. Local macOS builds fall back to an ad-hoc signature; Windows installers remain unsigned.
