import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Card, Dot, Empty, Loading, Meter, PageHeader, ProcIcon, Sparkline, Stat, Toggle } from '../components/ui/primitives.jsx';
import { Modal } from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { api } from '../lib/api.js';
import { EVENT_LABEL, ago, duration, plural } from '../lib/format.js';
import { PROJECT_STATE, projectStatus, projectsInScope } from '../lib/domain.js';
import {
  CONFLICT_TONE,
  DASHBOARD_CARDS,
  EXPOSURE_LABEL,
  RANGE_LABEL,
  devServers,
  favoritePorts,
  formatInterval,
  lastEventByProject,
  recentProjects,
  sortByAttention,
  sortConflicts,
  statusCounts,
  toggleHidden,
  topProcesses,
  totalCount,
  uptime,
  utilization,
} from '../lib/overview.js';
import { useConfig, useData, useInspect, useNav, useSettings } from '../app/store.jsx';
import './Dashboard.css';

/** Row that behaves like a button (keyboard + mouse). */
function ClickRow({ onClick, children, label }) {
  return (
    <div
      className="list-item clickable"
      role="button"
      tabIndex={0}
      aria-label={label}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </div>
  );
}

function PortChip({ protocol = 'tcp', port }) {
  const { openPort } = useInspect();
  return (
    <button
      type="button"
      className="dash-port"
      title={`Open port ${port}`}
      onClick={(e) => {
        e.stopPropagation();
        openPort(protocol, port);
      }}
    >
      {port}
    </button>
  );
}

function BarRow({ label, value, max }) {
  return (
    <div className="dash-bar-row">
      <span className="truncate">{label}</span>
      <Meter value={value} max={max} />
      <span className="num mono">{value}</span>
    </div>
  );
}

// --------------------------------------------------------------- cards

function StatsCard({ stats, ts }) {
  const s = stats || {};
  return (
    <Card title="Live statistics" sub={ts ? `Last scan ${ago(ts)}` : 'Waiting for the first scan…'} className="dash-wide">
      <div className="dash-stats">
        <Stat icon="ports" label="Listening TCP" value={s.tcpListeners ?? '—'} />
        <Stat icon="layers" label="UDP bound" value={s.udpBound ?? '—'} />
        <Stat icon="connections" label="Established" value={s.established ?? '—'} hint={s.timeWait ? `${s.timeWait} in TIME_WAIT` : null} />
        <Stat icon="server" label="Dev servers" value={s.devServers ?? '—'} />
        <Stat icon="globe" label="Exposed listeners" value={s.exposed ?? '—'} hint="Bound to all interfaces" />
        <Stat icon="clock" label="Scan time" value={s.scanMs != null ? `${s.scanMs} ms` : '—'} />
      </div>
    </Card>
  );
}

