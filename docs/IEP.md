# Ivily Ecosystem Protocol (IEP) — Portly provider

IEP lets Ivily Center (and other Ivily tools) discover Portly and read
summaries **locally**. Portly is fully functional without Center; IEP is an
optional, read-only surface. Implementation: `src-tauri/src/iep.rs`.

## Principles

1. **Independence** — no Portly feature depends on Center.
2. **Local only** — no network listener, no port, no background service.
3. **Read-only** — every IEP 0.1 method is a query. Nothing can be changed,
   started or terminated through IEP.
4. **Data minimization** — summaries never include executable paths, command
   lines, project directories, start commands, notes or descriptions.
5. **User control** — Settings → Ecosystem can disable summaries; identity,
   capabilities and health remain available so Center can explain why.
6. **Versioned** — semantic versioning with explicit incompatibility errors.

## Transport (0.1): command line

| Invocation | Behavior |
|---|---|
| `ivily-portly.exe --iep describe` | Writes one JSON descriptor line to stdout, exit code `0`. |
| `ivily-portly.exe --iep request` | Reads one JSON request (≤ 64 KB) from stdin, writes one JSON response line. Exit `0` on success, `1` on protocol error. |
| any other `--iep …` | Usage error JSON, exit code `2`. |

These invocations don't open a window, don't take the single-instance lock
and are safe while Portly is running. The database is opened **read-only**
(`query_only`); it is never created or migrated by IEP. Release builds use
the Windows GUI subsystem, so callers must read stdout through a pipe
(e.g. Rust `Command::output()`, .NET `RedirectStandardOutput`, PowerShell
`& exe --iep describe | Out-String`).

Default install location (per-user NSIS): `%LOCALAPPDATA%\Ivily Portly\ivily-portly.exe`.

## Descriptor (`describe`)

```json
{
  "protocol": { "name": "iep", "version": "0.1.0", "minCompatible": "0.1.0" },
  "app": { "id": "com.efecrtgl.ivilyportly", "product": "ivily-portly", "name": "Ivily Portly",
           "version": "0.1.0", "platform": "windows", "repository": "https://github.com/efecrtgl/ivily-portly" },
  "transport": { "kind": "cli", "describe": ["--iep", "describe"], "request": ["--iep", "request"], "backgroundService": false },
  "capabilities": [ { "id": "ports.summary", "version": "1", "access": "read", "status": "available", "description": "…" } ],
  "integration": { "enabled": true },
  "health": { "status": "ok", "dataDirExists": true, "database": "ok", "schemaVersion": 1, "expectedSchemaVersion": 1 },
  "update": { "currentVersion": "0.1.0", "latestVersion": "0.1.0", "updateAvailable": false, "checkedAt": 1795700000000 },
  "ports": { "available": true, "tcpListening": 67, "udpBound": 45, "established": 49, "devServers": 1,
             "exposedListeners": 36, "registeredPorts": [ { "port": 3000, "protocol": "tcp", "role": "web", "occupied": true } ] },
  "activity": { "windowDays": 7, "total": 12, "byKind": { "port_opened": 6, "port_closed": 5, "conflict": 1 } },
  "generatedAt": 1795721642
}
```

When the user disabled summaries, `update`, `ports` and `activity` are
`null` and gated capabilities report `"status": "disabled"`.

| Field | Meaning |
|---|---|
| `health.database` | `missing` (Portly never opened), `ok`, `needs-migration` (will upgrade on next launch), `newer-schema` (created by a newer Portly), `unreadable` |
| `health.status` | `ok` or `degraded` (`newer-schema` / `unreadable`) |
| `update` | Result of the last in-app update check; `describe` makes **no network request**. |
| `ports` | A one-shot socket table read at call time. |

## Capabilities

| Id | Access | Status | Description |
|---|---|---|---|
| `app.identity` | read | available | Identity, version, protocol version |
| `app.capabilities` | read | available | Capability list |
| `app.health` | read | available | Data folder and database state |
| `integration.status` | read | available | Whether summaries are enabled |
| `update.metadata` | read | available\* | Last update check |
| `ports.summary` | read | available\* | Listener counts and registered-port occupancy |
| `projects.summary` | read | available\* | Project names with configured ports and occupancy |
| `activity.summary` | read | available\* | Event counts by kind (7 days) |
| `operation.request` | user-approved | planned | Center proposes an action; Portly shows it and acts only with user approval |

\* `disabled` when the user turned summaries off. Clients must rely only on
`available` capabilities.

## Requests and responses

Request (one JSON object; unknown fields are rejected):

```json
{ "protocol": "iep", "version": "0.1.0", "id": "center-42", "method": "projects.summary", "params": {} }
```

| Field | Rule |
|---|---|
| `protocol` | exactly `"iep"` |
| `version` | client protocol version (semver), must be compatible |
| `id` | 1–64 chars: letters, digits, `-`, `_`, `.` |
| `method` | `describe`, `health`, `capabilities`, `ports.summary`, `projects.summary` |
| `params` | absent, `null` or `{}` |

Success: `{ "protocol": "iep", "version": "0.1.0", "id": "center-42", "ok": true, "result": { … } }`

Error: `{ "protocol": "iep", "version": "0.1.0", "id": null, "ok": false, "error": { "code": "unknown_method", "message": "…" } }`

| Error code | Meaning |
|---|---|
| `too_large` | request over 64 KB |
| `invalid_request` | invalid JSON, missing or unknown field |
| `unsupported_protocol` | `protocol` is not `"iep"` |
| `invalid_id` | malformed id |
| `incompatible_version` | version not compatible |
| `unknown_method` | method not in the allow-list |
| `invalid_params` | parameters supplied |
| `disabled` | the user disabled IEP summaries |
| `usage` | invalid command-line usage |

`projects.summary` result:

```json
{ "projects": [ { "name": "Shop", "ports": [ { "port": 3000, "protocol": "tcp", "role": "web", "occupied": true } ] } ] }
```

## Compatibility

- Same major version required. While the protocol is `0.x`, the **minor**
  version must match as well (a 0.1 client cannot talk to a 0.2 server).
- Patch versions (`0.1.x`) only contain backward-compatible fixes.
- New descriptor fields may appear at any time; clients must ignore unknown
  fields. Requests with unknown fields are rejected.
- `minCompatible` states the oldest client version the server accepts.
- Portly's IEP surface is identical in shape to Ivily Optimizer's IEP 0.1
  (same envelope, error codes and transport), extended with Portly-specific
  capabilities.

## Security model

- The CLI transport assumes the caller runs as the same Windows user; anyone
  able to start the executable already has that user's rights. Therefore only
  read methods over the user's own data are offered.
- No elevation, no network, no persistent process.
- Input limits, strict schema and method allow-list are covered by unit
  tests (`iep::tests`), including a test that IEP never modifies the database.

## Future transport (design only)

A same-user named pipe (`\\.\pipe\ivily-iep-<user SID>`, `PIPE_REJECT_REMOTE_CLIENTS`,
ACL restricted to the current user) may be added for live status **only while
Portly is open**, using the same envelope. Any `operation.request` would be a
proposal shown in Portly's UI and executed only after explicit user approval.
