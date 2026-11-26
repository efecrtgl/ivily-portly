import { describe, expect, it } from 'vitest';
import {
  addEntry,
  aggregateStatus,
  aggregateTone,
  bandPosition,
  draftFromProcess,
  emptyEntry,
  emptyPortRow,
  entriesPayload,
  entryPorts,
  filterProjects,
  groupProjects,
  healthSegments,
  issuesByIndex,
  kvObject,
  kvRows,
  moveEntry,
  pickFreePort,
  planDraft,
  planInput,
  portHealthView,
  profileDraft,
  profileInput,
  projectDraft,
  projectInput,
  projectPortMap,
  rangeOccupancy,
  registeredPorts,
  removeEntry,
  sortProjects,
  suggestWindow,
  toggleId,
  unregisteredDevServers,
  updateEntry,
  uptimeStats,
  validatePortRows,
  validateRange,
  PROFILE_TEMPLATES,
} from './organize.js';

const HOUR = 3_600_000;

describe('uptimeStats', () => {
  it('returns null pct with no checked samples', () => {
    expect(uptimeStats([]).pct).toBeNull();
    expect(uptimeStats(null).pct).toBeNull();
    expect(uptimeStats([{ status: 'unchecked' }]).pct).toBeNull();
  });
  it('counts up and degraded as answered, ignores unchecked', () => {
    const s = uptimeStats([{ status: 'up' }, { status: 'degraded' }, { status: 'down' }, { status: 'down' }, { status: 'unchecked' }]);
    expect(s).toEqual({ pct: 50, up: 2, down: 2, checked: 4, total: 5 });
  });
  it('is 100 when always up', () => {
    expect(uptimeStats([{ status: 'up' }, { status: 'up' }]).pct).toBe(100);
  });
});

describe('healthSegments', () => {
  const now = 100 * HOUR;
  it('creates the requested number of empty buckets', () => {
    const segs = healthSegments([], { now, hours: 24, buckets: 24 });
    expect(segs).toHaveLength(24);
    expect(segs.every((s) => s.status === 'none' && s.count === 0)).toBe(true);
    expect(segs[0].start).toBe(now - 24 * HOUR);
    expect(segs[23].end).toBe(now);
  });
  it('places samples and keeps the worst status per bucket', () => {
    const samples = [
      { ts: now - 23.5 * HOUR, status: 'up' },
      { ts: now - 23.4 * HOUR, status: 'down' },
      { ts: now - 0.5 * HOUR, status: 'degraded' },
      { ts: now - 0.4 * HOUR, status: 'up' },
      { ts: now, status: 'up' },
    ];
    const segs = healthSegments(samples, { now, hours: 24, buckets: 24 });
    expect(segs[0]).toMatchObject({ status: 'down', count: 2 });
    expect(segs[23]).toMatchObject({ status: 'degraded', count: 3 });
    expect(segs[10].status).toBe('none');
  });
  it('ignores samples outside the window and maps unknown statuses to unchecked', () => {
    const segs = healthSegments(
      [
        { ts: now - 30 * HOUR, status: 'down' },
        { ts: now + HOUR, status: 'down' },
        { ts: now - HOUR / 2, status: 'weird' },
      ],
      { now, hours: 24, buckets: 2 },
    );
    expect(segs[0].status).toBe('none');
    expect(segs[1]).toMatchObject({ status: 'unchecked', count: 1 });
  });
});

describe('portHealthView', () => {
  it('reports listening/idle for unchecked ports', () => {
    expect(portHealthView({ checkKind: 'none' }, null, true).status).toBe('listening');
    expect(portHealthView({ checkKind: 'none' }, { last: { status: 'up' } }, false).status).toBe('idle');
  });
  it('uses the last health result otherwise', () => {
    const last = { status: 'down', latencyMs: 3 };
    expect(portHealthView({ checkKind: 'http' }, { last }, false)).toEqual({ status: 'down', last });
    expect(portHealthView({ checkKind: 'tcp' }, null, false).status).toBe('unchecked');
  });
});

