# Boosted

Boosted is a local-first, multi-user coding workspace with a task board, task-specific Codex planning conversations, and separate general Codex chats. It ships one Vite + React frontend as an installable Progressive Web App (PWA) and a Tauri desktop shell.

## Development

Prerequisites: Node 22+, pnpm 10+, Rust 1.85+, Git, and the Codex CLI.

```bash
pnpm install
pnpm dev
cargo run -p boosted-server
```

The browser client uses its current origin; during Vite development, `/api` and WebSocket requests are proxied to `http://127.0.0.1:4782`. Set `VITE_BOOSTED_API_URL` when the service runs elsewhere. The server stores local state under the platform application-data directory, or under `BOOSTED_DATA_DIR` when set.

The first browser visit creates the administrator. The admin then creates member accounts. All authenticated users share projects, tasks, history, terminals, and host-level execution access; only the first user can manage accounts and the shared Codex connection.

> Boosted currently starts Codex with full host access, matching the selected product policy. Only expose the server to trusted users, and put remote access behind your own authenticated TLS proxy or tunnel.

## Machine connections

The web/PWA and desktop frontends can save multiple Boosted servers and switch between them from the machine selector or **Settings → Connections**. A connection has its own session and workspace state; switching replaces the whole active workspace, and Boosted never polls or combines data from saved machines.

When adding a machine, enter its local alias, URL, and account credentials. A scheme-less host such as `office-pc.local` becomes `http://office-pc.local:4782`; explicit HTTP/HTTPS schemes and ports are preserved. The server must already have its first administrator. Only the automatically generated local browser or desktop connection can perform first-run setup.

Boosted connects directly to the URL you provide. It does not provide TLS, server discovery, QR pairing, a relay, VPN/tunnel setup, port forwarding, DNS, or other remote-access configuration. Configure trusted routing and exposure yourself. Browsers block a plain-HTTP server when the frontend itself was loaded over HTTPS; use an HTTPS reverse proxy or load Boosted over HTTP in that case.

Existing installations migrate automatically. Browser clients retain the current origin, desktop clients retain `http://127.0.0.1:4782`, and development builds continue to honor `VITE_BOOSTED_API_URL`. The existing session and selected workspace move into that generated connection.

## Remote Viewer

On macOS and Windows, administrators can enable **Settings → Global → Remote Viewer** to let authenticated members select a host window or display, stream its video and system audio, and optionally control it from the web UI. Multiple independent viewer tabs can run concurrently. Media and input use authenticated WebSockets on the same Boosted HTTP(S) origin, including through WebSocket-capable cloudflared HTTPS tunnels; no TURN server or extra exposed port is required. See the [Remote Viewer guide](docs/remote-viewer.md) for permissions, protocol details, and security considerations.

## Issue integrations

Install GitLab or Huly under **Settings → Integrations**. After connection details are entered, Boosted discovers the projects, groups, and workspaces visible to the supplied token and presents them as a searchable multi-select. GitLab discovery uses the instance's REST API and follows pagination, so paths or numeric IDs do not need to be copied from GitLab manually.

Huly remains connector-based so cloud and self-hosted deployments can use the same adapter. In addition to the existing issue request (`GET` with `workspace`, `project`, and `state=open`), a connector should support a bearer-authenticated `GET` with `action=discover` and return its accessible workspaces and projects:

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

The PWA precaches the application shell and prompts before activating a newly downloaded version, so an open workspace is never silently replaced. The shell can launch without a network connection, but project data, authentication, terminals, and Codex features still require access to a running Boosted server and are deliberately not cached.

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

Desktop builds check `monokaijs/boosted` GitHub Releases shortly after startup and every six hours. When a newer signed release is available, Boosted downloads it, verifies its updater signature, installs it, and relaunches. A manual **Check now** action and update progress are available under **Settings → Application**.

Administrators can also use **Settings → Application → Check now** in the web UI to update a headless server launched through `boosted-cli`. The server downloads the matching native release, verifies it against `SHA256SUMS.txt`, activates it atomically in the CLI cache, and asks the npm launcher to restart it. Direct standalone executables and source builds remain manual-update installations so the web server never overwrites an unmanaged binary.

Updater packages are signed with the Tauri key whose public half is embedded in `desktop/src-tauri/tauri.conf.json`. The release workflow requires its private half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. Keep an offline backup of the private key: losing or replacing it prevents installed copies from trusting future updates. For a local release build using an unencrypted key, set `TAURI_SIGNING_PRIVATE_KEY` to the key’s path, export `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`, then run `pnpm desktop:build`.

The release workflow requires a Developer ID certificate and Apple notarization credentials for macOS. Follow [the macOS signing guide](docs/macos-signing.md) before the first release. Local macOS builds fall back to an ad-hoc signature; Windows installers remain unsigned.
