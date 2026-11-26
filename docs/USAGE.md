# Usage guide

Portly runs as a standard user. Everything below works without administrator
rights; where Windows hides details of elevated or other users' processes,
Portly says so instead of elevating.

## Title bar

Shows live counts (listening ports, connections, active conflicts). **Refresh**
forces a scan; **Pause** stops monitoring (and health checks) until resumed.
The window can be moved by dragging the title bar and maximized by
double-clicking it.

## Dashboard

Configurable overview (**Customize** hides/shows cards): live statistics,
conflict alerts with suggestions and verified-free alternative ports, running
development servers, server health of your projects, favorite ports, recently
inspected processes, recently monitored projects, port utilization by range
and exposure, and monitoring activity over the last 24 hours. When a profile
is active, project cards only cover that profile's projects.

## Ports

Every listening TCP port and bound UDP port, grouped by protocol and port
number, with owning process, addresses (IPv4/IPv6), exposure (localhost only,
all interfaces, specific interface), label, project and conflicts.

- Search matches port, process, address, labels/notes and well-known names.
- Filter by protocol and exposure; show only favorites, registered ports or
  dev servers; hide the dynamic range (49152+).
- Sort and group by process, category, exposure or protocol.
- **Check TCP port** tests a port number without leaving the page.
- Newly opened ports are briefly highlighted.

Click a row to open the **port panel**: live availability (re-checkable),
Windows exclusions, bindings and their processes, claims in Portly (projects,
plans, personal reservations), label/category/notes/favorite and history.

## Connections

Established and other non-listening sockets plus listening sockets, with
local/remote endpoints, state and category (local, local network, internet).
Summary cards show connections by category, top remote endpoints and top
processes. **Review hints** list listeners matching transparent rules (for
example a listener running from a temporary folder, or a Windows component
name outside the Windows folder); **Exposed listeners** are reachable from
other devices. These are hints for your own review — not malware detection.
Portly never captures or inspects traffic.

## Processes

Processes that own at least one socket, with category, dev-server badge,
ports, connections, CPU, memory, uptime and access level. Filter by category,
dev servers, listeners or review hints; optionally group by parent process.

Click a process to open the **process panel**: executable path, owner,
parent and children, start time, CPU/memory, why Portly classified it,
ports, registered projects, indicators and actions:

- **Open file location** (Explorer selects the executable).
- **Copy PID / Copy details**.
- **Terminate…** — shows the risk assessment first. Critical Windows
  processes and Portly itself cannot be terminated. High-risk targets require
  typing the process name. The process must still be the same instance you
  confirmed (PID reuse is detected). Windows may still deny the request for
  elevated or other users' processes; Portly never elevates.

## Projects

Register local projects and the ports they use:

- Name, description, directory (**Browse…**), group, favorite, custom
  metadata.
- **Start command** is reference text only — Portly never runs it.
- Ports: number, protocol, role, host (`localhost`, `127.0.0.1`, `::1`),
  health check (none/TCP/HTTP with path) and optional expected process
  (**Use current occupant** fills it in). Each port shows a live availability
  hint and **Suggest free port** finds a verified free one.

Project cards show live status (running, partially running, stopped, port
conflict), per-port health with latency and HTTP status, which address
answered, the occupying process, conflicts and 24-hour history. Portly also
lists **detected dev servers that aren't registered** so you can register
them in one click.

## Port Planner

- **Availability** — check one port, a list or ranges (`3000, 5173-5175`),
  get suggestions from a range, and see Windows excluded ranges (verified via
  `netsh`).
- **Personal reservations** — reserve ports or ranges *inside Portly*. They
  don't stop other programs from binding; Portly flags when one is used.
- **Ranges** — named custom ranges with suggestions.
- **Port plans** — personal allocation maps (website, API, dev server,
  database, proxy, testing, …) with templates, live collision validation and
  export to JSON, CSV or Markdown. **Project port map** combines a project's
  ports with its plans.

## Profiles

Group projects into profiles (web, backend, full-stack, game, testing,
personal, custom) with notes and startup metadata. **Activating** a profile
focuses the dashboard and health monitoring on its projects. Profiles never
start or run anything.

## Activity

Persistent history of port, server, conflict, configuration and termination
events with filters (type, severity, search, port, time range, project),
paging and clearing. By default port events are recorded for registered,
favorite, reserved and planned ports; enable *record all ports* in Settings
for everything.

## Settings

Theme and start page; refresh intervals (visible / hidden), UDP, health
check interval and timeout; Windows notifications; history retention and
privacy; Ivily Ecosystem integration; database status, backups, restore and
data folder; configuration import/export; updates; about.

## Conflict types

| Conflict | Meaning |
|---|---|
| Shared project port | Several projects expect the same port |
| Excluded by Windows | A project port lies in a Windows excluded range; binding will fail |
| Used by another program | The port's occupant doesn't match the expected process |
| Open but not answering HTTP | Something holds the port but the HTTP check fails |
| Stopped responding | A server that was up in this session is down |
| Unexpected address | e.g. server listens on `::1` only while configured for `127.0.0.1` |
| Owner changed | A registered port moved to another process |
| Plan collision | A plan assigns a port twice or inside a Windows exclusion |
| Reserved port in use | Something uses a port you reserved in Portly |