const proj = (id, name, extra = {}) => ({ id, name, description: '', groupId: null, groupName: null, favorite: false, ports: [], metadata: {}, updatedAt: 0, ...extra });
const rows = [
  { project: proj(1, 'Beta', { groupId: 1, groupName: 'Work', favorite: true, updatedAt: 10, ports: [{ port: 3000, role: 'web' }] }), status: { state: 'running' } },
  { project: proj(2, 'alpha', { description: 'shop api', updatedAt: 30, metadata: { owner: 'me' } }), status: { state: 'stopped' } },
  { project: proj(3, 'Gamma', { groupId: 2, groupName: 'Apps', updatedAt: 20, ports: [{ port: 8080, expectedProcess: 'nginx' }] }), status: { state: 'conflict' } },
];

describe('filterProjects', () => {
  it('returns everything with no filters', () => {
    expect(filterProjects(rows)).toHaveLength(3);
  });
  it('searches name, description, ports, processes and metadata', () => {
    expect(filterProjects(rows, { search: 'SHOP' }).map((r) => r.project.id)).toEqual([2]);
    expect(filterProjects(rows, { search: '3000' }).map((r) => r.project.id)).toEqual([1]);
    expect(filterProjects(rows, { search: 'nginx' }).map((r) => r.project.id)).toEqual([3]);
    expect(filterProjects(rows, { search: 'owner' }).map((r) => r.project.id)).toEqual([2]);
  });
  it('filters by group, ungrouped, status and favorites', () => {
    expect(filterProjects(rows, { groupId: '2' }).map((r) => r.project.id)).toEqual([3]);
    expect(filterProjects(rows, { groupId: 'none' }).map((r) => r.project.id)).toEqual([2]);
    expect(filterProjects(rows, { status: 'running' }).map((r) => r.project.id)).toEqual([1]);
    expect(filterProjects(rows, { favoritesOnly: true }).map((r) => r.project.id)).toEqual([1]);
  });
});

describe('sortProjects / groupProjects', () => {
  it('sorts by name case-insensitively', () => {
    expect(sortProjects(rows, 'name').map((r) => r.project.id)).toEqual([2, 1, 3]);
  });
  it('sorts by status severity', () => {
    expect(sortProjects(rows, 'status').map((r) => r.project.id)).toEqual([3, 1, 2]);
  });
  it('sorts by most recently updated', () => {
    expect(sortProjects(rows, 'updated').map((r) => r.project.id)).toEqual([2, 3, 1]);
  });
  it('does not mutate input', () => {
    const copy = [...rows];
    sortProjects(rows, 'status');
    expect(rows).toEqual(copy);
  });
  it('groups alphabetically with Ungrouped last', () => {
    const g = groupProjects(rows);
    expect(g.map((x) => x.name)).toEqual(['Apps', 'Work', 'Ungrouped']);
    expect(g[2].items[0].project.id).toBe(2);
  });
});

describe('dev server detection', () => {
  const projects = [proj(1, 'A', { ports: [{ port: 3000, protocol: 'tcp' }, { port: 53, protocol: 'udp' }] })];
  it('builds a registered port set', () => {
    expect([...registeredPorts(projects)]).toEqual(['tcp:3000', 'udp:53']);
  });
  it('lists dev servers with unregistered listen ports only', () => {
    const procs = [
      { pid: 1, name: 'node.exe', likelyDevServer: true, listenPorts: [3000] },
      { pid: 2, name: 'node.exe', likelyDevServer: true, listenPorts: [5173, 3000] },
      { pid: 3, name: 'svchost.exe', likelyDevServer: false, listenPorts: [135] },
      { pid: 4, name: 'python.exe', likelyDevServer: true, listenPorts: [] },
    ];
    expect(unregisteredDevServers(procs, projects)).toEqual([{ proc: procs[1], ports: [5173] }]);
  });
  it('drafts a project from a process', () => {
    const d = draftFromProcess({ name: 'node.exe', kind: 'Vite' }, [5173]);
    expect(d.name).toBe('Vite (5173)');
    expect(d.ports).toHaveLength(1);
    expect(d.ports[0]).toMatchObject({ port: '5173', expectedProcess: 'node.exe', role: 'Vite', protocol: 'tcp' });
    expect(draftFromProcess({ name: 'python.exe' }, [8000, 8001]).name).toBe('python :8000');
  });
});

