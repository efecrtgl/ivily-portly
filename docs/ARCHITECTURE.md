# Architecture

Ivily Portly is a Tauri 2 application: a Rust backend that talks to Windows
APIs and SQLite, and a React (plain JavaScript) frontend rendered in WebView2.

```
┌──────────────────────────── WebView2 (React) ─────────────────────────────┐
│ pages/ Dashboard · Ports · Connections · Processes · Projects · Planner │
│        Profiles · Activity · Settings                                    │
│ components/ ProcessDrawer · PortDrawer · ui/*                            │
│ app/store.jsx  live state ← events  ·  lib/api.js  → invoke()            │
└───────────────▲──────────────────────────────────┬────────────────────────┘
   portly://snapshot | conflicts | health | event │ IPC commands (validated)
┌───────────────┴──────────────────────────────────▼────────────────────────┐
│ commands.rs ── validate.rs                                               │
│ monitor/  scan thread: net + process → model::Snapshot → diff → events   │
│           health thread: health.rs (loopback TCP/HTTP)                   │
│ conflicts.rs  planner.rs  insight.rs  exchange.rs  iep.rs  settings.rs   │
│ net/  win.rs (IP Helper)  classify.rs  excluded.rs (netsh)               │
│ process/  win.rs (Toolhelp, OpenProcess)  devserver.rs  protect.rs  icon │
│ store/  projects  profiles  ports  plans  events   ←  db/ (SQLite)        │
└──────────────────────────────────────────────────────────────────────────┘
```

## Backend modules (`src-tauri/src`)

| Module | Responsibility |
|---|---|
| `net/mod.rs` | Platform-independent socket model (`SocketEntry`, `Protocol`, `SocketState`, `BindScope`). |
| `net/win.rs` | `GetExtendedTcpTable` / `GetExtendedUdpTable` with `*_OWNER_PID` for IPv4 and IPv6. Grows buffers safely; UDP failures don't hide TCP data. |
| `net/classify.rs` | Binding scope, connection category (local/LAN/internet), well-known port hints, dynamic range. |
| `net/excluded.rs` | Windows excluded port ranges via fixed `netsh` invocations; locale-independent parser. |
| `process/win.rs` | Toolhelp snapshot (name, parent, threads) and limited-query details (path, times, memory, owner). Termination with start-time identity check. |
| `process/devserver.rs` | Rule-based categories (dev runtime, database, web server, container, browser, system) and dev-server recognition with reasons. |
| `process/protect.rs` | Termination risk assessment; blocks critical Windows processes. |
| `process/icon.rs` | Executable icon → PNG data URL (GDI), tiny base64 encoder. |
| `insight.rs` | Transparent review indicators for listeners. |
| `monitor/model.rs` | Builds the `Snapshot` sent to the UI (ports grouped by protocol+port, processes, connections, stats). |
| `monitor/diff.rs` | Opened / closed / owner-changed detection between snapshots. |
| `monitor/mod.rs` | The engine: scan and health threads, adaptive interval, config cache, event recording, notifications, conflict evaluation, alternative-port suggestions. |
| `conflicts.rs` | Pure conflict engine and plan validation. |
| `health.rs` | Loopback-only TCP/HTTP checks; records which address family answered. |
| `planner.rs` | Verified availability (socket table + test bind + OS exclusions) and suggestions. |
| `store/*` | Typed repositories: projects/groups, profiles, port notes/reservations/ranges, plans, events/health samples/inspections. |
| `db/` | Connection management, migrations, backups, integrity and recovery. See [DATA.md](DATA.md). |
| `settings.rs` | Settings document with defaults and clamping. |
| `exchange.rs` | Versioned import/export; plan CSV/Markdown rendering. |
| `iep.rs` | Ivily Ecosystem Protocol provider. See [IEP.md](IEP.md). |
| `validate.rs` | Shared input validation for IPC. |
| `commands.rs` | Tauri command surface. Heavy commands are `async` so the UI thread never blocks. |
| `state.rs` | App state (DB, monitor, icon cache) and the Tauri event sink. |

### Monitoring loop

1. Read the socket tables and the process snapshot (≈ a few ms).
2. Open every socket-owning process with `PROCESS_QUERY_LIMITED_INFORMATION`
   to read path, start time, memory and CPU time; CPU % is the delta since the
   previous sample divided by wall time and core count.
3. Build the snapshot; diff listeners against the previous one.
4. Record events for *interesting* ports (registered, favorite/annotated,
   reserved, planned — or all ports when enabled).
5. Evaluate conflicts; new conflicts are recorded and optionally notified.
6. Emit the snapshot only if its fingerprint changed (or every third tick to
   refresh CPU/memory figures).

The interval is configurable (default 2 s) and automatically slows down
(default 10 s) while the window is hidden or minimized. Monitoring can be
paused. The health thread probes registered project ports (default every
10 s, ×3 while hidden), honoring the active profile.

There is **no background service and no tray residency**: both threads end
when the window closes.

## Frontend (`src`)

- `app/store.jsx` — providers for live data (from events), configuration
  collections with explicit `reload()`, settings, navigation and the global
  drawers.
- `lib/api.js` — one wrapper per IPC command; errors normalized to
  `{ code, message }`.
- `lib/format.js`, `lib/domain.js` and per-area helpers — pure functions with
  Vitest tests.
- `components/ui` — primitives (buttons, table, modal + confirm, drawer,
  toasts, icons). `ProcessDrawer` and `PortDrawer` are shared detail views.
- `pages/*` — lazy-loaded views.

## Security boundaries

See [SECURITY.md](../SECURITY.md). Capabilities (`src-tauri/capabilities/default.json`)
grant only window controls, dialogs, notifications, updater and process
restart. There is no `fs`, `shell` or `http` plugin in the webview.
