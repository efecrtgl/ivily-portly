# Changelog

All notable changes to Ivily Portly are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org).

## [Unreleased]

## [0.1.0] - 2026-11-27

First public release.

### Added

- **Port monitoring**: real-time TCP and UDP listeners over IPv4 and IPv6 with
  owning process, binding scope (localhost only / all interfaces / specific),
  well-known port hints and an adaptive refresh interval that slows down
  while the window is hidden.
- **Port Explorer**: search, filters, sorting and grouping, favorites, labels,
  notes and categories, and a port detail panel with live availability,
  bindings, claims and history.
- **Connections**: established and listening sockets with local and remote
  endpoints, connection categories, and transparent rule-based review hints
  (not malware detection).
- **Process Explorer**: name, PID, parent, path, owner, start time, CPU,
  memory, icon and dev-server recognition with reasons; open the file
  location, copy details, and confirmed, PID-reuse-safe termination that
  refuses critical Windows processes.
- **Projects**: register local projects with multiple ports, groups,
  favorites, metadata and directories; loopback health checks (TCP/HTTP),
  server history, detection of unregistered dev servers and of unrelated
  processes on registered ports. Start commands are reference-only and never
  executed.
- **Port Planner**: verified availability checks (socket table, test bind and
  Windows excluded ranges via netsh), suggestions, personal reservations
  (clearly Portly-only), custom ranges, and port allocation plans with
  collision validation and JSON/CSV/Markdown export.
- **Profiles**: web, backend, full-stack, game, testing, personal and custom
  profiles that focus the dashboard and health monitoring — they never run
  anything.
- **Conflict intelligence**: shared ports, unexpected occupants, Windows
  excluded ports, ownership changes, unresponsive servers, address
  mismatches, plan collisions and occupied reservations, each with
  explanations, suggestions and verified-free alternative ports.
- **Dashboard** with configurable cards, and an **Activity Center** with
  filtering, search, retention and clearing.
- **Data safety**: SQLite with migrations, a backup before every upgrade,
  integrity checks with recovery, backup/restore and JSON import/export.
- **Ivily Ecosystem Protocol 0.1** (CLI transport, read-only,
  privacy-minimized summaries; can be disabled).
- Windows notifications, dark/light/system themes, custom window frame.
- Per-user NSIS installer, signed in-app updates with confirmation, portable
  zip and SHA-256 checksums.

[Unreleased]: https://github.com/efecrtgl/ivily-portly/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/efecrtgl/ivily-portly/releases/tag/v0.1.0
