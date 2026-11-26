// Pure helpers for the Projects, Port Planner and Profiles pages.
// No React, no IPC — everything here is unit-tested in organize.test.js.

const HOUR = 3_600_000;

// ------------------------------------------------------------------ health

/** Health sample statuses that count as "the server answered". */
const UP_STATES = new Set(['up', 'degraded']);
/** Severity order used when several samples fall into one strip segment. */
const RANK = { none: 0, unchecked: 1, up: 2, degraded: 3, down: 4 };

/**
 * Uptime over a set of health samples ({ ts, status }).
 * Unchecked samples are ignored. Returns { pct, up, down, checked, total } —
 * pct is null when nothing was checked.
 */
export function uptimeStats(samples) {
  const list = samples || [];
  let up = 0;
  let down = 0;
  for (const s of list) {
    if (UP_STATES.has(s.status)) up += 1;
    else if (s.status === 'down') down += 1;
  }
  const checked = up + down;
  return { pct: checked ? (up / checked) * 100 : null, up, down, checked, total: list.length };
}

/**
 * Splits [now - hours, now] into `buckets` equal segments and assigns each the
 * worst status seen in it ('none' when there is no sample).
 * Returns [{ start, end, status, count }].
 */
export function healthSegments(samples, { now = Date.now(), hours = 24, buckets = 48 } = {}) {
  const from = now - hours * HOUR;
  const width = (now - from) / buckets;
  const segs = Array.from({ length: buckets }, (_, i) => ({
    start: Math.round(from + i * width),
    end: Math.round(from + (i + 1) * width),
    status: 'none',
    count: 0,
  }));
  for (const s of samples || []) {
    if (s.ts < from || s.ts > now) continue;
    const i = Math.min(buckets - 1, Math.floor((s.ts - from) / width));
    const seg = segs[i];
    seg.count += 1;
    const st = RANK[s.status] != null ? s.status : 'unchecked';
    if (RANK[st] > RANK[seg.status]) seg.status = st;
  }
  return segs;
}

/** Display state of one project port's latest health check. */
export function portHealthView(pp, healthState, listening) {
  const last = healthState?.last || null;
  if (pp.checkKind === 'none') {
    return { status: listening ? 'listening' : 'idle', last: null };
  }
  return { status: last?.status || 'unchecked', last };
}

// ------------------------------------------------------------- projects

