import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONN_FILTERS,
  DEFAULT_PORT_FILTERS,
  DEFAULT_PROC_FILTERS,
  buildConnectionRows,
  buildListenerRows,
  buildPortRows,
  categoryCounts,
  connTabRows,
  connectionSummary,
  countBy,
  exploreProcesses,
  explorePorts,
  exposedListeners,
  exposureMatches,
  filterConnections,
  filterConnectionsBase,
  filterPorts,
  filterProcesses,
  filterProcessesBase,
  freshKeys,
  matchesQuery,
  nextFreshExpiry,
  parentGroup,
  parseCheckPort,
  portStats,
  processSummary,
  projectPortIndex,
  restoreFilters,
  reviewHints,
  sortRows,
  toggleIn,
  topN,
  trackAppeared,
  uptime,
} from './explore.js';

const procs = [
  { pid: 10, name: 'node.exe', category: 'dev_runtime', likelyDevServer: true, kind: 'Node.js', listenPorts: [3000], udpPorts: [], connections: 2, cpuPercent: 4.5, memoryBytes: 100, startTime: 1000, parentPid: 5, parentName: 'Code.exe', indicators: [] },
  { pid: 11, name: 'java.exe', category: 'dev_runtime', likelyDevServer: false, listenPorts: [8080], udpPorts: [], connections: 0, cpuPercent: null, memoryBytes: 300, startTime: null, parentPid: 5, parentName: 'Code.exe', indicators: [{ rule: 'reachable-from-network', level: 'info', title: 'Reachable', detail: 'd' }] },
  { pid: 12, name: 'svc.exe', category: 'system', likelyDevServer: false, listenPorts: [], udpPorts: [5353], connections: 0, memoryBytes: null, startTime: 500, parentPid: null, parentName: null, indicators: [{ rule: 'listener-in-temporary-location', level: 'review', title: 'Temp', detail: 'Runs from temp' }] },
  { pid: 13, name: 'chrome.exe', category: 'browser', likelyDevServer: false, listenPorts: [], udpPorts: [], connections: 9, cpuPercent: 10, memoryBytes: 200, startTime: 2000, parentPid: 7, parentName: null, indicators: [] },
];
const procByPid = new Map(procs.map((p) => [p.pid, p]));

const ports = [
  { protocol: 'tcp', port: 3000, pids: [10], exposure: 'loopback', dynamic: false, wellKnown: null, connections: 2, bindings: [{ addr: '127.0.0.1', family: 'ipv4', scope: 'loopback', pid: 10 }, { addr: '::1', family: 'ipv6', scope: 'loopback', pid: 10 }] },
  { protocol: 'tcp', port: 8080, pids: [11], exposure: 'all_interfaces', dynamic: false, wellKnown: 'HTTP alternate', connections: 0, bindings: [{ addr: '0.0.0.0', family: 'ipv4', scope: 'all_interfaces', pid: 11 }] },
  { protocol: 'udp', port: 5353, pids: [12], exposure: 'specific', dynamic: false, wellKnown: 'mDNS', connections: 0, bindings: [{ addr: '192.168.1.5', family: 'ipv4', scope: 'specific', pid: 12 }] },
  { protocol: 'tcp', port: 50123, pids: [99], exposure: 'link_local', dynamic: true, wellKnown: null, connections: 0, bindings: [{ addr: 'fe80::1', family: 'ipv6', scope: 'link_local', pid: 99 }] },
];
const notes = [{ protocol: 'tcp', port: 8080, label: 'Shop API', note: 'staging mirror', favorite: true }];
const projects = [
  { id: 1, name: 'Shop', ports: [{ protocol: 'tcp', port: 3000 }, { protocol: 'tcp', port: 8080 }] },
  { id: 2, name: 'Admin', ports: [{ protocol: 'tcp', port: 3000 }, { protocol: 'tcp', port: 3000 }] },
];
const conflicts = [{ id: 'c1', port: 8080, protocol: 'tcp', severity: 'warning', pids: [] }];
const rows = buildPortRows(ports, { procByPid, notes, projects, conflicts });
const pf = (o) => ({ ...DEFAULT_PORT_FILTERS, ...o });

