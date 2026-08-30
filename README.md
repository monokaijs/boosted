# Boosted

Boosted is a local-first, multi-user coding workspace with a task board, task-specific Codex planning conversations, and separate general Codex chats. It ships one Vite + React frontend for both the browser and a Tauri desktop shell.

## Development

Prerequisites: Node 22+, pnpm 10+, Rust 1.85+, Git, and the Codex CLI.

```bash
pnpm install
pnpm dev
cargo run -p boosted-server
```

The web client defaults to `http://127.0.0.1:4782`. Set `VITE_BOOSTED_API_URL` when the service runs elsewhere. The server stores local state under the platform application-data directory, or under `BOOSTED_DATA_DIR` when set.

The first browser visit creates the administrator. The admin then creates member accounts. All authenticated users share projects, tasks, history, terminals, and host-level execution access; only the first user can manage accounts and the shared Codex connection.

> Boosted currently starts Codex with full host access, matching the selected product policy. Only expose the server to trusted users, and put remote access behind your own authenticated TLS proxy or tunnel.

## Headless server

GitHub Releases include a standalone Linux CLI with the web app embedded, so it does not need a desktop environment or WebKit. The server host still needs Git and the Codex CLI. Download and extract `boosted-<version>-linux-x86_64.tar.gz`, then run:

```bash
./boosted serve --data-dir ./data
```

Open `http://<server>:4782` in a browser. The first launch listens publicly on `0.0.0.0:4782`. Administrators can change the port, disable browser UI serving, or allowlist remote IPv4/IPv6 addresses under **Settings → Global → Web interface**; saved changes apply after restarting Boosted. Localhost remains available when an allowlist is active.

Run `./boosted serve --help` for launch overrides. `--bind`, `--port`, `--disable-web-ui`, repeated `--allow-ip`, and `--public` override saved settings for that launch. `BOOSTED_BIND`, `BOOSTED_PORT`, `BOOSTED_DISABLE_WEB_UI`, `BOOSTED_ALLOWED_IPS`, `BOOSTED_DATA_DIR`, and `BOOSTED_WEB_DIR` provide environment equivalents; an external web directory overrides the embedded frontend.

Public access gives authenticated users host-level execution access. Use the IP allowlist or a firewall for trusted networks, and put internet-facing access behind an authenticated TLS proxy or tunnel.

To build and run the self-contained CLI from source:

```bash
pnpm build
cargo run --release -p boosted-server --features embedded-web -- serve
```

## Releases

Run the **Release Boosted** workflow from the repository's Actions tab and choose a `patch`, `minor`, or `major` version increment. The workflow builds the standalone Linux CLI, Linux (`.deb` and `.AppImage`), Windows (`.exe` and `.msi`), and universal macOS (`.dmg`) installers. Once every build succeeds, it commits the synchronized version bump, creates the version tag, and publishes a GitHub Release with SHA-256 checksums.

Desktop builds check `monokaijs/boosted` GitHub Releases shortly after startup and every six hours. When a newer signed release is available, Boosted downloads it, verifies its updater signature, installs it, and relaunches. A manual **Check now** action and update progress are available under **Settings → Application**. Browser and headless-server sessions do not run the desktop updater.

Updater packages are signed with the Tauri key whose public half is embedded in `desktop/src-tauri/tauri.conf.json`. The release workflow requires its private half in the `TAURI_SIGNING_PRIVATE_KEY` repository secret; `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is optional. Keep an offline backup of the private key: losing or replacing it prevents installed copies from trusting future updates. For a local release build using an unencrypted key, set `TAURI_SIGNING_PRIVATE_KEY` to the key’s path, export `TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""`, then run `pnpm desktop:build`.

The release workflow requires a Developer ID certificate and Apple notarization credentials for macOS. Follow [the macOS signing guide](docs/macos-signing.md) before the first release. Local macOS builds fall back to an ad-hoc signature; Windows installers remain unsigned.
