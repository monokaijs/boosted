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
./boosted serve --bind 0.0.0.0:4782 --data-dir ./data
```

Open `http://<server>:4782` in a browser. Run `./boosted serve --help` for all options. `BOOSTED_BIND`, `BOOSTED_DATA_DIR`, and `BOOSTED_WEB_DIR` are equivalent environment variables; an external web directory overrides the embedded frontend.

The CLI binds to `127.0.0.1:4782` by default. Binding to a public interface gives authenticated users host-level execution access, so restrict the port with a firewall and put internet-facing access behind an authenticated TLS proxy or tunnel.

To build and run the self-contained CLI from source:

```bash
pnpm build
cargo run --release -p boosted-server --features embedded-web -- serve
```

## Releases

Run the **Release Boosted** workflow from the repository's Actions tab and choose a `patch`, `minor`, or `major` version increment. The workflow builds the standalone Linux CLI, Linux (`.deb` and `.AppImage`), Windows (`.exe` and `.msi`), and universal macOS (`.dmg`) installers. Once every build succeeds, it commits the synchronized version bump, creates the version tag, and publishes a GitHub Release with SHA-256 checksums.

The release workflow requires a Developer ID certificate and Apple notarization credentials for macOS. Follow [the macOS signing guide](docs/macos-signing.md) before the first release. Local macOS builds fall back to an ad-hoc signature; Windows installers remain unsigned.