describe('matchesQuery', () => {
  it('matches all terms case-insensitively across fields', () => {
    expect(matchesQuery('NODE 3000', ['node.exe', '3000'])).toBe(true);
    expect(matchesQuery('node 8080', ['node.exe', '3000'])).toBe(false);
    expect(matchesQuery('  ', ['x'])).toBe(true);
    expect(matchesQuery('x', [null, undefined, ''])).toBe(false);
  });
});

describe('sortRows', () => {
  const r = [{ v: 3 }, { v: null }, { v: 1 }, { v: 2 }];
  it('sorts numbers both directions with missing values last', () => {
    expect(sortRows(r, (x) => x.v, 'asc').map((x) => x.v)).toEqual([1, 2, 3, null]);
    expect(sortRows(r, (x) => x.v, 'desc').map((x) => x.v)).toEqual([3, 2, 1, null]);
  });
  it('is stable and orders by group first', () => {
    const g = [{ g: 'b', n: 1 }, { g: 'a', n: 2 }, { g: 'b', n: 0 }, { g: 'a', n: 2, t: 1 }];
    const out = sortRows(g, (x) => x.n, 'asc', (x) => x.g);
    expect(out.map((x) => `${x.g}${x.n}${x.t || ''}`)).toEqual(['a2', 'a21', 'b0', 'b1']);
  });
  it('sorts strings naturally', () => {
    expect(sortRows([{ s: 'p10' }, { s: 'p9' }], (x) => x.s).map((x) => x.s)).toEqual(['p9', 'p10']);
  });
  it('does not mutate input', () => {
    const copy = [...r];
    sortRows(r, (x) => x.v);
    expect(r).toEqual(copy);
  });
});

describe('countBy / topN', () => {
  it('counts and ranks with key tie-break', () => {
    const c = countBy(['b', 'a', 'b', null, 'c', 'a'], (x) => x);
    expect(c.get('b')).toBe(2);
    expect(c.has(null)).toBe(false);
    expect(topN(c, 2)).toEqual([{ key: 'a', count: 2 }, { key: 'b', count: 2 }]);
  });
});

describe('buildPortRows', () => {
  it('enriches owners, notes, projects and conflicts', () => {
    const r8080 = rows.find((r) => r.port === 8080);
    expect(r8080.ownerName).toBe('java.exe');
    expect(r8080.note.label).toBe('Shop API');
    expect(r8080.projects).toEqual([{ id: 1, name: 'Shop' }]);
    expect(r8080.conflicts).toHaveLength(1);
    const r3000 = rows.find((r) => r.port === 3000);
    expect(r3000.devServer).toBe(true);
    expect(r3000.projects.map((p) => p.name)).toEqual(['Shop', 'Admin']);
    const unknown = rows.find((r) => r.port === 50123);
    expect(unknown.ownerName).toBe('PID 99');
    expect(unknown.category).toBe('other');
  });
  it('deduplicates projects per port', () => {
    expect(projectPortIndex(projects).get('tcp:3000')).toHaveLength(2);
  });
});

