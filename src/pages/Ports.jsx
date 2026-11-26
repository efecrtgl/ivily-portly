import { useCallback, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Callout, Card, Empty, Loading, PageHeader, ProcIcon, SearchInput, Segmented, Select, Toggle } from '../components/ui/primitives.jsx';
import Table from '../components/ui/Table.jsx';
import Icon from '../components/ui/Icon.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { useConfig, useData, useInspect } from '../app/store.jsx';
import { api } from '../lib/api.js';
import { SCOPE_LABEL, SCOPE_TONE, plural } from '../lib/format.js';
import { worstSeverity } from '../lib/domain.js';
import {
  DEFAULT_PORT_FILTERS,
  PORT_GROUPS,
  PORT_SORTS,
  buildPortRows,
  explorePorts,
  freshKeys,
  nextFreshExpiry,
  parseCheckPort,
  portStats,
  restoreFilters,
  trackAppeared,
} from '../lib/explore.js';
import './Ports.css';

const STORAGE_KEY = 'portly.ports.filters';

function loadFilters() {
  try {
    return restoreFilters(JSON.parse(localStorage.getItem(STORAGE_KEY)), DEFAULT_PORT_FILTERS);
  } catch {
    return { ...DEFAULT_PORT_FILTERS };
  }
}

const PROTOCOLS = [
  { value: 'all', label: 'All' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
];
const EXPOSURES = [
  { value: 'all', label: 'Any exposure' },
  { value: 'loopback', label: 'Localhost only' },
  { value: 'all_interfaces', label: 'All interfaces' },
  { value: 'specific', label: 'Specific / link-local' },
];
const SORT_OPTIONS = Object.entries(PORT_SORTS).map(([value, s]) => ({ value, label: `Sort: ${s.label}` }));
const GROUP_OPTIONS = Object.entries(PORT_GROUPS).map(([value, g]) => ({ value, label: value === 'none' ? 'No grouping' : `Group: ${g.label}` }));
const TOGGLES = [
  ['favorites', 'Favorites only'],
  ['registered', 'Registered only'],
  ['hideDynamic', 'Hide dynamic range (49152+)'],
  ['devOnly', 'Dev servers only'],
];
const SEVERITY_BADGE = { error: 'danger', warning: 'warn', info: 'info' };

export default function Ports() {
  const { snapshot, procByPid, iconFor, conflicts, refresh } = useData();
  const { notes, projects } = useConfig();
  const { openPort, openProcess } = useInspect();

  const [f, setF] = useState(loadFilters);
  const set = useCallback((patch) => setF((prev) => ({ ...prev, ...patch })), []);
  useEffect(() => {
    try {
      // The search text is intentionally not persisted.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...f, q: '' }));
    } catch {
      /* storage unavailable — filters simply reset next time */
    }
  }, [f]);

  // "Newly appeared" tracking across snapshots.
  const [appeared, setAppeared] = useState({ known: null, fresh: {} });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!snapshot.seq) return;
    const t = Date.now();
    setAppeared((prev) => trackAppeared(prev, snapshot.ports, t));
    setNow(t);
  }, [snapshot.seq, snapshot.ports]);
  useEffect(() => {
    const ms = nextFreshExpiry(appeared.fresh, now);
    if (ms == null) return undefined;
    const id = setTimeout(() => setNow(Date.now()), ms + 50);
    return () => clearTimeout(id);
  }, [appeared.fresh, now]);
  const fresh = useMemo(() => freshKeys(appeared.fresh, now), [appeared.fresh, now]);

  const allRows = useMemo(
    () => buildPortRows(snapshot.ports, { procByPid, notes, projects, conflicts }),
    [snapshot.ports, procByPid, notes, projects, conflicts],
  );
  const rows = useMemo(() => explorePorts(allRows, f), [allRows, f]);
  const stats = useMemo(() => portStats(snapshot.ports), [snapshot.ports]);
  const groupOf = PORT_GROUPS[f.group]?.of || undefined;
  const filtered = rows.length !== allRows.length;

  const columns = [
    {
      key: 'port',
      label: 'Port',
      width: 110,
      sortable: false,
      render: (r) => (
        <span className={`row ${fresh.has(r.key) ? 'explore-fresh' : ''}`} style={{ gap: 6 }}>
          <span className="port-num">{r.port}</span>
          {r.note?.favorite && (
            <span title="Favorite port" aria-label="Favorite port" style={{ display: 'inline-flex' }}>
              <Icon name="star-filled" size={12} />
            </span>
          )}
          {fresh.has(r.key) && <Badge tone="info">New</Badge>}
        </span>
      ),
    },
    { key: 'protocol', label: 'Proto', width: 64, sortable: false, render: (r) => <span className="xs muted">{r.protocol.toUpperCase()}</span> },
    {
      key: 'process',
      label: 'Process',
      sortable: false,
      render: (r) => {
        const o = r.owners[0];
        if (!o) return <span className="faint">Unknown</span>;
        return (
          <span className="row" style={{ gap: 6, minWidth: 0 }}>
            <button
              type="button"
              className="explore-proc-btn"
              title={`Inspect ${o.name} (PID ${o.pid})`}
              onClick={(e) => {
                e.stopPropagation();
                openProcess(o.pid);
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <ProcIcon src={iconFor(o.pid)} />
              <span className="truncate">{o.name}</span>
              <span className="mono faint xs">{o.pid}</span>
            </button>
            {r.owners.length > 1 && (
              <span className="xs faint" title={r.owners.slice(1).map((x) => `${x.name} (${x.pid})`).join(', ')}>
                +{r.owners.length - 1}
              </span>
            )}
          </span>
        );
      },
    },
    {
      key: 'bindings',
      label: 'Bindings',
      sortable: false,
      render: (r) => {
        const seen = new Set();
        const list = r.usage.bindings.filter((b) => !seen.has(b.addr) && seen.add(b.addr));
        return (
          <span className="explore-addr">
            {list.slice(0, 3).map((b) => (
              <span key={b.addr}>
                {b.addr}
                <span className="fam">{b.family === 'ipv6' ? 'IPv6' : 'IPv4'}</span>
              </span>
            ))}
            {list.length > 3 && <span className="xs faint">+{list.length - 3} more</span>}
          </span>
        );
      },
    },
    {
      key: 'exposure',
      label: 'Exposure',
      sortable: false,
      render: (r) => <Badge tone={SCOPE_TONE[r.usage.exposure]}>{SCOPE_LABEL[r.usage.exposure] || r.usage.exposure}</Badge>,
    },
    {
      key: 'label',
      label: 'Label',
      sortable: false,
      render: (r) =>
        r.note?.label ? (
          <span className="truncate" title={r.note.note || r.note.label}>{r.note.label}</span>
        ) : r.usage.wellKnown ? (
          <span className="faint small" title="Common use of this port number">{r.usage.wellKnown}</span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'project',
      label: 'Project',
      sortable: false,
      render: (r) =>
        r.projects.length ? (
          <span className="truncate" title={r.projects.map((p) => p.name).join(', ')}>
            {r.projects[0].name}
            {r.projects.length > 1 && <span className="faint xs"> +{r.projects.length - 1}</span>}
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
    {
      key: 'conflict',
      label: 'Conflict',
      width: 90,
      sortable: false,
      render: (r) => {
        const sev = worstSeverity(r.conflicts);
        if (!sev) return <span className="faint">—</span>;
        return (
          <Badge tone={SEVERITY_BADGE[sev]} icon="alert" title={r.conflicts.map((c) => c.title).join('\n')}>
            {r.conflicts.length}
          </Badge>
        );
      },
    },
    {
      key: 'connections',
      label: 'Conns',
      num: true,
      width: 70,
      sortable: false,
      render: (r) => (r.protocol === 'tcp' ? <span className="mono">{r.usage.connections}</span> : <span className="faint">—</span>),
    },
  ];

  const waiting = !snapshot.seq;

  return (
    <div className="page">
      <PageHeader
        title="Ports"
        sub={
          waiting
            ? 'Live listening TCP ports and bound UDP ports.'
            : `${plural(stats.tcp, 'TCP port')} listening · ${plural(stats.udp, 'UDP port')} bound · ${stats.exposed} exposed on all interfaces`
        }
        actions={
          <Button icon="refresh" onClick={refresh}>
            Refresh
          </Button>
        }
      />

      <PortCheck />

      {waiting ? (
        <Card>
          <Loading label="Waiting for the first monitoring scan…" />
        </Card>
      ) : (
        <>
          <div className="toolbar">
            <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="Search port, process, address, label…" width={280} />
            <Segmented value={f.protocol} onChange={(protocol) => set({ protocol })} options={PROTOCOLS} ariaLabel="Protocol" />
            <Select value={f.exposure} onChange={(exposure) => set({ exposure })} options={EXPOSURES} ariaLabel="Exposure" />
            <span className="spacer" />
            <Select value={f.sort} onChange={(sort) => set({ sort })} options={SORT_OPTIONS} ariaLabel="Sort by" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => set({ dir: f.dir === 'asc' ? 'desc' : 'asc' })}
              aria-label={f.dir === 'asc' ? 'Sorted ascending — switch to descending' : 'Sorted descending — switch to ascending'}
              title={f.dir === 'asc' ? 'Ascending' : 'Descending'}
            >
              {f.dir === 'asc' ? '↑ Asc' : '↓ Desc'}
            </Button>
            <Select value={f.group} onChange={(group) => set({ group })} options={GROUP_OPTIONS} ariaLabel="Group by" />
          </div>
          <div className="explore-toggles">
            {TOGGLES.map(([k, label]) => (
              <label key={k}>
                <Toggle checked={f[k]} onChange={(v) => set({ [k]: v })} label={label} />
                {label}
              </label>
            ))}
            {filtered && (
              <span className="small faint" style={{ marginLeft: 'auto' }}>
                Showing {rows.length} of {allRows.length}
              </span>
            )}
          </div>

          <Card flush>
            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => r.key}
              groupBy={groupOf}
              onRowClick={(r) => openPort(r.protocol, r.port)}
              empty={
                allRows.length ? (
                  <Empty
                    icon="filter"
                    title="No ports match"
                    action={
                      <Button size="sm" onClick={() => setF({ ...DEFAULT_PORT_FILTERS, sort: f.sort, dir: f.dir, group: f.group })}>
                        Clear filters
                      </Button>
                    }
                  >
                    Try a different search or turn off some filters.
                  </Empty>
                ) : (
                  <Empty icon="ports" title="No listening ports">
                    Nothing is listening on TCP or bound on UDP right now.
                  </Empty>
                )
              }
            />
          </Card>
        </>
      )}
    </div>
  );
}

/** Quick availability check for a TCP port; shows the backend's summary inline. */
function PortCheck() {
  const toast = useToast();
  const { openPort } = useInspect();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const { port, error } = parseCheckPort(value);

  const run = async (e) => {
    e.preventDefault();
    if (!port) return;
    setBusy(true);
    try {
      setResult(await api.portCheck('tcp', port));
    } catch (err) {
      setResult(null);
      toast.fail('Availability check failed', err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack" style={{ marginBottom: 'var(--sp-4)' }}>
      <form className="row wrap" onSubmit={run} aria-label="Check port availability">
        <label className="row small muted" style={{ gap: 6 }}>
          Check TCP port
          <input
            className="input mono"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="e.g. 3000"
            style={{ width: 110 }}
            aria-invalid={!!error}
            spellCheck={false}
          />
        </label>
        <Button type="submit" size="sm" icon="search" disabled={!port || busy}>
          {busy ? 'Checking…' : 'Check'}
        </Button>
        {error && <span className="field-error">{error}</span>}
      </form>
      {result && (
        <Callout tone={result.available ? 'ok' : result.occupiedBy?.length ? 'info' : 'warn'} title={`Port ${result.port} — ${result.available ? 'available' : 'not available'}`}>
          {result.summary}
          {result.claims?.length > 0 && (
            <div className="row wrap" style={{ marginTop: 6 }}>
              {result.claims.map((c) => (
                <Badge key={`${c.source}${c.id}`} tone={c.source === 'reservation' ? 'info' : ''}>
                  {c.source === 'reservation' ? 'Personal reservation (Portly only)' : c.source}: {c.label}
                </Badge>
              ))}
            </div>
          )}
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" variant="ghost" onClick={() => openPort('tcp', result.port)}>
              Port details
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setResult(null)}>
              Dismiss
            </Button>
          </div>
        </Callout>
      )}
    </div>
  );
}
