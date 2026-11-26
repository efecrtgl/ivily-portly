# Roadmap

Ivily Portly is built in incremental phases. Every phase follows the same
loop: audit → implement → test → fix → review → commit → push → verify →
document. A phase is only marked done when its tests actually ran and passed.

## Phase 0 — Audit and scaffold ✅

- Audited the repository (empty on GitHub, no prior history to preserve) and
  the sibling Ivily apps for shared conventions: Tauri 2 + React + plain
  JavaScript, rusqlite, the monochrome design tokens, per-user NSIS installs,
  and IEP 0.1 over a CLI transport.
- Project scaffold: Tauri 2, React 19, Vite, Vitest, ESLint, least-privilege
  capabilities, strict CSP, a custom window frame, and a dedicated updater
  signing key (private key kept outside the repository).

## Phase 1 — Backend core ✅

- Port discovery: TCP/UDP, IPv4/IPv6, owner PID (`GetExtendedTcpTable` /
  `GetExtendedUdpTable`), binding scope, connection categories, well-known port
  hints.
- OS port exclusions verified through `netsh` (the only source Portly ever
  labels "reserved by Windows").
- Process intelligence: name, PID, parent, path, owner, start time, memory,
  CPU, icon, dev-server recognition with reasons, and rule-based review
  indicators.
- Safe termination: a confirmed, PID-reuse-safe flow where critical processes
  are blocked.
- SQLite: migrations, a backup before upgrades, integrity check and
  corrupt-file recovery, newer-schema protection, and backup/restore.
- Stores: projects (multi-port, groups, favorites, metadata), profiles, port
  notes/labels/favorites, personal reservations, ranges, plans, activity
  events, health samples and inspections.
- Engines: snapshot model, change diffing, conflict intelligence, health
  checks (loopback only), port planner (verified availability and
  suggestions), import/export, and the IEP provider.

## Phase 2 — Interface

- App shell: custom title bar, sidebar, themes, toasts, dialogs.
- Dashboard, Port Explorer, Connections, Process Explorer, Projects (server
  manager), Port Planner (availability, reservations, ranges, plans),
  Profiles, Activity Center, Settings.

## Phase 3 — Repository infrastructure

- README, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, CHANGELOG, architecture,
  installation, usage, IEP and versioning documentation.
- Issue and PR templates, CI (lint, tests, fmt, clippy, audit), Dependabot.

## Phase 4 — Release

- NSIS installer (per-user, data preserved across upgrades), signed updater
  artifacts, `latest.json`, a portable zip and SHA-256 checksums.
- Tag-triggered release workflow, in-app update detection with
  user-confirmed installation.

## Later

- Optional, explicitly approved start/stop commands for projects (verified
  paths, per-run confirmation, never automatic).
- IEP named-pipe transport for live status (same-user ACL, only while Portly
  is open).
- Turkish interface language to match the rest of the ecosystem.
