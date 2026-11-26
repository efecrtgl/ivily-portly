import { describe, expect, it } from 'vitest';
import {
  DASHBOARD_CARDS,
  buildEventFilter,
  dayLabel,
  devServers,
  eventMatchesFilter,
  favoritePorts,
  formatInterval,
  groupByDay,
  importRows,
  isFiltered,
  lastEventByProject,
  portFilterError,
  portRange,
  recentProjects,
  sinceFor,
  sortByAttention,
  sortConflicts,
  statusCounts,
  toggleHidden,
  topProcesses,
  totalCount,
  updateErrorMessage,
  uptime,
  utilization,
  validateInt,
} from './overview.js';

const NOW = new Date(2026, 10, 27, 15, 30).getTime(); // local time

describe('dashboard cards', () => {
  it('has unique ids', () => {
    const ids = DASHBOARD_CARDS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
  it('toggles hidden ids without duplicates or mutation', () => {
    const hidden = ['a'];
    expect(toggleHidden(hidden, 'b')).toEqual(['a', 'b']);
    expect(toggleHidden(hidden, 'a')).toEqual([]);
    expect(hidden).toEqual(['a']);
    expect(toggleHidden(undefined, 'x')).toEqual(['x']);
    expect(toggleHidden(['a', 'a'], 'b')).toEqual(['a', 'b']);
  });
});

describe('utilization', () => {
  it('classifies port ranges at the boundaries', () => {
    expect(portRange(1)).toBe('system');
    expect(portRange(1023)).toBe('system');
    expect(portRange(1024)).toBe('registered');
    expect(portRange(49151)).toBe('registered');
    expect(portRange(49152)).toBe('dynamic');
    expect(portRange(65535)).toBe('dynamic');
  });
  it('counts by range, exposure and protocol', () => {
    const u = utilization([
      { protocol: 'tcp', port: 80, exposure: 'all_interfaces' },
      { protocol: 'tcp', port: 3000, exposure: 'loopback' },
      { protocol: 'udp', port: 5353, exposure: 'all_interfaces' },
      { protocol: 'tcp', port: 50000, exposure: 'link_local' },
      { protocol: 'tcp', port: 8080, exposure: 'specific' },
    ]);
    expect(u.total).toBe(5);
    expect(u.byRange).toEqual({ system: 1, registered: 3, dynamic: 1 });
    expect(u.byExposure).toEqual({ loopback: 1, all_interfaces: 2, specific: 2 });
    expect(u.byProtocol).toEqual({ tcp: 4, udp: 1 });
  });
  it('handles empty input', () => {
    expect(utilization(undefined).total).toBe(0);
  });
  it('ranks top processes by port count', () => {
    const top = topProcesses(
      [
        { pid: 1, name: 'b', listenPorts: [1, 2], udpPorts: [] },
        { pid: 2, name: 'a', listenPorts: [1], udpPorts: [5] },
        { pid: 3, name: 'c', listenPorts: [1, 2, 3], udpPorts: [] },
        { pid: 4, name: 'idle', listenPorts: [], udpPorts: [] },
      ],
      3,
    );
    expect(top.map((p) => p.pid)).toEqual([3, 2, 1]);
    expect(top[0].count).toBe(3);
    expect(topProcesses([], 3)).toEqual([]);
  });
});

describe('conflicts and processes', () => {
  it('sorts conflicts by severity then port', () => {
    const sorted = sortConflicts([
      { id: 'a', severity: 'info', port: 1, title: 'x' },
      { id: 'b', severity: 'warning', port: 9000, title: 'x' },
      { id: 'c', severity: 'error', port: 5000, title: 'x' },
      { id: 'd', severity: 'warning', port: 3000, title: 'x' },
      { id: 'e', severity: 'error', port: null, title: 'x' },
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['c', 'e', 'd', 'b', 'a']);
  });
  it('does not mutate the input', () => {
    const input = [{ severity: 'info' }, { severity: 'error' }];
    sortConflicts(input);
    expect(input[0].severity).toBe('info');
  });
  it('filters and orders dev servers', () => {
    const out = devServers([
      { pid: 1, likelyDevServer: true, listenPorts: [5173] },
      { pid: 2, likelyDevServer: false, listenPorts: [80] },
      { pid: 3, likelyDevServer: true, listenPorts: [3000, 9229] },
      { pid: 4, likelyDevServer: true, listenPorts: [] },
    ]);
    expect(out.map((p) => p.pid)).toEqual([3, 1, 4]);
  });
  it('computes uptime safely', () => {
    expect(uptime(NOW - 5000, NOW)).toBe(5000);
    expect(uptime(null, NOW)).toBeNull();
    expect(uptime(NOW + 1, NOW)).toBeNull();
  });
});

describe('projects', () => {
  it('counts statuses', () => {
    expect(statusCounts([{ state: 'running' }, { state: 'running' }, { state: 'conflict' }, { state: 'bogus' }])).toEqual({
      running: 2,
      partial: 0,
      stopped: 0,
      conflict: 1,
      empty: 0,
    });
  });
  it('sorts by attention', () => {
    const rows = [
      { project: { name: 'b' }, status: { state: 'running' } },
      { project: { name: 'a' }, status: { state: 'stopped' } },
      { project: { name: 'c' }, status: { state: 'conflict' } },
      { project: { name: 'a' }, status: { state: 'running' } },
    ];
    expect(sortByAttention(rows).map((r) => `${r.project.name}:${r.status.state}`)).toEqual([
      'c:conflict',
      'a:running',
      'b:running',
      'a:stopped',
    ]);
  });
  it('orders recent projects by updatedAt or newest event', () => {
    const projects = [
      { id: 1, name: 'one', updatedAt: 100 },
      { id: 2, name: 'two', updatedAt: 300 },
      { id: 3, name: 'three', updatedAt: 200 },
    ];
    const last = lastEventByProject([
      { projectId: 1, ts: 500 },
      { projectId: 1, ts: 400 },
      { projectId: null, ts: 999 },
    ]);
    expect(last).toEqual({ 1: 500 });
    const r = recentProjects(projects, last, 2);
    expect(r.map((x) => x.project.id)).toEqual([1, 2]);
    expect(r[0].ts).toBe(500);
  });
  it('builds favorite port status', () => {
    const procByPid = new Map([[10, { pid: 10, name: 'node.exe' }]]);
    const favs = favoritePorts(
      [
        { protocol: 'tcp', port: 8080, label: 'api', favorite: true },
        { protocol: 'tcp', port: 3000, label: '', favorite: true },
        { protocol: 'tcp', port: 9999, label: 'x', favorite: false },
      ],
      [{ protocol: 'tcp', port: 3000, pids: [10, 11] }],
      procByPid,
    );
    expect(favs).toEqual([
      { protocol: 'tcp', port: 3000, label: '', owners: ['node.exe', 'PID 11'], occupied: true },
      { protocol: 'tcp', port: 8080, label: 'api', owners: [], occupied: false },
    ]);
  });
  it('sums counts', () => {
    expect(totalCount({ a: 2, b: 3 })).toBe(5);
    expect(totalCount(null)).toBe(0);
  });
});

describe('activity filters', () => {
  it('computes since for ranges', () => {
    expect(sinceFor('1h', NOW)).toBe(NOW - 3_600_000);
    expect(sinceFor('7d', NOW)).toBe(NOW - 7 * 86_400_000);
    expect(sinceFor('all', NOW)).toBeNull();
    expect(sinceFor('nope', NOW)).toBeNull();
  });
  it('builds a minimal event filter', () => {
    expect(buildEventFilter({ kinds: [], severity: '', search: '  ', port: '', range: 'all', projectId: '' }, NOW)).toEqual({});
    expect(
      buildEventFilter({ kinds: ['conflict'], severity: 'warning', search: ' node ', port: '3000', range: '24h', projectId: '7' }, NOW),
    ).toEqual({ kinds: ['conflict'], severity: 'warning', search: 'node', port: 3000, since: NOW - 86_400_000, projectId: 7 });
  });
  it('ignores invalid ports in the filter', () => {
    expect(buildEventFilter({ port: '70000', range: 'all' }, NOW).port).toBeUndefined();
    expect(buildEventFilter({ port: 'abc', range: 'all' }, NOW).port).toBeUndefined();
  });
  it('detects filtering', () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ since: 1 })).toBe(true);
  });
  it('validates the port filter input', () => {
    expect(portFilterError('')).toBeNull();
    expect(portFilterError('8080')).toBeNull();
    expect(portFilterError('0')).toMatch(/1–65535/);
    expect(portFilterError('70000')).toMatch(/1–65535/);
    expect(portFilterError('80a')).toMatch(/port number/);
  });
  it('matches live events against a filter', () => {
    const e = { kind: 'port_opened', severity: 'info', port: 3000, projectId: 2, ts: NOW, message: 'Port 3000 occupied', process: 'node.exe' };
    expect(eventMatchesFilter(e, {})).toBe(true);
    expect(eventMatchesFilter(e, { kinds: ['conflict'] })).toBe(false);
    expect(eventMatchesFilter(e, { kinds: ['port_opened'], port: 3000 })).toBe(true);
    expect(eventMatchesFilter(e, { severity: 'critical' })).toBe(false);
    expect(eventMatchesFilter(e, { projectId: 3 })).toBe(false);
    expect(eventMatchesFilter(e, { search: 'NODE' })).toBe(true);
    expect(eventMatchesFilter(e, { search: '3000' })).toBe(true);
    expect(eventMatchesFilter(e, { search: 'java' })).toBe(false);
    expect(eventMatchesFilter(e, { since: NOW + 1 })).toBe(false);
    expect(eventMatchesFilter(null, {})).toBe(false);
  });
});

