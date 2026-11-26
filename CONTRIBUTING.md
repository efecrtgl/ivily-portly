# Contributing to Ivily Portly

Thanks for helping! Portly aims to be a small, reliable and honest Windows
utility. Stability, security and clarity come before feature count.

## Development setup

Requirements: Windows 10/11 (x64), [Rust](https://rustup.rs) stable,
Node.js 22+, and the WebView2 runtime (preinstalled on Windows 11).

```powershell
npm ci
npm run tauri dev      # run the app with hot reload
```

Useful commands:

| Command | Purpose |
|---|---|
| `npm run check` | ESLint over `src/` |
| `npm test` | Vitest (frontend logic) |
| `npm run build` | Production frontend build |
| `cd src-tauri; cargo test` | Rust unit and Windows integration tests |
| `cd src-tauri; cargo clippy --all-targets -- -D warnings` | Lints (CI gate) |
| `cd src-tauri; cargo fmt` | Formatting |
| `npm run tauri build` | Local installer build (unsigned updater artifacts need the signing key; see docs/RELEASING.md) |

## Ground rules

- **Plain JavaScript** in the frontend — no TypeScript.
- **No automatic execution.** Nothing may run user/project commands without an
  explicit, per-run user approval flow (which does not exist yet).
- **No elevation.** Features must work as a standard user or degrade
  gracefully with a clear explanation.
- **Validate in Rust.** Every new IPC command validates all arguments; never
  rely on the UI.
- **Honest UI.** Don't claim more than was verified (availability, OS
  reservations, security indicators).
- **Tests.** Pure logic gets unit tests; Windows API code gets integration
  tests that exercise the real API where possible.
- **Dependencies.** Avoid new ones. If unavoidable, justify them in the PR.
- **Migrations.** Never edit a released migration in
  `src-tauri/src/db/schema.rs`; append a new one and bump `SCHEMA_VERSION`.

## Commits and pull requests

- Use meaningful English commit messages in
  [Conventional Commits](https://www.conventionalcommits.org) style
  (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, `ci:`).
- Stage files explicitly — never commit build output, `.env` files, keys or
  local tool settings.
- Keep PRs focused; fill in the PR template checklist.
- Update `CHANGELOG.md` under **Unreleased** for user-facing changes.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the module map.