describe('key/value rows', () => {
  it('round-trips an object', () => {
    const r = kvRows({ a: '1', b: 2 });
    expect(r.map(({ k, v }) => [k, v])).toEqual([['a', '1'], ['b', '2']]);
    expect(new Set(r.map((x) => x.key)).size).toBe(2);
    expect(kvObject(r)).toEqual({ object: { a: '1', b: '2' }, error: null });
  });
  it('handles non-objects', () => {
    expect(kvRows(null)).toEqual([]);
  });
  it('drops blank rows, rejects missing keys and duplicates', () => {
    expect(kvObject([{ k: ' ', v: '' }]).object).toEqual({});
    expect(kvObject([{ k: '', v: 'x' }]).error).toMatch(/no key/);
    expect(kvObject([{ k: 'a', v: '1' }, { k: 'a ', v: '2' }]).error).toMatch(/twice/);
  });
});

describe('validatePortRows', () => {
  it('accepts valid rows', () => {
    expect(validatePortRows([emptyPortRow({ port: '3000' }), emptyPortRow({ port: '3000', protocol: 'udp', checkKind: 'none' })])).toEqual([null, null]);
  });
  it('flags bad numbers, duplicates, udp checks and http paths', () => {
    const errs = validatePortRows([
      emptyPortRow({ port: 'abc' }),
      emptyPortRow({ port: '70000' }),
      emptyPortRow({ port: '8080' }),
      emptyPortRow({ port: '8080' }),
      emptyPortRow({ port: '9000', protocol: 'udp', checkKind: 'tcp' }),
      emptyPortRow({ port: '9001', checkKind: 'http', httpPath: 'health' }),
      emptyPortRow({ port: '' }),
    ]);
    expect(errs[0]).toMatch(/number/);
    expect(errs[1]).toMatch(/1–65535/);
    expect(errs[2]).toBeNull();
    expect(errs[3]).toBe('Duplicate of row 3');
    expect(errs[4]).toMatch(/UDP/);
    expect(errs[5]).toMatch(/start with/);
    expect(errs[6]).toMatch(/number/);
  });
});

describe('project drafts', () => {
  it('creates an empty draft with one port row', () => {
    const d = projectDraft(null);
    expect(d.ports).toHaveLength(1);
    expect(d.name).toBe('');
  });
  it('round-trips a project into input', () => {
    const p = proj(5, 'Shop', {
      directory: 'C:\\code\\shop',
      groupId: 2,
      favorite: true,
      metadata: { env: 'dev' },
      startCommand: 'npm run dev',
      ports: [{ id: 1, port: 3000, protocol: 'tcp', role: 'web', host: '127.0.0.1', checkKind: 'http', httpPath: '/health', expectedProcess: 'node.exe' }],
    });
    const { input, error } = projectInput(projectDraft(p));
    expect(error).toBeUndefined();
    expect(input).toEqual({
      name: 'Shop',
      description: '',
      directory: 'C:\\code\\shop',
      groupId: 2,
      favorite: true,
      metadata: { env: 'dev' },
      startCommand: 'npm run dev',
      ports: [{ port: 3000, protocol: 'tcp', role: 'web', host: '127.0.0.1', checkKind: 'http', httpPath: '/health', expectedProcess: 'node.exe' }],
    });
  });
  it('normalizes blanks and udp checks', () => {
    const d = { ...projectDraft(null), name: ' X ', ports: [emptyPortRow({ port: '53', protocol: 'udp', checkKind: 'none' })] };
    const { input } = projectInput(d);
    expect(input).toMatchObject({ name: 'X', directory: null, groupId: null, startCommand: null });
    expect(input.ports[0]).toMatchObject({ checkKind: 'none', httpPath: '/', expectedProcess: null });
  });
  it('reports errors', () => {
    expect(projectInput(projectDraft(null)).error).toMatch(/name/);
    expect(projectInput({ ...projectDraft(null), name: 'a' }).error).toMatch(/Port row 1/);
    expect(projectInput({ ...projectDraft(null), name: 'a', ports: [], metadata: [{ k: '', v: 'x' }] }).error).toMatch(/Metadata/);
  });
});

