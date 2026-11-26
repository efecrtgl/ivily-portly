import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Button, Callout, Card, Chip, Empty, Field, Loading, PageHeader, SearchInput, Segmented, Select } from '../components/ui/primitives.jsx';
import { useConfirm } from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { api } from '../lib/api.js';
import { EVENT_LABEL, plural, time } from '../lib/format.js';
import {
  EVENT_SEVERITY_TONE,
  TIME_RANGES,
  buildEventFilter,
  eventMatchesFilter,
  groupByDay,
  isFiltered,
  portFilterError,
} from '../lib/overview.js';
import { useConfig, useData, useInspect, useNav, useSettings } from '../app/store.jsx';
import './Activity.css';

const PAGE = 100;
const KINDS = Object.keys(EVENT_LABEL);
const SEVERITIES = [
  { value: '', label: 'Any severity' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'critical', label: 'Critical' },
];
const INITIAL = { kinds: [], severity: '', search: '', port: '', range: '24h', projectId: '' };

function useDebounced(value, ms) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function EventRow({ e, projectName }) {
  const { openPort, openProcess } = useInspect();
  const { navigate } = useNav();
  return (
    <li className="act-row">
      <span className="mono xs faint act-time">{time(e.ts)}</span>
      <span className="act-kind">
        <Badge tone={EVENT_SEVERITY_TONE[e.severity] || ''}>{EVENT_LABEL[e.kind] || e.kind}</Badge>
      </span>
      <span className="act-msg selectable">{e.message}</span>
      <span className="act-meta row">
        {e.port != null && (
          <button type="button" className="act-link mono" onClick={() => openPort(e.protocol || 'tcp', e.port)} title={`Open port ${e.port}`}>
            {e.protocol ? `${e.protocol.toUpperCase()} ` : ''}
            {e.port}
          </button>
        )}
        {e.pid != null && (
          <button
            type="button"
            className="act-link"
            onClick={() => openProcess(e.pid)}
            title="Inspect process (it may have exited since this event)"
          >
            {e.process || 'Process'} <span className="mono faint">{e.pid}</span>
          </button>
        )}
        {e.pid == null && e.process && <span className="faint">{e.process}</span>}
        {e.projectId != null && (
          <button type="button" className="act-link" onClick={() => navigate('projects', { projectId: e.projectId })}>
            {projectName || `Project #${e.projectId}`}
          </button>
        )}
      </span>
    </li>
  );
}

function RetentionCard({ history }) {
  const { navigate } = useNav();
  return (
    <Card
      title="Privacy & retention"
      actions={
        <Button size="sm" variant="ghost" icon="settings" onClick={() => navigate('settings')}>
          Settings
        </Button>
      }
    >
      {!history ? (
        <Loading />
      ) : (
        <dl className="kv">
          <dt>History</dt>
          <dd>{history.enabled ? 'Recording' : <Badge tone="warn">Paused</Badge>}</dd>
          <dt>Retention</dt>
          <dd>{plural(history.retentionDays, 'day')}</dd>
          <dt>Maximum</dt>
          <dd>{history.maxEvents.toLocaleString()} events</dd>
          <dt>Port events</dt>
          <dd>{history.recordAllPorts ? 'All ports' : 'Registered, favorite, reserved and planned ports only'}</dd>
          <dt>Executable paths</dt>
          <dd>{history.storePaths ? 'Stored with events' : 'Not stored'}</dd>
        </dl>
      )}
      <p className="xs faint" style={{ marginTop: 12 }}>
        History is stored only on this computer. Nothing is sent over the network.
      </p>
    </Card>
  );
}

