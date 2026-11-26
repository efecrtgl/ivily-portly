// Pure helpers for the Dashboard, Activity Center and Settings pages.
// No React, no IPC — everything here is unit tested in overview.test.js.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ------------------------------------------------------------- dashboard

/** Dashboard card ids in display order, with labels for the Customize dialog. */
export const DASHBOARD_CARDS = [
  { id: 'stats', label: 'Live statistics', desc: 'Listening ports, connections, dev servers and scan time.' },
  { id: 'conflicts', label: 'Conflict alerts', desc: 'Port conflicts with suggestions and verified free alternatives.' },
  { id: 'devServers', label: 'Running development servers', desc: 'Processes recognised as local dev servers.' },
  { id: 'health', label: 'Server health', desc: 'Status of the projects in the active profile.' },
  { id: 'favorites', label: 'Favorite ports', desc: 'Ports you starred and whether they are in use.' },
  { id: 'inspections', label: 'Recently inspected processes', desc: 'Processes you opened in the inspector.' },
  { id: 'recentProjects', label: 'Recently monitored projects', desc: 'Projects ordered by recent changes and activity.' },
  { id: 'utilization', label: 'Port utilization', desc: 'Listening ports by range and exposure; top processes.' },
  { id: 'activity', label: 'Monitoring activity', desc: 'Events in the last 24 hours and the monitoring interval.' },
];

/** Adds or removes `id` from the hidden list; returns a new, de-duplicated array. */
export function toggleHidden(hidden, id) {
  const set = new Set(hidden || []);
  if (set.has(id)) set.delete(id);
  else set.add(id);
  return [...set];
}

/** 'system' (1–1023), 'registered' (1024–49151) or 'dynamic' (49152–65535). */
export function portRange(port) {
  if (port < 1024) return 'system';
  if (port < 49152) return 'registered';
  return 'dynamic';
}

export const RANGE_LABEL = {
  system: 'System (1–1023)',
  registered: 'Registered (1024–49151)',
  dynamic: 'Dynamic (49152+)',
};

export const EXPOSURE_LABEL = {
  loopback: 'Localhost only',
  all_interfaces: 'All interfaces',
  specific: 'Specific interface',
};

/**
 * Distribution of snapshot ports (TCP listeners + bound UDP) by range and exposure.
 * Link-local bindings are counted as "specific".
 */
export function utilization(ports) {
  const byRange = { system: 0, registered: 0, dynamic: 0 };
  const byExposure = { loopback: 0, all_interfaces: 0, specific: 0 };
  const byProtocol = { tcp: 0, udp: 0 };
  for (const u of ports || []) {
    byRange[portRange(u.port)] += 1;
    const ex = u.exposure === 'loopback' || u.exposure === 'all_interfaces' ? u.exposure : 'specific';
    byExposure[ex] += 1;
    if (u.protocol in byProtocol) byProtocol[u.protocol] += 1;
  }
  return { total: (ports || []).length, byRange, byExposure, byProtocol };
}

/** Processes with the most listening TCP + bound UDP ports (ties broken by name). */
export function topProcesses(processes, n = 5) {
  return (processes || [])
    .map((p) => ({ pid: p.pid, name: p.name, count: (p.listenPorts?.length || 0) + (p.udpPorts?.length || 0) }))
    .filter((p) => p.count > 0)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name) || a.pid - b.pid)
    .slice(0, n);
}

const SEVERITY_RANK = { error: 0, critical: 0, warning: 1, info: 2 };

/** Conflicts sorted by severity (error first), then port, then title. Does not mutate. */
export function sortConflicts(conflicts) {
  return [...(conflicts || [])].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
      (a.port ?? 1e6) - (b.port ?? 1e6) ||
      String(a.title).localeCompare(String(b.title)),
  );
}

export const CONFLICT_TONE = { error: 'danger', warning: 'warn', info: 'info' };

/** Likely dev servers, sorted by their lowest listening port. */
export function devServers(processes) {
  const low = (p) => Math.min(...(p.listenPorts?.length ? p.listenPorts : [65536]));
  return (processes || []).filter((p) => p.likelyDevServer).sort((a, b) => low(a) - low(b) || a.pid - b.pid);
}

/** Milliseconds since process start, or null. `startTime` is epoch ms. */
export function uptime(startTime, now = Date.now()) {
  if (!startTime || startTime > now) return null;
  return now - startTime;
}

/** Counts project statuses: { running, partial, stopped, conflict, empty }. */
export function statusCounts(statuses) {
  const out = { running: 0, partial: 0, stopped: 0, conflict: 0, empty: 0 };
  for (const s of statuses || []) if (s.state in out) out[s.state] += 1;
  return out;
}

