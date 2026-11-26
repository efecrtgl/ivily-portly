// Pure filter / sort / group / search helpers for the Ports, Connections and
// Processes explorers. No React, no IPC — everything here is unit-tested.
import { CATEGORY_LABEL, CONN_CATEGORY_LABEL, SCOPE_LABEL } from './format.js';
import { conflictsFor, portKey } from './domain.js';

// ------------------------------------------------------------------ generic

const lc = (s) => String(s ?? '').toLowerCase();

/** True when every whitespace-separated term of `q` occurs in one of `fields`. */
export function matchesQuery(q, fields) {
  const terms = lc(q).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = fields
    .filter((f) => f != null && f !== '')
    .map(lc)
    .join('\u0001');
  return terms.every((t) => hay.includes(t));
}

function compare(x, y) {
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Stable sort by an accessor. Missing values (null/undefined/NaN) always sort
 * last, whatever the direction. With `groupOf`, rows are ordered by group label
 * first so Table's groupBy renders groups alphabetically.
 */
export function sortRows(rows, accessor, dir = 'asc', groupOf = null) {
  const sign = dir === 'desc' ? -1 : 1;
  const missing = (v) => v == null || (typeof v === 'number' && Number.isNaN(v));
  return rows
    .map((r, i) => ({ r, i, v: accessor ? accessor(r) : null, g: groupOf ? groupOf(r) : null }))
    .sort((a, b) => {
      if (groupOf) {
        const g = compare(a.g, b.g);
        if (g) return g;
      }
      if (accessor) {
        const ma = missing(a.v);
        const mb = missing(b.v);
        if (ma !== mb) return ma ? 1 : -1;
        if (!ma) {
          const c = compare(a.v, b.v) * sign;
          if (c) return c;
        }
      }
      return a.i - b.i;
    })
    .map((x) => x.r);
}

/** Map of key → count for `fn(row)`; rows where fn returns null are skipped. */
export function countBy(rows, fn) {
  const m = new Map();
  for (const r of rows) {
    const k = fn(r);
    if (k == null) continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}

/** Top `n` entries of a count map as [{ key, count }], ties broken by key. */
export function topN(counts, n = 5) {
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || compare(a.key, b.key))
    .slice(0, n);
}

const procName = (procByPid, pid) => procByPid?.get(pid)?.name || `PID ${pid}`;

// -------------------------------------------------------------------- ports

/** Index "tcp:3000" → [{ id, name }] of projects registering that port. */
export function projectPortIndex(projects) {
  const m = new Map();
  for (const p of projects || []) {
    for (const pp of p.ports || []) {
      const k = portKey(pp.protocol, pp.port);
      if (!m.has(k)) m.set(k, []);
      const list = m.get(k);
      if (!list.some((x) => x.id === p.id)) list.push({ id: p.id, name: p.name });
    }
  }
  return m;
}

/** Enriches PortUsage entries with owners, note, projects and conflicts. */
export function buildPortRows(ports, { procByPid, notes, projects, conflicts } = {}) {
  const noteIdx = new Map((notes || []).map((n) => [portKey(n.protocol, n.port), n]));
  const projIdx = projectPortIndex(projects);
  return (ports || []).map((u) => {
    const key = portKey(u.protocol, u.port);
    const owners = (u.pids || []).map((pid) => procByPid?.get(pid) || { pid, name: `PID ${pid}`, category: 'other' });
    const primary = owners[0] || null;
    return {
      key,
      usage: u,
      protocol: u.protocol,
      port: u.port,
      owners,
      ownerName: primary?.name || '',
      category: primary?.category || 'other',
      devServer: owners.some((o) => o.likelyDevServer),
      note: noteIdx.get(key) || null,
      projects: projIdx.get(key) || [],
      conflicts: conflictsFor(conflicts, { protocol: u.protocol, port: u.port }),
    };
  });
}

export const DEFAULT_PORT_FILTERS = {
  q: '',
  protocol: 'all',
  exposure: 'all',
  favorites: false,
  registered: false,
  hideDynamic: false,
  devOnly: false,
  sort: 'port',
  dir: 'asc',
  group: 'none',
};

/** Exposure filter values; "specific" also covers link-local bindings. */
export function exposureMatches(filter, exposure) {
  if (!filter || filter === 'all') return true;
  if (filter === 'specific') return exposure === 'specific' || exposure === 'link_local';
  return exposure === filter;
}

export function portSearchFields(row) {
  const u = row.usage;
  return [
    String(row.port),
    row.protocol,
    u.wellKnown,
    row.note?.label,
    row.note?.note,
    row.note?.category,
    ...row.owners.flatMap((o) => [o.name, String(o.pid), o.kind]),
    ...(u.bindings || []).map((b) => b.addr),
    ...row.projects.map((p) => p.name),
  ];
}

export function filterPorts(rows, f = DEFAULT_PORT_FILTERS) {
  return rows.filter((r) => {
    if (f.protocol && f.protocol !== 'all' && r.protocol !== f.protocol) return false;
    if (!exposureMatches(f.exposure, r.usage.exposure)) return false;
    if (f.favorites && !r.note?.favorite) return false;
    if (f.registered && !r.projects.length) return false;
    if (f.hideDynamic && (r.usage.dynamic || r.port >= 49152)) return false;
    if (f.devOnly && !r.devServer) return false;
    return matchesQuery(f.q, portSearchFields(r));
  });
}

const SCOPE_RANK = { loopback: 0, link_local: 1, specific: 2, all_interfaces: 3 };

export const PORT_SORTS = {
  port: { label: 'Port', get: (r) => r.port },
  process: { label: 'Process', get: (r) => lc(r.ownerName) || null },
  exposure: { label: 'Exposure', get: (r) => SCOPE_RANK[r.usage.exposure] ?? null },
  connections: { label: 'Connections', get: (r) => r.usage.connections ?? 0 },
};

export const PORT_GROUPS = {
  none: { label: 'No grouping', of: null },
  process: { label: 'Process', of: (r) => r.ownerName || 'Unknown process' },
  category: { label: 'Category', of: (r) => CATEGORY_LABEL[r.category] || 'Other' },
  exposure: { label: 'Exposure', of: (r) => SCOPE_LABEL[r.usage.exposure] || r.usage.exposure },
  protocol: { label: 'Protocol', of: (r) => r.protocol.toUpperCase() },
};

/** Filter + sort (+ group order) in one step. Port number breaks ties. */
export function explorePorts(rows, f = DEFAULT_PORT_FILTERS) {
  const filtered = filterPorts(rows, f);
  const byPort = sortRows(filtered, (r) => r.port * 2 + (r.protocol === 'udp' ? 1 : 0), 'asc');
  const s = PORT_SORTS[f.sort] || PORT_SORTS.port;
  const g = PORT_GROUPS[f.group]?.of || null;
  return sortRows(byPort, s.get, f.dir, g);
}

/** Header stats computed from PortUsage entries. */
export function portStats(ports) {
  let tcp = 0;
  let udp = 0;
  let exposed = 0;
  for (const u of ports || []) {
    if (u.protocol === 'tcp') tcp += 1;
    else if (u.protocol === 'udp') udp += 1;
    if (u.exposure === 'all_interfaces') exposed += 1;
  }
  return { tcp, udp, exposed };
}

export const FRESH_MS = 5000;

/**
 * Tracks ports that appeared since the previous snapshot.
 * `state` is `{ known: Set<string> | null, fresh: { [key]: ts } }`. The first
 * snapshot only seeds `known` (nothing is "new" on page load). Entries older
 * than `ttl` are dropped.
 */
export function trackAppeared(state, ports, now, ttl = FRESH_MS) {
  const keys = new Set((ports || []).map((u) => portKey(u.protocol, u.port)));
  const fresh = {};
  for (const [k, ts] of Object.entries(state?.fresh || {})) {
    if (now - ts < ttl && keys.has(k)) fresh[k] = ts;
  }
  if (state?.known) {
    for (const k of keys) if (!state.known.has(k)) fresh[k] = now;
  }
  return { known: keys, fresh };
}

/** Keys still within the highlight window. */
export function freshKeys(fresh, now, ttl = FRESH_MS) {
  return new Set(Object.entries(fresh || {}).filter(([, ts]) => now - ts < ttl).map(([k]) => k));
}

/** Milliseconds until the next fresh entry expires, or null when none. */
export function nextFreshExpiry(fresh, now, ttl = FRESH_MS) {
  const left = Object.values(fresh || {})
    .map((ts) => ts + ttl - now)
    .filter((ms) => ms > 0);
  return left.length ? Math.min(...left) : null;
}

/** Validates the quick "check port" input. */
export function parseCheckPort(input) {
  const s = String(input ?? '').trim();
  if (!s) return { port: null, error: null };
  if (!/^\d{1,5}$/.test(s)) return { port: null, error: 'Enter a number between 1 and 65535' };
  const n = Number(s);
  if (n < 1 || n > 65535) return { port: null, error: 'Enter a number between 1 and 65535' };
  return { port: n, error: null };
}

// -------------------------------------------------------------- connections

export const CONN_CATEGORIES = ['local', 'lan', 'internet', 'other'];

export function buildConnectionRows(connections, procByPid) {
  return (connections || []).map((c, i) => ({
    ...c,
    key: `${c.protocol}|${c.localAddr}|${c.localPort}|${c.remoteAddr ?? ''}|${c.remotePort ?? ''}|${c.pid}|${i}`,
    procName: procName(procByPid, c.pid),
  }));
}

/** Flattens PortUsage bindings into listener rows shaped like connections. */
export function buildListenerRows(ports, procByPid) {
  const out = [];
  for (const u of ports || []) {
    for (const b of u.bindings || []) {
      out.push({
        key: `${u.protocol}|${b.addr}|${u.port}|${b.pid}`,
        protocol: u.protocol,
        family: b.family,
        localAddr: b.addr,
        localPort: u.port,
        remoteAddr: null,
        remotePort: null,
        state: u.protocol === 'tcp' ? 'listen' : 'bound',
        pid: b.pid,
        scope: b.scope,
        category: 'listener',
        procName: procName(procByPid, b.pid),
      });
    }
  }
  return out;
}

export const DEFAULT_CONN_FILTERS = { tab: 'established', categories: [], state: 'all', protocol: 'all', q: '' };

export function connSearchFields(r) {
  return [r.localAddr, String(r.localPort), r.remoteAddr, r.remotePort != null ? String(r.remotePort) : null, r.procName, String(r.pid)];
}

/** Rows belonging to a tab before other filters. */
export function connTabRows(tab, connRows, listenerRows) {
  if (tab === 'listening') return listenerRows;
  if (tab === 'all') return connRows;
  return connRows.filter((r) => r.state === 'established');
}

/** Filters except category — used to compute category chip counts. */
export function filterConnectionsBase(rows, f) {
  return rows.filter(
    (r) =>
      (!f.state || f.state === 'all' || r.state === f.state) &&
      (!f.protocol || f.protocol === 'all' || r.protocol === f.protocol) &&
      matchesQuery(f.q, connSearchFields(r)),
  );
}

export function filterConnections(rows, f) {
  const cats = f.categories || [];
  return filterConnectionsBase(rows, f).filter((r) => !cats.length || cats.includes(r.category));
}

/** Summary used by the cards: per category, top remotes and top processes. */
export function connectionSummary(rows, n = 5) {
  const byCategory = Object.fromEntries(CONN_CATEGORIES.map((c) => [c, 0]));
  for (const r of rows) if (r.category in byCategory) byCategory[r.category] += 1;
  const remotes = topN(countBy(rows, (r) => (r.remoteAddr ? r.remoteAddr : null)), n);
  const procCounts = countBy(rows, (r) => r.pid);
  const procs = topN(procCounts, n).map(({ key, count }) => ({
    pid: key,
    name: rows.find((r) => r.pid === key)?.procName || `PID ${key}`,
    count,
  }));
  return { byCategory, remotes, procs };
}

export const connCategoryLabel = (c) => CONN_CATEGORY_LABEL[c] || c;

/** [{ proc, indicator }] for indicators of a given level. */
export function indicatorHits(processes, level, rule = null) {
  const out = [];
  for (const p of processes || []) {
    for (const i of p.indicators || []) {
      if (i.level === level && (!rule || i.rule === rule)) out.push({ proc: p, indicator: i });
    }
  }
  return out.sort((a, b) => compare(lc(a.proc.name), lc(b.proc.name)) || a.proc.pid - b.proc.pid);
}

export const reviewHints = (processes) => indicatorHits(processes, 'review');
export const exposedListeners = (processes) => indicatorHits(processes, 'info', 'reachable-from-network');

// ---------------------------------------------------------------- processes

export const DEFAULT_PROC_FILTERS = {
  q: '',
  categories: [],
  devOnly: false,
  listeningOnly: false,
  reviewOnly: false,
  sort: 'name',
  dir: 'asc',
  tree: false,
};

export const procPortCount = (p) => (p.listenPorts?.length || 0) + (p.udpPorts?.length || 0);
export const hasReview = (p) => (p.indicators || []).some((i) => i.level === 'review');

export function procSearchFields(p) {
  return [p.name, String(p.pid), p.path, p.kind, p.parentName, ...(p.listenPorts || []).map(String), ...(p.udpPorts || []).map(String)];
}

/** Filters except categories — used for category chip counts. */
export function filterProcessesBase(procs, f) {
  return (procs || []).filter(
    (p) =>
      (!f.devOnly || p.likelyDevServer) &&
      (!f.listeningOnly || procPortCount(p) > 0) &&
      (!f.reviewOnly || hasReview(p)) &&
      matchesQuery(f.q, procSearchFields(p)),
  );
}

export function filterProcesses(procs, f) {
  const cats = f.categories || [];
  return filterProcessesBase(procs, f).filter((p) => !cats.length || cats.includes(p.category));
}

/** Uptime in ms, or null when the start time is unknown. */
export const uptime = (p, now) => (p.startTime ? Math.max(0, now - p.startTime) : null);

export function procSorts(now) {
  return {
    name: { label: 'Name', get: (p) => lc(p.name) },
    pid: { label: 'PID', get: (p) => p.pid },
    cpu: { label: 'CPU', get: (p) => p.cpuPercent ?? null },
    memory: { label: 'Memory', get: (p) => p.memoryBytes ?? null },
    ports: { label: 'Ports', get: procPortCount },
    connections: { label: 'Connections', get: (p) => p.connections ?? 0 },
    uptime: { label: 'Uptime', get: (p) => uptime(p, now) },
  };
}

export function parentGroup(p) {
  if (p.parentName) return `${p.parentName} · PID ${p.parentPid}`;
  if (p.parentPid) return `PID ${p.parentPid}`;
  return 'No parent recorded';
}

export function exploreProcesses(procs, f, now) {
  const s = procSorts(now)[f.sort] || procSorts(now).name;
  return sortRows(filterProcesses(procs, f), s.get, f.dir, f.tree ? parentGroup : null);
}

export function processSummary(procs) {
  let dev = 0;
  let memory = 0;
  for (const p of procs || []) {
    if (p.likelyDevServer) dev += 1;
    memory += p.memoryBytes || 0;
  }
  return { count: (procs || []).length, dev, memory };
}

/** Category chip counts [{ value, label, count }] in CATEGORY_LABEL order, non-zero only. */
export function categoryCounts(procs) {
  const c = countBy(procs || [], (p) => p.category || 'other');
  return Object.keys(CATEGORY_LABEL)
    .filter((k) => c.get(k))
    .map((k) => ({ value: k, label: CATEGORY_LABEL[k], count: c.get(k) }));
}

/** Toggles membership of `value` in an array (returns a new array). */
export const toggleIn = (arr, value) => (arr.includes(value) ? arr.filter((x) => x !== value) : [...arr, value]);

/** Merges persisted filter state over defaults, ignoring unknown keys / wrong types. */
export function restoreFilters(raw, defaults) {
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    if (k in raw && typeof raw[k] === typeof defaults[k] && Array.isArray(raw[k]) === Array.isArray(defaults[k])) out[k] = raw[k];
  }
  return out;
}