export default function Activity() {
  const { eventSeq, lastEvent } = useData();
  const { projects } = useConfig();
  const { settings } = useSettings();
  const confirm = useConfirm();
  const toast = useToast();

  const [ui, setUi] = useState(INITIAL);
  const search = useDebounced(ui.search, 300);
  const portRaw = useDebounced(ui.port, 300);
  const portError = portFilterError(ui.port);
  const { kinds, severity, range, projectId } = ui;
  const query = useMemo(
    () => ({ kinds, severity, range, projectId, search, port: portFilterError(portRaw) ? '' : portRaw }),
    [kinds, severity, range, projectId, search, portRaw],
  );

  const [events, setEvents] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [pendingLive, setPendingLive] = useState(false);
  const token = useRef(0);

  const load = useCallback(async (q, offset = 0) => {
    const id = ++token.current;
    const filter = { ...buildEventFilter(q), limit: PAGE, offset };
    if (offset === 0) setLoading(true);
    else setLoadingMore(true);
    try {
      const page = await api.events(filter);
      if (id !== token.current) return;
      setEvents((prev) => (offset === 0 ? page.events : [...prev, ...page.events]));
      setTotal(page.total);
      setError(null);
      if (offset === 0) setPendingLive(false);
    } catch (e) {
      if (id === token.current) setError(e);
    } finally {
      if (id === token.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    load(query, 0);
  }, [query, load]);

  // Live updates: refresh page 1 when a matching event arrives; if the user
  // has paged further, offer a manual refresh instead of shifting the list.
  const lastSeq = useRef(eventSeq);
  const pagedFurther = events.length > PAGE;
  useEffect(() => {
    if (eventSeq === lastSeq.current) return undefined;
    lastSeq.current = eventSeq;
    if (!lastEvent || !eventMatchesFilter(lastEvent, buildEventFilter(query))) return undefined;
    if (pagedFurther) {
      const t = setTimeout(() => setPendingLive(true), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => load(query, 0), 400);
    return () => clearTimeout(t);
  }, [eventSeq, lastEvent, query, pagedFurther, load]);

  const projectName = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);
  const groups = useMemo(() => groupByDay(events), [events]);
  const filtered = isFiltered(buildEventFilter(query));

  const set = (patch) => setUi((s) => ({ ...s, ...patch }));
  const toggleKind = (k) => set({ kinds: ui.kinds.includes(k) ? ui.kinds.filter((x) => x !== k) : [...ui.kinds, k] });

  const clear = async (all) => {
    const filter = all ? {} : buildEventFilter(query);
    const ok = await confirm({
      title: all ? 'Clear all activity history?' : 'Clear filtered events?',
      body: all
        ? 'Every recorded event will be permanently deleted from this computer. This cannot be undone.'
        : `All ${plural(total, 'event')} matching the current filters will be permanently deleted. This cannot be undone.`,
      confirmLabel: all ? 'Clear all' : 'Clear filtered',
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.eventsClear(filter);
      toast.ok('History cleared', `${plural(n, 'event')} removed.`);
      load(query, 0);
    } catch (e) {
      toast.fail('Could not clear history', e);
    }
  };

  const projectOptions = [{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: String(p.id), label: p.name }))];

  return (
    <div className="page">
      <PageHeader
        title="Activity"
        sub="Persistent history of port, process, server and configuration events."
        actions={
          <>
            <Button icon="refresh" onClick={() => load(query, 0)}>
              Refresh
            </Button>
            {filtered && (
              <Button icon="filter" onClick={() => clear(false)} disabled={!total}>
                Clear filtered
              </Button>
            )}
            <Button variant="danger" icon="trash" onClick={() => clear(true)}>
              Clear all
            </Button>
          </>
        }
      />

      <div className="act-layout">
        <div className="stack" style={{ minWidth: 0 }}>
          <Card>
            <div className="stack">
              <div className="row wrap" role="group" aria-label="Event kinds">
                {KINDS.map((k) => (
                  <Chip key={k} pressed={ui.kinds.includes(k)} onClick={() => toggleKind(k)}>
                    {EVENT_LABEL[k]}
                  </Chip>
                ))}
                {ui.kinds.length > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => set({ kinds: [] })}>
                    Any kind
                  </Button>
                )}
              </div>
              <div className="row wrap act-filters">
                <SearchInput value={ui.search} onChange={(v) => set({ search: v })} placeholder="Search messages, processes, ports…" width={260} />
                <Field error={portError}>
                  <input
                    className="input mono"
                    inputMode="numeric"
                    placeholder="Port"
                    aria-label="Filter by port"
                    value={ui.port}
                    onChange={(e) => set({ port: e.target.value })}
                    style={{ width: 90 }}
                  />
                </Field>
                <Select ariaLabel="Severity" value={ui.severity} onChange={(v) => set({ severity: v })} options={SEVERITIES} />
                <Select ariaLabel="Project" value={ui.projectId} onChange={(v) => set({ projectId: v })} options={projectOptions} />
                <Segmented
                  ariaLabel="Time range"
                  value={ui.range}
                  onChange={(v) => set({ range: v })}
                  options={TIME_RANGES.map((r) => ({ value: r.value, label: r.label }))}
                />
                {JSON.stringify(ui) !== JSON.stringify(INITIAL) && (
                  <Button size="sm" variant="ghost" onClick={() => setUi(INITIAL)}>
                    Reset filters
                  </Button>
                )}
              </div>
            </div>
          </Card>

          {pendingLive && (
            <Callout tone="info" title="New events recorded">
              <Button size="sm" onClick={() => load(query, 0)}>
                Show latest
              </Button>
            </Callout>
          )}

          <Card flush title="Events" sub={loading ? 'Loading…' : `${events.length.toLocaleString()} of ${plural(total, 'event')}`}>
            {error ? (
              <div style={{ padding: 16 }}>
                <Callout tone="danger" title="Could not load events">
                  {error.message}
                </Callout>
              </div>
            ) : loading && !events.length ? (
              <Loading />
            ) : !events.length ? (
              <Empty icon="history" title={filtered ? 'No matching events' : 'No events recorded yet'}>
                {filtered
                  ? 'Try a wider time range or fewer filters.'
                  : 'Port changes, server status changes and configuration changes will appear here.'}
              </Empty>
            ) : (
              <div aria-busy={loading}>
                {groups.map((g) => (
                  <section key={g.key}>
                    <h3 className="act-day">
                      {g.label} <span className="faint xs">{g.events.length}</span>
                    </h3>
                    <ul className="act-list">
                      {g.events.map((e) => (
                        <EventRow key={e.id} e={e} projectName={projectName.get(e.projectId)} />
                      ))}
                    </ul>
                  </section>
                ))}
                {events.length < total && (
                  <div className="row" style={{ justifyContent: 'center', padding: 12 }}>
                    <Button onClick={() => load(query, events.length)} disabled={loadingMore}>
                      {loadingMore ? 'Loading…' : `Load more (${(total - events.length).toLocaleString()} remaining)`}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="stack">
          <RetentionCard history={settings?.history} />
        </div>
      </div>
    </div>
  );
}
