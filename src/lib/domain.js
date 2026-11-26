// Pure domain helpers shared by pages. No React, no IPC.

export const portKey = (protocol, port) => `${protocol}:${port}`;

/** Map "tcp:3000" → PortUsage from a snapshot. */
export function usageIndex(snapshot) {
  const m = new Map();
  for (const u of snapshot?.ports || []) m.set(portKey(u.protocol, u.port), u);
  return m;
}

export function noteFor(notes, protocol, port) {
  return (notes || []).find((n) => n.protocol === protocol && n.port === port) || null;
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\.exe$/, '');

/**
 * Runtime status of one project.
 * Returns { state, ports: [{ pp, usage, owners, health, up, unexpected }], up, total }
 * state: 'running' | 'partial' | 'stopped' | 'conflict' | 'empty'
 * A port counts as "up" when its health check passes, or — for ports without a
 * health check — when something is listening on it.
 */
export function projectStatus(project, snapshot, health, procByPid) {
  const idx = usageIndex(snapshot);
  const ports = (project.ports || []).map((pp) => {
    const usage = idx.get(portKey(pp.protocol, pp.port)) || null;
    const owners = usage ? usage.pids.map((pid) => procByPid?.get(pid) || { pid, name: `PID ${pid}` }) : [];
    const h = health?.[pp.id] || health?.[String(pp.id)] || null;
    const status = h?.last?.status;
    const up = pp.checkKind === 'none' ? !!usage : status === 'up' || status === 'degraded';
    const unexpected = !!(usage && pp.expectedProcess && !owners.some((o) => norm(o.name) === norm(pp.expectedProcess)));
    return { pp, usage, owners, health: h, up, unexpected };
  });
  const up = ports.filter((p) => p.up).length;
  let state = 'empty';
  if (ports.length) state = up === ports.length ? 'running' : up > 0 ? 'partial' : 'stopped';
  if (ports.some((p) => p.unexpected)) state = 'conflict';
  return { state, ports, up, total: ports.length };
}

export const PROJECT_STATE = {
  running: { label: 'Running', tone: 'ok' },
  partial: { label: 'Partially running', tone: 'warn' },
  stopped: { label: 'Stopped', tone: '' },
  conflict: { label: 'Port conflict', tone: 'danger' },
  empty: { label: 'No ports', tone: '' },
};

/** Conflicts relevant to a project, a port or a process. */
export function conflictsFor(conflicts, { projectId, protocol, port, pid } = {}) {
  return (conflicts || []).filter(
    (c) =>
      (projectId != null && c.projectIds?.includes(projectId)) ||
      (port != null && c.port === port && (!protocol || !c.protocol || c.protocol === protocol)) ||
      (pid != null && c.pids?.includes(pid)),
  );
}

export function worstSeverity(conflicts) {
  if (conflicts.some((c) => c.severity === 'error')) return 'error';
  if (conflicts.some((c) => c.severity === 'warning')) return 'warning';
  return conflicts.length ? 'info' : null;
}

/** Projects included by the active profile (all projects when none active). */
export function projectsInScope(projects, profiles, activeProfileId) {
  if (!activeProfileId) return projects;
  const p = (profiles || []).find((x) => x.id === activeProfileId);
  if (!p) return projects;
  const ids = new Set(p.projectIds);
  return projects.filter((x) => ids.has(x.id));
}