describe('filterPorts', () => {
  const ids = (o) => filterPorts(rows, pf(o)).map((r) => r.port);
  it('filters by protocol and exposure', () => {
    expect(ids({ protocol: 'udp' })).toEqual([5353]);
    expect(ids({ exposure: 'loopback' })).toEqual([3000]);
    expect(ids({ exposure: 'all_interfaces' })).toEqual([8080]);
    expect(ids({ exposure: 'specific' })).toEqual([5353, 50123]);
  });
  it('applies toggles', () => {
    expect(ids({ favorites: true })).toEqual([8080]);
    expect(ids({ registered: true })).toEqual([3000, 8080]);
    expect(ids({ hideDynamic: true })).toEqual([3000, 8080, 5353]);
    expect(ids({ devOnly: true })).toEqual([3000]);
  });
  it('searches port, process, address, label, note, well-known and project', () => {
    expect(ids({ q: '3000' })).toEqual([3000]);
    expect(ids({ q: 'java' })).toEqual([8080]);
    expect(ids({ q: '192.168' })).toEqual([5353]);
    expect(ids({ q: 'shop api' })).toEqual([8080]);
    expect(ids({ q: 'staging' })).toEqual([8080]);
    expect(ids({ q: 'mdns' })).toEqual([5353]);
    expect(ids({ q: 'admin' })).toEqual([3000]);
    expect(ids({ q: 'fe80' })).toEqual([50123]);
  });
  it('exposureMatches treats link-local as specific', () => {
    expect(exposureMatches('all', 'loopback')).toBe(true);
    expect(exposureMatches('specific', 'link_local')).toBe(true);
    expect(exposureMatches('loopback', 'link_local')).toBe(false);
  });
});

describe('explorePorts', () => {
  it('sorts by connections desc with port tie-break', () => {
    expect(explorePorts(rows, pf({ sort: 'connections', dir: 'desc' })).map((r) => r.port)).toEqual([3000, 5353, 8080, 50123]);
  });
  it('sorts by exposure', () => {
    expect(explorePorts(rows, pf({ sort: 'exposure' })).map((r) => r.port)).toEqual([3000, 50123, 5353, 8080]);
  });
  it('sorts by process name', () => {
    expect(explorePorts(rows, pf({ sort: 'process' })).map((r) => r.ownerName)).toEqual(['java.exe', 'node.exe', 'PID 99', 'svc.exe']);
  });
  it('orders rows by group label when grouped', () => {
    const out = explorePorts(rows, pf({ group: 'protocol' }));
    expect(out.map((r) => r.protocol)).toEqual(['tcp', 'tcp', 'tcp', 'udp']);
    const cat = explorePorts(rows, pf({ group: 'category' })).map((r) => r.category);
    expect(cat).toEqual(['dev_runtime', 'dev_runtime', 'other', 'system']);
  });
});

describe('portStats', () => {
  it('counts tcp, udp and exposed', () => {
    expect(portStats(ports)).toEqual({ tcp: 3, udp: 1, exposed: 1 });
    expect(portStats(undefined)).toEqual({ tcp: 0, udp: 0, exposed: 0 });
  });
});

describe('trackAppeared', () => {
  const p = (...nums) => nums.map((port) => ({ protocol: 'tcp', port }));
  it('does not flag anything on the first snapshot', () => {
    const s = trackAppeared({ known: null, fresh: {} }, p(1, 2), 1000);
    expect(s.fresh).toEqual({});
    expect([...s.known]).toEqual(['tcp:1', 'tcp:2']);
  });
  it('flags new ports and expires them after the ttl', () => {
    let s = trackAppeared({ known: null, fresh: {} }, p(1), 0);
    s = trackAppeared(s, p(1, 2), 1000);
    expect(s.fresh).toEqual({ 'tcp:2': 1000 });
    s = trackAppeared(s, p(1, 2, 3), 3000);
    expect(s.fresh).toEqual({ 'tcp:2': 1000, 'tcp:3': 3000 });
    expect([...freshKeys(s.fresh, 5500)]).toEqual(['tcp:2', 'tcp:3']);
    expect([...freshKeys(s.fresh, 6100)]).toEqual(['tcp:3']);
    expect(nextFreshExpiry(s.fresh, 3000)).toBe(3000);
    s = trackAppeared(s, p(1, 2, 3), 6500);
    expect(s.fresh).toEqual({ 'tcp:3': 3000 });
    expect(nextFreshExpiry({}, 0)).toBeNull();
  });
  it('drops ports that vanished and re-flags them when they come back', () => {
    let s = trackAppeared({ known: new Set(['tcp:1']), fresh: {} }, p(1, 2), 100);
    s = trackAppeared(s, p(1), 200);
    expect(s.fresh).toEqual({});
    s = trackAppeared(s, p(1, 2), 300);
    expect(s.fresh).toEqual({ 'tcp:2': 300 });
  });
});

