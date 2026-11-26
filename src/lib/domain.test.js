import { describe, expect, it } from 'vitest';
import { conflictsFor, noteFor, projectStatus, projectsInScope, usageIndex, worstSeverity } from './domain.js';

const snap = {
  ports: [
    { protocol: 'tcp', port: 3000, pids: [10], bindings: [] },
    { protocol: 'tcp', port: 8080, pids: [11], bindings: [] },
  ],
};
const procs = new Map([
  [10, { pid: 10, name: 'node.exe' }],
  [11, { pid: 11, name: 'java.exe' }],
]);
const pp = (id, port, extra = {}) => ({ id, port, protocol: 'tcp', checkKind: 'tcp', ...extra });

describe('projectStatus', () => {
  it('running when every health check passes', () => {
    const p = { ports: [pp(1, 3000)] };
    const s = projectStatus(p, snap, { 1: { last: { status: 'up' } } }, procs);
    expect(s.state).toBe('running');
    expect(s.ports[0].owners[0].name).toBe('node.exe');
  });

  it('partial and stopped', () => {
    const p = { ports: [pp(1, 3000), pp(2, 4000)] };
    expect(projectStatus(p, snap, { 1: { last: { status: 'up' } }, 2: { last: { status: 'down' } } }, procs).state).toBe('partial');
    expect(projectStatus(p, snap, {}, procs).state).toBe('stopped');
  });

  it('unchecked ports use occupancy', () => {
    const p = { ports: [pp(1, 3000, { checkKind: 'none' })] };
    expect(projectStatus(p, snap, {}, procs).state).toBe('running');
  });

  it('expected process mismatch is a conflict', () => {
    const p = { ports: [pp(1, 8080, { expectedProcess: 'node' })] };
    const s = projectStatus(p, snap, { 1: { last: { status: 'up' } } }, procs);
    expect(s.state).toBe('conflict');
    expect(s.ports[0].unexpected).toBe(true);
    const ok = projectStatus({ ports: [pp(1, 3000, { expectedProcess: 'NODE.EXE' })] }, snap, {}, procs);
    expect(ok.ports[0].unexpected).toBe(false);
  });

  it('empty project', () => {
    expect(projectStatus({ ports: [] }, snap, {}, procs).state).toBe('empty');
  });
});

describe('helpers', () => {
  it('indexes usage and notes', () => {
    expect(usageIndex(snap).get('tcp:8080').pids).toEqual([11]);
    expect(noteFor([{ protocol: 'tcp', port: 1, label: 'x' }], 'tcp', 1).label).toBe('x');
    expect(noteFor([], 'tcp', 1)).toBeNull();
  });

  it('filters conflicts', () => {
    const cs = [
      { id: 'a', severity: 'warning', projectIds: [1], pids: [], port: 3000, protocol: 'tcp' },
      { id: 'b', severity: 'error', projectIds: [], pids: [9], port: 9000, protocol: 'tcp' },
    ];
    expect(conflictsFor(cs, { projectId: 1 }).map((c) => c.id)).toEqual(['a']);
    expect(conflictsFor(cs, { pid: 9 }).map((c) => c.id)).toEqual(['b']);
    expect(conflictsFor(cs, { protocol: 'tcp', port: 3000 }).map((c) => c.id)).toEqual(['a']);
    expect(worstSeverity(cs)).toBe('error');
    expect(worstSeverity([])).toBeNull();
  });

  it('scopes projects to the active profile', () => {
    const ps = [{ id: 1 }, { id: 2 }];
    expect(projectsInScope(ps, [{ id: 5, projectIds: [2] }], 5)).toEqual([{ id: 2 }]);
    expect(projectsInScope(ps, [], null)).toEqual(ps);
    expect(projectsInScope(ps, [], 99)).toEqual(ps);
  });
});
