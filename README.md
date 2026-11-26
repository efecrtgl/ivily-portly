<div align="center">

<img src="assets/logo.svg" width="96" alt="Ivily Portly logo" />

# Ivily Portly

**Understand, monitor and organize local ports, processes and development servers on Windows.**

[![CI](https://github.com/efecrtgl/ivily-portly/actions/workflows/ci.yml/badge.svg)](https://github.com/efecrtgl/ivily-portly/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-black.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011%20x64-black)

</div>

Ivily Portly is a lightweight, open-source desktop utility for developers. It
shows which program holds which port, what your local dev servers are doing,
and why a port is "already in use" — without administrator rights and without
ever running commands for you. It works on its own and is ready to integrate
with the Ivily ecosystem.

## Features

- **Real-time port monitoring** — TCP and UDP, IPv4 and IPv6, owning process,
  binding scope (localhost only / all interfaces), well-known port hints.
  Adaptive refresh that slows down while the window is hidden.
- **Process intelligence** — path, owner, parent, start time, CPU, memory,
  icon and dev-server recognition with transparent reasons.
- **Safe process actions** — open the file location, copy details, and a
  confirmed termination flow that refuses critical Windows processes and
  guards against PID reuse.
- **Development server manager** — register projects with multiple ports,
  groups, favorites and metadata; loopback-only TCP/HTTP health checks,
  server history, detection of unregistered dev servers and of unrelated
  processes on your ports.
- **Port Planner** — *verified* availability (socket table + test bind +
  Windows excluded ranges), suggestions, personal reservations (clearly
  Portly-only), custom ranges and exportable port allocation plans with
  collision validation.
- **Conflict intelligence** — shared ports, unexpected occupants, Windows
  exclusions, ownership changes, unresponsive servers and address mismatches,
  each with an explanation and safe suggestions.
- **Profiles** — web, backend, full-stack, game, testing and custom
  profiles that focus monitoring; they never run anything.
- **Network connections** — established and listening sockets with
  categories and rule-based review hints (not malware detection; no traffic
  inspection).
- **Activity Center** — persistent, searchable history with retention and
  privacy controls.
- **Data safety** — SQLite with migrations, a backup before every upgrade,
  integrity checks with recovery, backup/restore and JSON import/export.
- **Ivily Ecosystem Protocol** — optional, read-only, local integration
  surface for Ivily Center.
- Premium monochrome interface with dark/light themes and a custom window
  frame.

## Install

Download the latest installer from
[Releases](https://github.com/efecrtgl/ivily-portly/releases), verify it with
`SHA256SUMS.txt`, and run it — no administrator rights needed. A portable zip
is also provided. See [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Principles

| | |
|---|---|
| **Least privilege** | Runs as a standard user; never asks for elevation. |
| **Nothing runs automatically** | Portly never executes project commands. Termination always needs your confirmation. |
| **Honest** | Only Windows-verified exclusions are called "reserved by Windows". Indicators are review hints, not detections. Availability is verified, not guessed. |
| **Local and private** | No telemetry. Health checks contact loopback only. Paths aren't stored in history unless you opt in. |
| **Light** | Two short-lived worker threads while the window is open; no service, no tray residency. |

## Documentation

- [Usage guide](docs/USAGE.md)
- [Installation](docs/INSTALLATION.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Data management](docs/DATA.md)
- [Ivily Ecosystem Protocol](docs/IEP.md)
- [Versioning](docs/VERSIONING.md) · [Releasing](docs/RELEASING.md)
- [Security policy](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)

## Build from source

```powershell
npm ci
npm run tauri dev     # development
npm run tauri build   # installer → src-tauri\target\release\bundle\nsis
```

Tests: `npm run check`, `npm test`, and in `src-tauri`: `cargo test`,
`cargo clippy --all-targets -- -D warnings`.

## Tech

Rust · Tauri 2 · React 19 (plain JavaScript) · SQLite (rusqlite) · Windows IP
Helper and process APIs.

## License

[MIT](LICENSE) © 2026 efecrtgl