describe('day grouping', () => {
  it('labels today and yesterday', () => {
    expect(dayLabel(NOW - 60_000, NOW)).toBe('Today');
    expect(dayLabel(new Date(2026, 10, 26, 23, 59).getTime(), NOW)).toBe('Yesterday');
    expect(dayLabel(new Date(2026, 10, 20, 12).getTime(), NOW)).not.toMatch(/Today|Yesterday/);
  });
  it('includes the year for other years', () => {
    expect(dayLabel(new Date(2025, 0, 2, 12).getTime(), NOW)).toMatch(/2025/);
  });
  it('groups consecutive events by local day', () => {
    const events = [
      { id: 1, ts: new Date(2026, 10, 27, 10).getTime() },
      { id: 2, ts: new Date(2026, 10, 27, 0, 1).getTime() },
      { id: 3, ts: new Date(2026, 10, 26, 23, 59).getTime() },
      { id: 4, ts: new Date(2026, 10, 20, 9).getTime() },
    ];
    const g = groupByDay(events, NOW);
    expect(g.map((x) => x.key)).toEqual(['2026-11-27', '2026-11-26', '2026-11-20']);
    expect(g[0].label).toBe('Today');
    expect(g[0].events.map((e) => e.id)).toEqual([1, 2]);
    expect(g[1].label).toBe('Yesterday');
    expect(groupByDay([], NOW)).toEqual([]);
  });
});

