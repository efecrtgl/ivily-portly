# Security Policy

## Supported versions

Only the latest released version of Ivily Portly receives security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through
[GitHub Security Advisories](https://github.com/efecrtgl/ivily-portly/security/advisories/new).
Include the version, Windows version, reproduction steps and the impact you
observed. You can expect an acknowledgement within a few days. Fixes are
released as a new version and credited in the changelog unless you prefer
otherwise.

## Security model

Portly is a local, single-user desktop utility. Its design goals:

| Principle | How it is enforced |
|---|---|
| **Least privilege** | Runs as a standard user. Socket tables and process facts are read with rights a standard user has (`GetExtendedTcpTable`, `PROCESS_QUERY_LIMITED_INFORMATION`). Portly never requests elevation, debug privileges or UAC prompts. |
| **No arbitrary execution** | Portly never runs project commands. The "start command" field is reference text only. The only processes Portly starts are fixed system tools with fixed arguments: `netsh interface ipvX show excludedportrange` (read-only) and `explorer.exe` to show a folder or select a file. |
| **Safe process actions** | Termination requires explicit confirmation in the UI *and* `confirmed: true` in the IPC call. The backend recomputes the safety assessment, refuses critical Windows processes (System, csrss, lsass, services, svchost, …), refuses Portly itself, and requires the process start time to match the confirmed instance so a reused PID can't be hit. High-risk targets require typing the process name. |
| **Validated IPC** | Every command validates its arguments in Rust (ports, protocols, lengths, control characters, loopback-only hosts, absolute existing paths, file extensions, size limits). The UI is never trusted. |
| **Restricted filesystem access** | The webview has no `fs`, `shell` or `http` plugin. File access happens only in Rust commands, on paths the user picked in a native dialog, with extension and size checks. "Open file location" takes a PID; the path is read from the process by the backend. |
| **Loopback-only health checks** | Server health checks may contact only `localhost`, `127.0.0.0/8` or `::1`. An HTTP check sends a single `GET` with a validated path (no header injection) and reads only the status line. |
| **No surveillance** | No packet capture, traffic inspection or remote scanning. Connection data comes from the OS socket tables only. |
| **Honest indicators** | "Review hints" are transparent, rule-based observations (e.g. a listener running from a temp folder). They are never presented as malware detection. |
| **Honest reservations** | Personal reservations are labeled Portly-only. Only Windows excluded port ranges (verified via `netsh`) are called reserved by the OS. |
| **Privacy by default** | Executable paths are not stored in history unless enabled. IEP summaries never include paths, command lines, directories or notes and can be switched off. |
| **Strict webview** | Content Security Policy without remote origins, `freezePrototype`, a single window with least-privilege capabilities. |
| **Signed updates** | Updates are verified against the minisign public key embedded in the app and installed only after the user confirms. |

## Dependency review

CI runs `npm audit --omit=dev --audit-level=high` and `cargo audit` on every
push and pull request. Dependabot proposes grouped updates weekly.
