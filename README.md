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

## Releases

Run the **Release desktop apps** workflow from the repository's Actions tab and choose a `patch`, `minor`, or `major` version increment. The workflow builds Linux (`.deb` and `.AppImage`), Windows (`.exe` and `.msi`), and universal macOS (`.dmg`) installers. Once every build succeeds, it commits the synchronized version bump, creates the version tag, and publishes a GitHub Release with SHA-256 checksums.

The macOS bundle uses an ad-hoc signature. Windows installers are unsigned, and the macOS app is not notarized, so production distribution will require platform signing credentials.