function ConflictsCard({ conflicts }) {
  const { openPort } = useInspect();
  const { navigate } = useNav();
  const sorted = useMemo(() => sortConflicts(conflicts), [conflicts]);
  return (
    <Card
      flush
      className="dash-wide"
      title={
        <>
          Conflict alerts {sorted.length > 0 && <Badge tone={CONFLICT_TONE[sorted[0].severity]}>{sorted.length}</Badge>}
        </>
      }
    >
      {sorted.length === 0 ? (
        <Empty icon="checkCircle" title="No conflicts detected">
          Registered project ports, reservations and running listeners are consistent.
        </Empty>
      ) : (
        <div className="dash-list">
          {sorted.map((c) => (
            <div key={c.id} className="dash-conflict">
              <div className="row between wrap">
                <div className="row" style={{ minWidth: 0 }}>
                  <Badge tone={CONFLICT_TONE[c.severity]}>{c.severity === 'error' ? 'Error' : c.severity === 'warning' ? 'Warning' : 'Info'}</Badge>
                  <strong className="truncate">{c.title}</strong>
                </div>
                <div className="row">
                  {c.port != null && (
                    <Button size="sm" variant="ghost" icon="ports" onClick={() => openPort(c.protocol || 'tcp', c.port)}>
                      Port {c.port}
                    </Button>
                  )}
                  {c.projectIds?.length > 0 && (
                    <Button size="sm" variant="ghost" icon="projects" onClick={() => navigate('projects', { projectId: c.projectIds[0] })}>
                      Open project
                    </Button>
                  )}
                </div>
              </div>
              <div className="muted small" style={{ marginTop: 4 }}>
                {c.detail}
              </div>
              {c.suggestions?.length > 0 && (
                <ul>
                  {c.suggestions.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              )}
              {c.alternativePort && (
                <div className="small" style={{ marginTop: 4 }}>
                  Verified free alternative: <PortChip protocol={c.protocol || 'tcp'} port={c.alternativePort} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function DevServersCard({ processes, iconFor, now }) {
  const { openProcess } = useInspect();
  const list = useMemo(() => devServers(processes), [processes]);
  return (
    <Card flush title="Running development servers" sub={plural(list.length, 'server')}>
      {list.length === 0 ? (
        <Empty icon="server" title="No dev servers detected">
          Start a local server (Vite, Next.js, Django, …) and it will appear here.
        </Empty>
      ) : (
        <div className="dash-list">
          {list.map((p) => {
            const up = uptime(p.startTime, now);
            const icon = iconFor(p.pid);
            return (
              <ClickRow key={p.pid} onClick={() => openProcess(p.pid)} label={`Inspect ${p.name}`}>
                <ProcIcon src={icon} />
                <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
                  <span className="truncate">
                    {p.name} <span className="faint xs mono">PID {p.pid}</span>
                  </span>
                  <span className="xs faint">
                    {p.kind || 'Dev server'}
                    {up != null ? ` · up ${duration(up)}` : ''}
                  </span>
                </div>
                <div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                  {p.listenPorts.slice(0, 4).map((port) => (
                    <PortChip key={port} port={port} />
                  ))}
                  {p.listenPorts.length > 4 && <span className="xs faint">+{p.listenPorts.length - 4}</span>}
                </div>
              </ClickRow>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function HealthCard({ rows, profileName }) {
  const { navigate } = useNav();
  const { health } = useData();
  const counts = useMemo(() => statusCounts(rows.map((r) => r.status)), [rows]);
  const sorted = useMemo(() => sortByAttention(rows), [rows]);
  return (
    <Card
      flush
      title="Server health"
      sub={profileName ? `Profile: ${profileName}` : 'All projects'}
      actions={
        <Button size="sm" variant="ghost" icon="chevronRight" onClick={() => navigate('projects')}>
          Projects
        </Button>
      }
    >
      {rows.length === 0 ? (
        <Empty icon="projects" title="No projects in scope">
          Register projects and their ports on the Projects page to track their health.
        </Empty>
      ) : (
        <>
          <div className="dash-summary" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            {Object.entries(counts)
              .filter(([, n]) => n > 0)
              .map(([state, n]) => (
                <span key={state} className="row">
                  <Dot tone={PROJECT_STATE[state].tone} /> {n} {PROJECT_STATE[state].label.toLowerCase()}
                </span>
              ))}
          </div>
          <div className="dash-list">
            {sorted.map(({ project, status }) => {
              const latencies = status.ports.map((p) => health?.[p.pp.id]?.last?.latencyMs).filter((v) => v != null);
              const st = PROJECT_STATE[status.state];
              return (
                <ClickRow key={project.id} onClick={() => navigate('projects', { projectId: project.id })} label={`Open ${project.name}`}>
                  <Dot tone={st.tone} pulse={status.state === 'running'} />
                  <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
                    <span className="truncate">{project.name}</span>
                    <span className="xs faint">
                      {status.total ? `${status.up}/${status.total} ports up` : 'No ports registered'}
                      {latencies.length ? ` · ${Math.max(...latencies)} ms` : ''}
                    </span>
                  </div>
                  <Badge tone={st.tone}>{st.label}</Badge>
                </ClickRow>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}

function FavoritesCard({ favorites }) {
  const { openPort } = useInspect();
  return (
    <Card flush title="Favorite ports" sub={plural(favorites.length, 'favorite')}>
      {favorites.length === 0 ? (
        <Empty icon="star" title="No favorite ports">
          Star a port in its detail panel to keep an eye on it here.
        </Empty>
      ) : (
        <div className="dash-list">
          {favorites.map((f) => (
            <ClickRow key={`${f.protocol}:${f.port}`} onClick={() => openPort(f.protocol, f.port)} label={`Open port ${f.port}`}>
              <span className="port-num" style={{ minWidth: 52 }}>
                {f.port}
              </span>
              <span className="xs faint">{f.protocol.toUpperCase()}</span>
              <span className="truncate" style={{ flex: 1 }}>
                {f.label || <span className="faint">No label</span>}
              </span>
              {f.occupied ? (
                <Badge tone="info" title={f.owners.join(', ')}>
                  Occupied by {f.owners[0]}
                  {f.owners.length > 1 ? ` +${f.owners.length - 1}` : ''}
                </Badge>
              ) : (
                <Badge tone="ok">Free</Badge>
              )}
            </ClickRow>
          ))}
        </div>
      )}
    </Card>
  );
}

function InspectionsCard({ stats, error, procByPid }) {
  const { openProcess } = useInspect();
  const list = stats?.inspections || [];
  return (
    <Card flush title="Recently inspected processes">
      {error ? (
        <Empty icon="alert" title="Could not load history">
          {error.message}
        </Empty>
      ) : !stats ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty icon="eye" title="Nothing inspected yet">
          Processes you open in the inspector appear here.
        </Empty>
      ) : (
        <div className="dash-list">
          {list.slice(0, 10).map((i) => {
            const live = procByPid.get(i.pid);
            const running = live && live.name === i.name;
            return (
              <ClickRow key={`${i.pid}-${i.name}`} onClick={() => openProcess(i.pid)} label={`Inspect ${i.name}`}>
                <Dot tone={running ? 'ok' : ''} />
                <span className="truncate" style={{ flex: 1 }}>
                  {i.name} <span className="faint xs mono">PID {i.pid}</span>
                </span>
                {!running && <span className="xs faint">not listening</span>}
                <span className="xs faint">{ago(i.ts)}</span>
              </ClickRow>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function RecentProjectsCard({ rows }) {
  const { navigate } = useNav();
  return (
    <Card flush title="Recently monitored projects">
      {rows.length === 0 ? (
        <Empty icon="projects" title="No projects yet" />
      ) : (
        <div className="dash-list">
          {rows.map(({ project, ts, status }) => {
            const st = PROJECT_STATE[status.state];
            return (
              <ClickRow key={project.id} onClick={() => navigate('projects', { projectId: project.id })} label={`Open ${project.name}`}>
                <Dot tone={st.tone} />
                <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
                  <span className="truncate">{project.name}</span>
                  <span className="xs faint">{project.groupName || 'Ungrouped'}</span>
                </div>
                <span className="xs faint">{ts ? ago(ts) : '—'}</span>
                <Badge tone={st.tone}>{st.label}</Badge>
              </ClickRow>
            );
          })}
        </div>
      )}
    </Card>
  );
}

function UtilizationCard({ ports, processes }) {
  const { openProcess } = useInspect();
  const u = useMemo(() => utilization(ports), [ports]);
  const top = useMemo(() => topProcesses(processes, 5), [processes]);
  return (
    <Card title="Port utilization" sub={`${u.total} ports · ${u.byProtocol.tcp} TCP · ${u.byProtocol.udp} UDP`}>
      {u.total === 0 ? (
        <Empty icon="ports" title="No listening ports" />
      ) : (
        <div className="stack">
          <div className="stack tight">
            <div className="section-title">By range</div>
            {Object.entries(u.byRange).map(([k, v]) => (
              <BarRow key={k} label={RANGE_LABEL[k]} value={v} max={u.total} />
            ))}
          </div>
          <div className="stack tight">
            <div className="section-title">By exposure</div>
            {Object.entries(u.byExposure).map(([k, v]) => (
              <BarRow key={k} label={EXPOSURE_LABEL[k]} value={v} max={u.total} />
            ))}
          </div>
          {top.length > 0 && (
            <div className="stack tight">
              <div className="section-title">Top processes by ports</div>
              {top.map((p) => (
                <button
                  key={p.pid}
                  type="button"
                  className="dash-bar-row dash-bar-btn"
                  title={`Inspect ${p.name}`}
                  onClick={() => openProcess(p.pid)}
                >
                  <span className="truncate">{p.name}</span>
                  <Meter value={p.count} max={top[0].count} />
                  <span className="num mono">{p.count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ActivityCard({ stats, error, monitoring }) {
  const { navigate } = useNav();
  const counts = Object.entries(stats?.counts || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  return (
    <Card
      title="Monitoring activity"
      sub="Last 24 hours"
      actions={
        <Button size="sm" variant="ghost" icon="chevronRight" onClick={() => navigate('activity')}>
          Activity
        </Button>
      }
    >
      <div className="stack">
        <div className="row small">
          <Dot tone={monitoring?.paused ? 'warn' : 'ok'} pulse={!monitoring?.paused} />
          {monitoring ? (
            <span>
              Monitoring: interval {formatInterval(monitoring.intervalMs)}
              {monitoring.paused ? ' (paused)' : ''}
              <span className="faint"> · background {formatInterval(monitoring.backgroundIntervalMs)}</span>
            </span>
          ) : (
            <span className="faint">Loading settings…</span>
          )}
        </div>
        {error ? (
          <span className="small faint">Activity history unavailable: {error.message}</span>
        ) : !stats ? (
          <Loading />
        ) : (
          <>
            <Sparkline values={stats.hourly || []} height={48} title="Events per hour over the last 24 hours" />
            <div className="row between xs faint">
              <span>24 h ago</span>
              <span>{plural(totalCount(stats.counts), 'event')}</span>
              <span>now</span>
            </div>
            {counts.length > 0 ? (
              <div className="dash-summary">
                {counts.map(([kind, n]) => (
                  <span key={kind}>
                    {EVENT_LABEL[kind] || kind} <span className="mono">{n}</span>
                  </span>
                ))}
              </div>
            ) : (
              <span className="small faint">No events recorded in the last 24 hours.</span>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- page

function CustomizeModal({ hidden, onToggle, onClose, onReset }) {
  return (
    <Modal
      title="Customize dashboard"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onReset} disabled={!hidden.length}>
            Show all
          </Button>
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <div className="dash-customize">
        {DASHBOARD_CARDS.map((c) => (
          <div key={c.id} className="setting-row">
            <div className="setting-text">
              <span>{c.label}</span>
              <span className="setting-desc">{c.desc}</span>
            </div>
            <Toggle checked={!hidden.includes(c.id)} onChange={() => onToggle(c.id)} label={`Show ${c.label}`} />
          </div>
        ))}
      </div>
    </Modal>
  );
}

export default function Dashboard() {
  const { snapshot, conflicts, health, procByPid, iconFor, eventSeq, refresh } = useData();
  const { projects, profiles, notes, loaded } = useConfig();
  const { settings, saveSettings } = useSettings();
  const toast = useToast();
  const [stats, setStats] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [recentEvents, setRecentEvents] = useState([]);
  const [customizing, setCustomizing] = useState(false);

  const loadActivity = useCallback(() => {
    api
      .activityStats(24)
      .then((s) => {
        setStats(s);
        setStatsError(null);
      })
      .catch(setStatsError);
    api
      .events({ limit: 300 })
      .then((p) => setRecentEvents(p.events || []))
      .catch(() => {});
  }, []);

  // Initial load, then a debounced refresh whenever a new event is recorded.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      loadActivity();
      return undefined;
    }
    const t = setTimeout(loadActivity, 1000);
    return () => clearTimeout(t);
  }, [eventSeq, loadActivity]);

  // Uptimes are measured against the latest scan, so they tick with the monitor.
  const now = snapshot.ts;

  const activeProfileId = settings?.general?.activeProfileId ?? null;
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || null;
  const scoped = useMemo(() => projectsInScope(projects, profiles, activeProfileId), [projects, profiles, activeProfileId]);
  const statusRows = useMemo(
    () => scoped.map((project) => ({ project, status: projectStatus(project, snapshot, health, procByPid) })),
    [scoped, snapshot, health, procByPid],
  );
  const statusById = useMemo(() => new Map(statusRows.map((r) => [r.project.id, r.status])), [statusRows]);
  const recent = useMemo(
    () => recentProjects(scoped, lastEventByProject(recentEvents), 6).map((r) => ({ ...r, status: statusById.get(r.project.id) })),
    [scoped, recentEvents, statusById],
  );
  const favorites = useMemo(() => favoritePorts(notes, snapshot.ports, procByPid), [notes, snapshot.ports, procByPid]);

  const hidden = settings?.general?.hiddenCards || [];
  const show = (id) => !hidden.includes(id);
  const saveHidden = async (hiddenCards) => {
    if (!settings) return;
    try {
      await saveSettings({ ...settings, general: { ...settings.general, hiddenCards } });
    } catch (e) {
      toast.fail('Could not save dashboard layout', e);
    }
  };

  const visibleCount = DASHBOARD_CARDS.filter((c) => show(c.id)).length;
  const ready = snapshot.seq > 0;

  return (
    <div className="page">
      <PageHeader
        title="Dashboard"
        sub={
          activeProfile ? (
            <>
              Active profile: <strong>{activeProfile.name}</strong> · {plural(scoped.length, 'project')} in scope
            </>
          ) : (
            `No active profile · showing all ${plural(projects.length, 'project')}`
          )
        }
        actions={
          <>
            <Button icon="refresh" onClick={() => (refresh(), loadActivity())}>
              Refresh
            </Button>
            <Button icon="layers" onClick={() => setCustomizing(true)} disabled={!settings}>
              Customize
            </Button>
          </>
        }
      />

      {!ready && !loaded ? (
        <Loading label="Collecting the first snapshot…" />
      ) : visibleCount === 0 ? (
        <Card>
          <Empty icon="layers" title="All cards are hidden" action={<Button onClick={() => setCustomizing(true)}>Customize</Button>} />
        </Card>
      ) : (
        <div className="dash-grid" style={{ marginTop: 0 }}>
          {show('stats') && <StatsCard stats={ready ? snapshot.stats : null} ts={snapshot.ts} />}
          {show('conflicts') && <ConflictsCard conflicts={conflicts} />}
          {show('devServers') && <DevServersCard processes={snapshot.processes} iconFor={iconFor} now={now} />}
          {show('health') && <HealthCard rows={statusRows} profileName={activeProfile?.name} />}
          {show('favorites') && <FavoritesCard favorites={favorites} />}
          {show('inspections') && <InspectionsCard stats={stats} error={statsError} procByPid={procByPid} />}
          {show('recentProjects') && <RecentProjectsCard rows={recent} />}
          {show('utilization') && <UtilizationCard ports={snapshot.ports} processes={snapshot.processes} />}
          {show('activity') && <ActivityCard stats={stats} error={statsError} monitoring={settings?.monitoring} />}
        </div>
      )}

      {customizing && (
        <CustomizeModal
          hidden={hidden}
          onToggle={(id) => saveHidden(toggleHidden(hidden, id))}
          onReset={() => saveHidden([])}
          onClose={() => setCustomizing(false)}
        />
      )}
    </div>
  );
}