/** Rows: [{ project, status }] where status is domain.projectStatus(). */
export function filterProjects(rows, { search = '', groupId = '', status = '', favoritesOnly = false } = {}) {
  const q = search.trim().toLowerCase();
  return rows.filter(({ project: p, status: st }) => {
    if (favoritesOnly && !p.favorite) return false;
    if (groupId === 'none' && p.groupId != null) return false;
    if (groupId && groupId !== 'none' && String(p.groupId) !== String(groupId)) return false;
    if (status && st?.state !== status) return false;
    if (!q) return true;
    const hay = [
      p.name,
      p.description,
      p.directory,
      p.groupName,
      ...(p.ports || []).flatMap((pp) => [String(pp.port), pp.role, pp.expectedProcess]),
      ...Object.entries(p.metadata || {}).flat(),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

const STATE_ORDER = { conflict: 0, partial: 1, running: 2, stopped: 3, empty: 4 };

/** Sorts rows by 'name' | 'status' | 'updated'. Favorites are not pinned. */
export function sortProjects(rows, by = 'name') {
  const byName = (a, b) => a.project.name.localeCompare(b.project.name, undefined, { sensitivity: 'base', numeric: true });
  const cmp = {
    name: byName,
    status: (a, b) => (STATE_ORDER[a.status?.state] ?? 9) - (STATE_ORDER[b.status?.state] ?? 9) || byName(a, b),
    updated: (a, b) => (b.project.updatedAt || 0) - (a.project.updatedAt || 0) || byName(a, b),
  }[by] || byName;
  return [...rows].sort(cmp);
}

/** Groups rows by group name, groups sorted alphabetically, "Ungrouped" last. */
export function groupProjects(rows) {
  const m = new Map();
  for (const r of rows) {
    const g = r.project.groupName || '';
    if (!m.has(g)) m.set(g, []);
    m.get(g).push(r);
  }
  return [...m.entries()]
    .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { sensitivity: 'base' })))
    .map(([name, items]) => ({ name: name || 'Ungrouped', items }));
}

/** Set of "protocol:port" registered by any project. */
export function registeredPorts(projects) {
  const s = new Set();
  for (const p of projects || []) for (const pp of p.ports || []) s.add(`${pp.protocol}:${pp.port}`);
  return s;
}

/**
 * Likely dev servers in the snapshot that listen on TCP ports no project registers.
 * Returns [{ proc, ports }] where ports are the unregistered listen ports.
 */
export function unregisteredDevServers(processes, projects) {
  const reg = registeredPorts(projects);
  return (processes || [])
    .filter((p) => p.likelyDevServer && p.listenPorts?.length)
    .map((proc) => ({ proc, ports: proc.listenPorts.filter((port) => !reg.has(`tcp:${port}`)) }))
    .filter((x) => x.ports.length)
    .sort((a, b) => a.ports[0] - b.ports[0]);
}

let keySeq = 0;
/** Stable client-side key for editor rows. */
export const rowKey = () => `r${(keySeq += 1)}`;

export function emptyPortRow(patch = {}) {
  return { key: rowKey(), port: '', protocol: 'tcp', role: '', host: 'localhost', checkKind: 'tcp', httpPath: '/', expectedProcess: '', ...patch };
}

/** Object → [{ key, k, v }] for the key/value editor. */
export function kvRows(obj) {
  return Object.entries(obj && typeof obj === 'object' ? obj : {}).map(([k, v]) => ({ key: rowKey(), k, v: String(v ?? '') }));
}

/** [{ k, v }] → { object, error }. Blank rows are dropped; duplicate keys are an error. */
export function kvObject(rows) {
  const object = {};
  for (const r of rows || []) {
    const k = String(r.k || '').trim();
    const v = String(r.v ?? '').trim();
    if (!k && !v) continue;
    if (!k) return { object: null, error: `A value ("${v}") has no key` };
    if (k in object) return { object: null, error: `Key "${k}" is listed twice` };
    object[k] = v;
  }
  return { object, error: null };
}

/** Project (or null) → editor draft. */
export function projectDraft(project) {
  if (!project) {
    return { name: '', description: '', directory: '', groupId: '', favorite: false, metadata: [], startCommand: '', ports: [emptyPortRow()] };
  }
  return {
    name: project.name || '',
    description: project.description || '',
    directory: project.directory || '',
    groupId: project.groupId != null ? String(project.groupId) : '',
    favorite: !!project.favorite,
    metadata: kvRows(project.metadata),
    startCommand: project.startCommand || '',
    ports: (project.ports || []).map((pp) =>
      emptyPortRow({
        port: String(pp.port),
        protocol: pp.protocol,
        role: pp.role || '',
        host: pp.host || 'localhost',
        checkKind: pp.checkKind || 'none',
        httpPath: pp.httpPath || '/',
        expectedProcess: pp.expectedProcess || '',
      }),
    ),
  };
}

/** Draft pre-filled from a detected (unregistered) dev server process. */
export function draftFromProcess(proc, ports) {
  const base = String(proc.name || '').replace(/\.exe$/i, '');
  const name = proc.kind ? `${proc.kind} (${ports.join(', ')})` : `${base || 'Server'} :${ports[0]}`;
  return {
    ...projectDraft(null),
    name,
    ports: ports.map((port) => emptyPortRow({ port: String(port), role: proc.kind || '', expectedProcess: proc.name || '' })),
  };
}

/** Client-side checks for port rows. Returns one error string (or null) per row. */
export function validatePortRows(rows) {
  const seen = new Map();
  return (rows || []).map((r, i) => {
    const s = String(r.port ?? '').trim();
    if (!/^\d+$/.test(s)) return 'Port must be a number';
    const n = Number(s);
    if (n < 1 || n > 65535) return 'Port must be 1–65535';
    const key = `${r.protocol}:${n}`;
    if (seen.has(key)) return `Duplicate of row ${seen.get(key) + 1}`;
    seen.set(key, i);
    if (r.protocol === 'udp' && r.checkKind !== 'none') return 'UDP ports cannot be health-checked';
    if (r.checkKind === 'http' && !String(r.httpPath || '').startsWith('/')) return 'HTTP path must start with /';
    return null;
  });
}

/** Draft → ProjectInput for api.projectSave, or { error }. */
export function projectInput(draft) {
  if (!draft.name.trim()) return { error: 'Project name is required' };
  const portErrors = validatePortRows(draft.ports);
  const firstErr = portErrors.findIndex(Boolean);
  if (firstErr >= 0) return { error: `Port row ${firstErr + 1}: ${portErrors[firstErr]}` };
  const meta = kvObject(draft.metadata);
  if (meta.error) return { error: `Metadata: ${meta.error}` };
  return {
    input: {
      name: draft.name.trim(),
      description: draft.description.trim(),
      directory: draft.directory.trim() || null,
      groupId: draft.groupId ? Number(draft.groupId) : null,
      favorite: !!draft.favorite,
      metadata: meta.object,
      startCommand: draft.startCommand.trim() || null,
      ports: draft.ports.map((r) => ({
        port: Number(r.port),
        protocol: r.protocol,
        role: r.role.trim(),
        host: r.host,
        checkKind: r.protocol === 'udp' ? 'none' : r.checkKind,
        httpPath: r.checkKind === 'http' ? r.httpPath.trim() || '/' : '/',
        expectedProcess: r.expectedProcess.trim() || null,
      })),
    },
  };
}

// ---------------------------------------------------------------- plans

export const ENTRY_KINDS = ['website', 'api', 'dev', 'database', 'proxy', 'testing', 'cache', 'queue', 'custom'];
export const ENTRY_KIND_LABEL = {
  website: 'Website',
  api: 'API',
  dev: 'Dev server',
  database: 'Database',
  proxy: 'Proxy',
  testing: 'Testing',
  cache: 'Cache',
  queue: 'Queue',
  custom: 'Custom',
};

export const PLAN_TEMPLATES = [
  { id: 'website', service: 'Main website', kind: 'website', port: 3000 },
  { id: 'api', service: 'API backend', kind: 'api', port: 8000 },
  { id: 'dev', service: 'Dev server', kind: 'dev', port: 5173 },
  { id: 'database', service: 'Database', kind: 'database', port: 5432 },
  { id: 'proxy', service: 'Proxy', kind: 'proxy', port: 8080 },
  { id: 'testing', service: 'Testing', kind: 'testing', port: 4000 },
];

export function emptyEntry(patch = {}) {
  return { key: rowKey(), service: '', kind: 'custom', port: '', protocol: 'tcp', host: 'localhost', note: '', ...patch };
}

export function addEntry(entries, entry = emptyEntry()) {
  return [...entries, entry.key ? entry : { ...entry, key: rowKey() }];
}

export function removeEntry(entries, index) {
  return entries.filter((_, i) => i !== index);
}

export function updateEntry(entries, index, patch) {
  return entries.map((e, i) => (i === index ? { ...e, ...patch } : e));
}

/** Moves entry `index` by `delta` (-1 up, +1 down); no-op at the edges. */
export function moveEntry(entries, index, delta) {
  const to = index + delta;
  if (index < 0 || index >= entries.length || to < 0 || to >= entries.length) return entries;
  const next = [...entries];
  const [e] = next.splice(index, 1);
  next.splice(to, 0, e);
  return next;
}

/** Ports already used by plan entries (protocol-aware), as "tcp:3000" strings. */
export function entryPorts(entries, protocol = 'tcp') {
  return new Set(
    (entries || []).filter((e) => (e.protocol || 'tcp') === protocol && /^\d+$/.test(String(e.port))).map((e) => Number(e.port)),
  );
}

/** First candidate not in `used` (Set of numbers), or null. */
export function pickFreePort(candidates, used) {
  return (candidates || []).find((p) => !used.has(p)) ?? null;
}

/** Search window for template suggestions: [default+1, default+999] clamped. */
export function suggestWindow(port) {
  const start = Math.min(65535, port + 1);
  return { start, end: Math.min(65535, start + 998) };
}

/** Plan → editor draft. */
export function planDraft(plan) {
  if (!plan) return { name: '', description: '', projectId: '', profileId: '', entries: [] };
  return {
    name: plan.name || '',
    description: plan.description || '',
    projectId: plan.projectId != null ? String(plan.projectId) : '',
    profileId: plan.profileId != null ? String(plan.profileId) : '',
    entries: (plan.entries || []).map((e) => emptyEntry({ ...e, port: String(e.port), key: rowKey() })),
  };
}

/** Entries as sent to the backend (validation/save). Non-numeric ports become 0 (backend flags them). */
export function entriesPayload(entries) {
  return (entries || []).map((e) => ({
    service: String(e.service || '').trim(),
    kind: e.kind || 'custom',
    port: /^\d+$/.test(String(e.port).trim()) ? Number(e.port) : 0,
    protocol: e.protocol || 'tcp',
    host: e.host || 'localhost',
    note: String(e.note || '').trim(),
  }));
}

export function planInput(draft) {
  if (!draft.name.trim()) return { error: 'Plan name is required' };
  const blank = draft.entries.findIndex((e) => !String(e.service || '').trim());
  if (blank >= 0) return { error: `Entry ${blank + 1}: service name is required` };
  return {
    input: {
      name: draft.name.trim(),
      description: draft.description.trim(),
      projectId: draft.projectId ? Number(draft.projectId) : null,
      profileId: draft.profileId ? Number(draft.profileId) : null,
      entries: entriesPayload(draft.entries),
    },
  };
}

/** Groups plan issues by entry index: { [index]: issue[] }. */
export function issuesByIndex(issues) {
  const m = {};
  for (const i of issues || []) (m[i.index] ||= []).push(i);
  return m;
}

/**
 * Combined port map for one project: its registered ports and every entry of
 * plans linked to it. Rows: { source: 'project'|'plan', label, service, port, protocol, host, planName? }
 */
export function projectPortMap(project, plans) {
  if (!project) return [];
  const rows = (project.ports || []).map((pp) => ({
    key: `pp:${pp.id}`,
    source: 'project',
    service: pp.role || 'Port',
    kind: null,
    port: pp.port,
    protocol: pp.protocol,
    host: pp.host,
    planName: null,
  }));
  for (const plan of plans || []) {
    if (plan.projectId !== project.id) continue;
    plan.entries.forEach((e, i) =>
      rows.push({
        key: `plan:${plan.id}:${i}`,
        source: 'plan',
        service: e.service,
        kind: e.kind,
        port: e.port,
        protocol: e.protocol,
        host: e.host,
        planName: plan.name,
      }),
    );
  }
  return rows.sort((a, b) => a.port - b.port || (a.source === 'project' ? -1 : 1));
}

// --------------------------------------------------- reservations/ranges

/** Live listeners inside a reservation range: { ports: PortUsage[], count, size }. */
export function rangeOccupancy(range, snapshot) {
  const protocol = range.protocol || null;
  const ports = (snapshot?.ports || []).filter(
    (u) => (!protocol || u.protocol === protocol) && u.port >= range.portStart && u.port <= range.portEnd,
  );
  return { ports: [...ports].sort((a, b) => a.port - b.port), count: ports.length, size: range.portEnd - range.portStart + 1 };
}

/** Client-side check of a start/end pair. Returns an error string or null. */
export function validateRange(start, end) {
  const s = Number(start);
  const e = Number(end);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return 'Start and end must be numbers';
  if (s < 1 || e > 65535) return 'Ports must be within 1–65535';
  if (s > e) return 'Start must not be greater than end';
  return null;
}

/** Position of a port range on a 1–65535 band, as CSS percentages. */
export function bandPosition(start, end) {
  const left = ((start - 1) / 65535) * 100;
  const width = Math.max(0.25, ((end - start + 1) / 65535) * 100);
  return { left: `${left.toFixed(3)}%`, width: `${Math.min(width, 100 - left).toFixed(3)}%` };
}

// -------------------------------------------------------------- profiles

export const PROFILE_KIND_LABEL = {
  web: 'Web development',
  backend: 'Backend development',
  fullstack: 'Full-stack development',
  game: 'Game development',
  testing: 'Testing',
  personal: 'Personal projects',
  custom: 'Custom',
};

export const PROFILE_KIND_ICON = {
  web: 'globe',
  backend: 'server',
  fullstack: 'layers',
  game: 'zap',
  testing: 'checkCircle',
  personal: 'star',
  custom: 'tag',
};

export const PROFILE_TEMPLATES = [
  { kind: 'web', name: 'Web development', description: 'Front-end dev servers and static sites.', startup: { stack: 'Vite / Next.js' } },
  { kind: 'backend', name: 'Backend development', description: 'APIs, databases and queues.', startup: { services: 'API, database' } },
  { kind: 'fullstack', name: 'Full-stack development', description: 'Front end, API and database together.', startup: {} },
  { kind: 'game', name: 'Game development', description: 'Game servers and local tooling.', startup: {} },
  { kind: 'testing', name: 'Testing', description: 'Test runners, mock servers and fixtures.', startup: {} },
  { kind: 'personal', name: 'Personal projects', description: 'Side projects and experiments.', startup: {} },
  { kind: 'custom', name: 'Custom', description: '', startup: {} },
];

export function profileDraft(profile, template) {
  const src = profile || template || PROFILE_TEMPLATES[PROFILE_TEMPLATES.length - 1];
  return {
    name: profile ? profile.name : !template || template.kind === 'custom' ? '' : template.name || '',
    kind: src.kind || 'custom',
    description: src.description || '',
    notes: profile?.notes || '',
    monitorHealth: profile ? !!profile.monitorHealth : true,
    projectIds: profile ? [...profile.projectIds] : [],
    startup: kvRows(src.startup),
  };
}

export function profileInput(draft) {
  if (!draft.name.trim()) return { error: 'Profile name is required' };
  const st = kvObject(draft.startup);
  if (st.error) return { error: `Startup notes: ${st.error}` };
  return {
    input: {
      name: draft.name.trim(),
      kind: draft.kind,
      description: draft.description.trim(),
      notes: draft.notes.trim(),
      startup: st.object,
      monitorHealth: !!draft.monitorHealth,
      projectIds: draft.projectIds,
    },
  };
}

/** Counts project states: { running, partial, stopped, conflict, empty, total }. */
export function aggregateStatus(states) {
  const out = { running: 0, partial: 0, stopped: 0, conflict: 0, empty: 0, total: 0 };
  for (const s of states || []) {
    if (s in out) out[s] += 1;
    out.total += 1;
  }
  return out;
}

/** Overall tone for a profile from aggregated counts. */
export function aggregateTone(agg) {
  if (agg.conflict) return 'danger';
  if (agg.partial || (agg.running && agg.stopped)) return 'warn';
  if (agg.running && agg.running === agg.total - agg.empty) return 'ok';
  return '';
}

export function toggleId(ids, id) {
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}