describe('plan entry operations', () => {
  const a = emptyEntry({ service: 'a', port: '1' });
  const b = emptyEntry({ service: 'b', port: '2' });
  const c = emptyEntry({ service: 'c', port: '3' });
  it('adds, removes and updates without mutation', () => {
    const list = [a, b];
    expect(addEntry(list, c)).toEqual([a, b, c]);
    expect(addEntry(list, { service: 'x' })[2].key).toBeTruthy();
    expect(removeEntry(list, 0)).toEqual([b]);
    expect(updateEntry(list, 1, { port: '9' })[1].port).toBe('9');
    expect(list).toEqual([a, b]);
  });
  it('moves entries and no-ops at edges', () => {
    const list = [a, b, c];
    expect(moveEntry(list, 0, 1)).toEqual([b, a, c]);
    expect(moveEntry(list, 2, -1)).toEqual([a, c, b]);
    expect(moveEntry(list, 0, -1)).toBe(list);
    expect(moveEntry(list, 2, 1)).toBe(list);
    expect(moveEntry(list, 5, -1)).toBe(list);
  });
  it('collects used ports per protocol', () => {
    const list = [a, emptyEntry({ port: '53', protocol: 'udp' }), emptyEntry({ port: 'x' })];
    expect([...entryPorts(list)]).toEqual([1]);
    expect([...entryPorts(list, 'udp')]).toEqual([53]);
  });
  it('picks the first free candidate', () => {
    expect(pickFreePort([3001, 3002], new Set([3001]))).toBe(3002);
    expect(pickFreePort([3001], new Set([3001]))).toBeNull();
    expect(pickFreePort(undefined, new Set())).toBeNull();
  });
  it('computes a suggestion window', () => {
    expect(suggestWindow(3000)).toEqual({ start: 3001, end: 3999 });
    expect(suggestWindow(65535)).toEqual({ start: 65535, end: 65535 });
  });
  it('builds payloads and plan input', () => {
    expect(entriesPayload([emptyEntry({ service: ' web ', port: '3000' }), emptyEntry({ service: 'x', port: 'abc' })])).toEqual([
      { service: 'web', kind: 'custom', port: 3000, protocol: 'tcp', host: 'localhost', note: '' },
      { service: 'x', kind: 'custom', port: 0, protocol: 'tcp', host: 'localhost', note: '' },
    ]);
    expect(planInput({ ...planDraft(null) }).error).toMatch(/name/);
    expect(planInput({ ...planDraft(null), name: 'p', entries: [emptyEntry()] }).error).toMatch(/Entry 1/);
    const ok = planInput({ ...planDraft(null), name: 'p', projectId: '4', entries: [a] });
    expect(ok.input).toMatchObject({ name: 'p', projectId: 4, profileId: null, entries: [{ service: 'a', port: 1 }] });
  });
  it('drafts a saved plan', () => {
    const d = planDraft({ name: 'n', description: '', projectId: 1, profileId: null, entries: [{ service: 's', kind: 'api', port: 8000, protocol: 'tcp', host: 'localhost', note: '' }] });
    expect(d).toMatchObject({ projectId: '1', profileId: '' });
    expect(d.entries[0]).toMatchObject({ port: '8000', kind: 'api' });
  });
  it('groups issues by index', () => {
    expect(issuesByIndex([{ index: 0, code: 'a' }, { index: 2, code: 'b' }, { index: 0, code: 'c' }])).toEqual({
      0: [{ index: 0, code: 'a' }, { index: 0, code: 'c' }],
      2: [{ index: 2, code: 'b' }],
    });
  });
});

describe('projectPortMap', () => {
  it('combines project ports and linked plan entries sorted by port', () => {
    const p = proj(1, 'A', { ports: [{ id: 9, port: 5000, protocol: 'tcp', role: 'web', host: 'localhost' }] });
    const plans = [
      { id: 2, name: 'Map', projectId: 1, entries: [{ service: 'db', kind: 'database', port: 5432, protocol: 'tcp', host: 'localhost' }, { service: 'web', kind: 'website', port: 5000, protocol: 'tcp', host: 'localhost' }] },
      { id: 3, name: 'Other', projectId: 7, entries: [{ service: 'x', port: 1 }] },
    ];
    const m = projectPortMap(p, plans);
    expect(m.map((r) => [r.port, r.source])).toEqual([[5000, 'project'], [5000, 'plan'], [5432, 'plan']]);
    expect(m[2].planName).toBe('Map');
    expect(projectPortMap(null, plans)).toEqual([]);
  });
});