describe('parseCheckPort', () => {
  it('validates input', () => {
    expect(parseCheckPort('3000')).toEqual({ port: 3000, error: null });
    expect(parseCheckPort(' ')).toEqual({ port: null, error: null });
    expect(parseCheckPort('0').error).toBeTruthy();
    expect(parseCheckPort('65536').error).toBeTruthy();
    expect(parseCheckPort('30a').error).toBeTruthy();
    expect(parseCheckPort('-1').error).toBeTruthy();
  });
});

const conns = [
  { protocol: 'tcp', family: 'ipv4', localAddr: '127.0.0.1', localPort: 50000, remoteAddr: '127.0.0.1', remotePort: 3000, state: 'established', pid: 13, category: 'local' },
  { protocol: 'tcp', family: 'ipv4', localAddr: '192.168.1.5', localPort: 50001, remoteAddr: '140.82.112.3', remotePort: 443, state: 'established', pid: 13, category: 'internet' },
  { protocol: 'tcp', family: 'ipv4', localAddr: '192.168.1.5', localPort: 50002, remoteAddr: '140.82.112.3', remotePort: 443, state: 'time_wait', pid: 0, category: 'internet' },
  { protocol: 'tcp', family: 'ipv4', localAddr: '192.168.1.5', localPort: 50003, remoteAddr: '192.168.1.20', remotePort: 22, state: 'established', pid: 10, category: 'lan' },
];

describe('connections', () => {
  const cRows = buildConnectionRows(conns, procByPid);
  const lRows = buildListenerRows(ports, procByPid);
  const cf = (o) => ({ ...DEFAULT_CONN_FILTERS, ...o });

  it('builds rows with unique keys and process names', () => {
    expect(new Set(cRows.map((r) => r.key)).size).toBe(4);
    expect(cRows[0].procName).toBe('chrome.exe');
    expect(cRows[2].procName).toBe('PID 0');
  });
  it('flattens listener bindings', () => {
    expect(lRows).toHaveLength(5);
    expect(lRows.find((r) => r.localPort === 5353).state).toBe('bound');
    expect(lRows.every((r) => r.category === 'listener')).toBe(true);
  });
  it('selects tab rows', () => {
    expect(connTabRows('established', cRows, lRows)).toHaveLength(3);
    expect(connTabRows('all', cRows, lRows)).toHaveLength(4);
    expect(connTabRows('listening', cRows, lRows)).toBe(lRows);
  });
  it('filters by category, state, protocol and search', () => {
    expect(filterConnections(cRows, cf({ categories: ['internet'] }))).toHaveLength(2);
    expect(filterConnections(cRows, cf({ categories: ['internet', 'lan'] }))).toHaveLength(3);
    expect(filterConnections(cRows, cf({ state: 'time_wait' }))).toHaveLength(1);
    expect(filterConnections(cRows, cf({ protocol: 'udp' }))).toHaveLength(0);
    expect(filterConnections(cRows, cf({ q: 'chrome 443' }))).toHaveLength(1);
    expect(filterConnections(cRows, cf({ q: '192.168.1.20' }))).toHaveLength(1);
    expect(filterConnectionsBase(cRows, cf({ categories: ['lan'] }))).toHaveLength(4);
  });
  it('summarizes categories, remotes and processes', () => {
    const s = connectionSummary(cRows, 3);
    expect(s.byCategory).toEqual({ local: 1, lan: 1, internet: 2, other: 0 });
    expect(s.remotes[0]).toEqual({ key: '140.82.112.3', count: 2 });
    expect(s.procs[0]).toEqual({ pid: 13, name: 'chrome.exe', count: 2 });
  });
  it('extracts review hints and exposed listeners', () => {
    expect(reviewHints(procs).map((h) => h.proc.pid)).toEqual([12]);
    expect(exposedListeners(procs).map((h) => h.proc.pid)).toEqual([11]);
  });
});