const STATE_RANK = { conflict: 0, partial: 1, running: 2, stopped: 3, empty: 4 };

/** Rows `{ project, status }` ordered so problems surface first, then by name. */
export function sortByAttention(rows) {
  return [...(rows || [])].sort(
    (a, b) => STATE_RANK[a.status.state] - STATE_RANK[b.status.state] || a.project.name.localeCompare(b.project.name),
  );
}

/**
 * Favorite ports with live status.
 * Returns [{ protocol, port, label, owners: [name], occupied }]
 */
export function favoritePorts(notes, ports, procByPid) {
  const idx = new Map((ports || []).map((u) => [`${u.protocol}:${u.port}`, u]));
  return (notes || [])
    .filter((n) => n.favorite)
    .map((n) => {
      const u = idx.get(`${n.protocol}:${n.port}`);
      const owners = u ? u.pids.map((pid) => procByPid?.get(pid)?.name || `PID ${pid}`) : [];
      return { protocol: n.protocol, port: n.port, label: n.label || '', owners, occupied: !!u };
    })
    .sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

/**
 * Projects ordered by most recent activity: the later of `updatedAt` and the
 * newest event timestamp for that project (from `lastEventByProject`).
 */
export function recentProjects(projects, lastEventByProject = {}, n = 6) {
  return (projects || [])
    .map((p) => ({ project: p, ts: Math.max(p.updatedAt || 0, lastEventByProject[p.id] || 0) }))
    .sort((a, b) => b.ts - a.ts || a.project.name.localeCompare(b.project.name))
    .slice(0, n);
}

/** { projectId: newestTs } from an event list. */
export function lastEventByProject(events) {
  const out = {};
  for (const e of events || []) {
    if (e.projectId == null) continue;
    if (!out[e.projectId] || e.ts > out[e.projectId]) out[e.projectId] = e.ts;
  }
  return out;
}

/** Sums the per-kind counts map. */
export function totalCount(counts) {
  return Object.values(counts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}

// -------------------------------------------------------------- activity

export const TIME_RANGES = [
  { value: '1h', label: '1h', ms: HOUR },
  { value: '24h', label: '24h', ms: DAY },
  { value: '7d', label: '7d', ms: 7 * DAY },
  { value: '30d', label: '30d', ms: 30 * DAY },
  { value: 'all', label: 'All', ms: null },
];

/** Epoch-ms lower bound for a time range value, or null for "all"/unknown. */
export function sinceFor(range, now = Date.now()) {
  const r = TIME_RANGES.find((x) => x.value === range);
  return r && r.ms != null ? now - r.ms : null;
}

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Label for a day relative to `now`, in local time. */
export function dayLabel(ts, now = Date.now()) {
  const d = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return 'Today';
  if (dayKey(d) === dayKey(yesterday)) return 'Yesterday';
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  if (d.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString(undefined, opts);
}

/**
 * Groups events (already sorted newest first) by local calendar day.
 * Returns [{ key: 'YYYY-MM-DD', label, events }], preserving input order.
 */
export function groupByDay(events, now = Date.now()) {
  const groups = [];
  let cur = null;
  for (const e of events || []) {
    const key = dayKey(new Date(e.ts));
    if (!cur || cur.key !== key) {
      cur = { key, label: dayLabel(e.ts, now), events: [] };
      groups.push(cur);
    }
    cur.events.push(e);
  }
  return groups;
}

export const EVENT_SEVERITY_TONE = { info: 'info', warning: 'warn', critical: 'danger' };

/**
 * Builds a backend EventFilter from UI state, omitting empty values.
 * state: { kinds: [], severity: '', search: '', port: '', range: '24h', projectId: '' }
 */
export function buildEventFilter(state, now = Date.now()) {
  const f = {};
  if (state.kinds?.length) f.kinds = [...state.kinds];
  if (state.severity) f.severity = state.severity;
  const q = String(state.search || '').trim();
  if (q) f.search = q;
  const port = Number(state.port);
  if (String(state.port || '').trim() && Number.isInteger(port) && port >= 1 && port <= 65535) f.port = port;
  const since = sinceFor(state.range, now);
  if (since != null) f.since = since;
  if (state.projectId !== '' && state.projectId != null) {
    const id = Number(state.projectId);
    if (Number.isFinite(id)) f.projectId = id;
  }
  return f;
}

/** True when the filter narrows anything (used to label "Clear filtered"). */
export function isFiltered(filter) {
  return ['kinds', 'severity', 'search', 'port', 'projectId', 'since'].some((k) => filter[k] != null);
}

/**
 * Whether a newly recorded event would appear under `filter`. Mirrors the
 * backend where clause closely enough to decide on a live refresh; search is
 * matched case-insensitively against message, process and port.
 */
export function eventMatchesFilter(event, filter) {
  if (!event) return false;
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false;
  if (filter.severity && event.severity !== filter.severity) return false;
  if (filter.port != null && event.port !== filter.port) return false;
  if (filter.projectId != null && event.projectId !== filter.projectId) return false;
  if (filter.since != null && event.ts != null && event.ts < filter.since) return false;
  if (filter.search) {
    const q = filter.search.toLowerCase();
    const hit =
      String(event.message || '').toLowerCase().includes(q) ||
      String(event.process || '').toLowerCase().includes(q) ||
      String(event.port ?? '') === filter.search;
    if (!hit) return false;
  }
  return true;
}

/** Validates the free-text port filter: '' is fine, otherwise 1–65535. */
export function portFilterError(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (!/^\d{1,5}$/.test(s)) return 'Enter a port number';
  const n = Number(s);
  return n >= 1 && n <= 65535 ? null : 'Port must be 1–65535';
}

// -------------------------------------------------------------- settings

export const INTERVAL_PRESETS = [
  { value: 500, label: '0.5s' },
  { value: 1000, label: '1s' },
  { value: 2000, label: '2s' },
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '60s' },
];

export const BACKGROUND_PRESETS = [
  { value: 5000, label: '5s' },
  { value: 10000, label: '10s' },
  { value: 30000, label: '30s' },
  { value: 60000, label: '1m' },
  { value: 300000, label: '5m' },
];

/** Limits mirrored from src-tauri/src/settings.rs `sanitized()`. */
export const LIMITS = {
  intervalMs: { min: 500, max: 60_000 },
  backgroundIntervalMs: { min: 500, max: 300_000 },
  healthIntervalS: { min: 2, max: 3600 },
  healthTimeoutMs: { min: 200, max: 10_000 },
  retentionDays: { min: 1, max: 365 },
  maxEvents: { min: 500, max: 200_000 },
};

/** Parses an integer within [min, max]. Returns { value, error }. */
export function validateInt(raw, { min, max }) {
  const s = String(raw ?? '').trim();
  if (!/^-?\d+$/.test(s)) return { value: null, error: 'Enter a whole number' };
  const n = Number(s);
  if (n < min || n > max) return { value: null, error: `Must be between ${min.toLocaleString('en-US')} and ${max.toLocaleString('en-US')}` };
  return { value: n, error: null };
}

/** "500 ms", "2 s", "1.5 s", "5 min". */
export function formatInterval(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000 || ms % 60_000) return `${Number((ms / 1000).toFixed(1))} s`;
  return `${ms / 60_000} min`;
}

export const START_PAGES = [
  { value: 'dashboard', label: 'Dashboard' },
  { value: 'ports', label: 'Ports' },
  { value: 'connections', label: 'Connections' },
  { value: 'processes', label: 'Processes' },
  { value: 'projects', label: 'Projects' },
  { value: 'planner', label: 'Port Planner' },
  { value: 'profiles', label: 'Profiles' },
  { value: 'activity', label: 'Activity' },
  { value: 'settings', label: 'Settings' },
];

const IMPORT_KIND_LABEL = {
  projects: 'Projects',
  groups: 'Groups',
  profiles: 'Profiles',
  notes: 'Port notes',
  portNotes: 'Port notes',
  reservations: 'Personal reservations',
  ranges: 'Port ranges',
  plans: 'Plans',
  settings: 'Settings',
};

/** Rows for an ImportReport: [{ kind, label, count }] sorted by label. */
export function importRows(report) {
  return Object.entries(report?.imported || {})
    .map(([kind, count]) => ({ kind, label: IMPORT_KIND_LABEL[kind] || kind, count }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** A clear, user-facing message for an updater failure. */
export function updateErrorMessage(err) {
  const raw = String(err?.message ?? err ?? '').trim();
  const low = raw.toLowerCase();
  if (/404|not found|valid release json|no releases|latest\.json/.test(low)) {
    return 'No published release was found yet. Try again later.';
  }
  if (/network|dns|connect|offline|timed out|timeout|resolve|unreachable|error sending request/.test(low)) {
    return 'Could not reach the update server. Check your internet connection and try again.';
  }
  if (/signature/.test(low)) return 'The downloaded update could not be verified and was not installed.';
  return raw || 'The update check failed for an unknown reason.';
}