describe('settings helpers', () => {
  it('validates integers within limits', () => {
    expect(validateInt('2000', { min: 500, max: 60000 })).toEqual({ value: 2000, error: null });
    expect(validateInt(' 500 ', { min: 500, max: 60000 }).value).toBe(500);
    expect(validateInt('499', { min: 500, max: 60000 }).error).toMatch(/between 500 and 60,000/);
    expect(validateInt('1.5', { min: 1, max: 10 }).error).toMatch(/whole number/);
    expect(validateInt('', { min: 1, max: 10 }).error).toMatch(/whole number/);
    expect(validateInt(null, { min: 1, max: 10 }).error).toBeTruthy();
  });
  it('formats intervals', () => {
    expect(formatInterval(500)).toBe('500 ms');
    expect(formatInterval(2000)).toBe('2 s');
    expect(formatInterval(1500)).toBe('1.5 s');
    expect(formatInterval(90000)).toBe('90 s');
    expect(formatInterval(300000)).toBe('5 min');
    expect(formatInterval(null)).toBe('—');
  });
  it('builds import report rows', () => {
    expect(importRows({ imported: { projects: 2, reservations: 1, custom: 4 } })).toEqual([
      { kind: 'custom', label: 'custom', count: 4 },
      { kind: 'reservations', label: 'Personal reservations', count: 1 },
      { kind: 'projects', label: 'Projects', count: 2 },
    ]);
    expect(importRows(null)).toEqual([]);
  });
  it('maps updater errors to friendly messages', () => {
    expect(updateErrorMessage('Could not fetch a valid release JSON from the remote')).toMatch(/No published release/);
    expect(updateErrorMessage({ message: 'error sending request for url' })).toMatch(/internet connection/);
    expect(updateErrorMessage(new Error('signature verification failed'))).toMatch(/verified/);
    expect(updateErrorMessage('something odd')).toBe('something odd');
    expect(updateErrorMessage(undefined)).toMatch(/unknown/);
  });
});