describe('processes', () => {
  const f = (o) => ({ ...DEFAULT_PROC_FILTERS, ...o });
  const ids = (o, now = 10000) => exploreProcesses(procs, f(o), now).map((p) => p.pid);

  it('filters by toggles, categories and search', () => {
    expect(filterProcesses(procs, f({ devOnly: true })).map((p) => p.pid)).toEqual([10]);
    expect(filterProcesses(procs, f({ listeningOnly: true })).map((p) => p.pid)).toEqual([10, 11, 12]);
    expect(filterProcesses(procs, f({ reviewOnly: true })).map((p) => p.pid)).toEqual([12]);
    expect(filterProcesses(procs, f({ categories: ['browser', 'system'] })).map((p) => p.pid)).toEqual([12, 13]);
    expect(filterProcessesBase(procs, f({ categories: ['browser'] }))).toHaveLength(4);
    expect(filterProcesses(procs, f({ q: '5353' })).map((p) => p.pid)).toEqual([12]);
    expect(filterProcesses(procs, f({ q: '11' })).map((p) => p.pid)).toEqual([11]);
  });
  it('sorts by every key with missing values last', () => {
    expect(ids({ sort: 'name' })).toEqual([13, 11, 10, 12]);
    expect(ids({ sort: 'pid', dir: 'desc' })).toEqual([13, 12, 11, 10]);
    expect(ids({ sort: 'cpu', dir: 'desc' })).toEqual([13, 10, 11, 12]);
    expect(ids({ sort: 'memory' })).toEqual([10, 13, 11, 12]);
    expect(ids({ sort: 'ports', dir: 'desc' })).toEqual([10, 11, 12, 13]);
    expect(ids({ sort: 'connections', dir: 'desc' })).toEqual([13, 10, 11, 12]);
    expect(ids({ sort: 'uptime', dir: 'desc' })).toEqual([12, 10, 13, 11]);
  });
  it('groups by parent in tree mode', () => {
    expect(parentGroup(procs[0])).toBe('Code.exe · PID 5');
    expect(parentGroup(procs[3])).toBe('PID 7');
    expect(parentGroup(procs[2])).toBe('No parent recorded');
    expect(ids({ tree: true })).toEqual([11, 10, 12, 13]);
  });
  it('computes uptime, summary and category counts', () => {
    expect(uptime(procs[0], 5000)).toBe(4000);
    expect(uptime(procs[1], 5000)).toBeNull();
    expect(uptime({ startTime: 9000 }, 5000)).toBe(0);
    expect(processSummary(procs)).toEqual({ count: 4, dev: 1, memory: 600 });
    expect(categoryCounts(procs)).toEqual([
      { value: 'dev_runtime', label: 'Dev runtime', count: 2 },
      { value: 'browser', label: 'Browser', count: 1 },
      { value: 'system', label: 'System', count: 1 },
    ]);
  });
});

describe('helpers', () => {
  it('toggleIn adds and removes', () => {
    expect(toggleIn(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleIn(['a', 'b'], 'a')).toEqual(['b']);
  });
  it('restoreFilters keeps only known keys with matching types', () => {
    const d = { q: '', on: false, list: [] };
    expect(restoreFilters(null, d)).toEqual(d);
    expect(restoreFilters({ q: 'x', on: 'yes', list: ['a'], extra: 1 }, d)).toEqual({ q: 'x', on: false, list: ['a'] });
    expect(restoreFilters({ list: { a: 1 } }, d)).toEqual(d);
  });
});