describe('ranges', () => {
  const snapshot = { ports: [{ protocol: 'tcp', port: 3005 }, { protocol: 'udp', port: 3001 }, { protocol: 'tcp', port: 3001 }, { protocol: 'tcp', port: 4000 }] };
  it('counts occupied ports in a reservation (protocol-aware)', () => {
    const o = rangeOccupancy({ protocol: 'tcp', portStart: 3000, portEnd: 3010 }, snapshot);
    expect(o.count).toBe(2);
    expect(o.size).toBe(11);
    expect(o.ports.map((u) => u.port)).toEqual([3001, 3005]);
  });
  it('counts all protocols for ranges without one', () => {
    expect(rangeOccupancy({ portStart: 3000, portEnd: 3001 }, snapshot).count).toBe(2);
    expect(rangeOccupancy({ portStart: 1, portEnd: 2 }, null).count).toBe(0);
  });
  it('validates start/end', () => {
    expect(validateRange(1, 65535)).toBeNull();
    expect(validateRange('a', 2)).toMatch(/numbers/);
    expect(validateRange(0, 10)).toMatch(/1–65535/);
    expect(validateRange(10, 5)).toMatch(/greater/);
  });
  it('positions a range on the band', () => {
    expect(bandPosition(1, 65535)).toEqual({ left: '0.000%', width: '100.000%' });
    const p = bandPosition(65535, 65535);
    expect(parseFloat(p.left) + parseFloat(p.width)).toBeLessThanOrEqual(100.0001);
    expect(parseFloat(bandPosition(3000, 3000).width)).toBeGreaterThan(0);
  });
});

describe('profiles', () => {
  it('drafts from a template and builds input', () => {
    const d = profileDraft(null, PROFILE_TEMPLATES[0]);
    expect(d).toMatchObject({ kind: 'web', name: 'Web development', monitorHealth: true, projectIds: [] });
    expect(d.startup[0]).toMatchObject({ k: 'stack' });
    const { input } = profileInput({ ...d, projectIds: [1, 2] });
    expect(input).toMatchObject({ name: 'Web development', kind: 'web', startup: { stack: 'Vite / Next.js' }, projectIds: [1, 2], monitorHealth: true });
  });
  it('custom template starts with an empty name', () => {
    expect(profileDraft(null, PROFILE_TEMPLATES.find((t) => t.kind === 'custom')).name).toBe('');
    expect(profileInput(profileDraft(null, null)).error).toMatch(/name/);
  });
  it('drafts an existing profile without sharing arrays', () => {
    const p = { name: 'P', kind: 'game', description: 'd', notes: 'n', startup: { a: 'b' }, monitorHealth: false, projectIds: [3] };
    const d = profileDraft(p);
    expect(d).toMatchObject({ name: 'P', kind: 'game', notes: 'n', monitorHealth: false, projectIds: [3] });
    d.projectIds.push(4);
    expect(p.projectIds).toEqual([3]);
    expect(profileInput({ ...d, startup: [{ k: '', v: 'x' }] }).error).toMatch(/Startup/);
  });
  it('aggregates project states and tones', () => {
    const agg = aggregateStatus(['running', 'running', 'stopped', 'empty']);
    expect(agg).toEqual({ running: 2, partial: 0, stopped: 1, conflict: 0, empty: 1, total: 4 });
    expect(aggregateTone(agg)).toBe('warn');
    expect(aggregateTone(aggregateStatus(['running', 'empty']))).toBe('ok');
    expect(aggregateTone(aggregateStatus(['conflict']))).toBe('danger');
    expect(aggregateTone(aggregateStatus(['stopped']))).toBe('');
    expect(aggregateTone(aggregateStatus([]))).toBe('');
  });
  it('toggles ids', () => {
    expect(toggleId([1, 2], 2)).toEqual([1]);
    expect(toggleId([1], 2)).toEqual([1, 2]);
  });
});
