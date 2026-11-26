import { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, Chip, Empty, Loading, Meter, PageHeader, ProcIcon, SearchInput, Select, Toggle } from '../components/ui/primitives.jsx';
import Table from '../components/ui/Table.jsx';
import { useData, useInspect } from '../app/store.jsx';
import { bytes, duration, percent, plural } from '../lib/format.js';
import {
  DEFAULT_PROC_FILTERS,
  categoryCounts,
  exploreProcesses,
  filterProcessesBase,
  hasReview,
  parentGroup,
  procSorts,
  processSummary,
  toggleIn,
  uptime,
} from '../lib/explore.js';
import './Ports.css';

const SORT_OPTIONS = Object.entries(procSorts(0)).map(([value, s]) => ({ value, label: `Sort: ${s.label}` }));
const TOGGLES = [
  ['devOnly', 'Dev servers only'],
  ['listeningOnly', 'Listening only'],
  ['reviewOnly', 'Has review hints'],
  ['tree', 'Group by parent'],
];
const MAX_PORT_CHIPS = 4;

export default function Processes() {
  const { snapshot, iconFor } = useData();
  const { openProcess, openPort } = useInspect();
  const [f, setF] = useState(DEFAULT_PROC_FILTERS);
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));

  // Uptime ticks with each snapshot; a slow clock keeps it fresh when paused.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const clock = Math.max(now, snapshot.ts || 0);

  const procs = snapshot.processes;
  const base = useMemo(() => filterProcessesBase(procs, f), [procs, f]);
  const cats = useMemo(() => categoryCounts(base), [base]);
  const rows = useMemo(() => exploreProcesses(procs, f, clock), [procs, f, clock]);
  const summary = useMemo(() => processSummary(rows), [rows]);
  const filtered = rows.length !== procs.length;

  const columns = [
    {
      key: 'name',
      label: 'Process',
      sortable: false,
      render: (p) => (
        <span className="proc-cell">
          <ProcIcon src={iconFor(p.pid)} />
          <span className="truncate" title={p.path || p.name}>{p.name}</span>
          {p.kind && <Badge>{p.kind}</Badge>}
          {p.likelyDevServer && (
            <Badge tone="info" title={p.devReasons?.join('\n') || 'Likely a local development server'}>
              Dev server
            </Badge>
          )}
          {hasReview(p) && (
            <Badge tone="warn" icon="eye" title="Has rule-based review hints (not malware detection). Open the process for details.">
              Review
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'pid', label: 'PID', width: 80, sortable: false, render: (p) => <span className="mono">{p.pid}</span> },
    {
      key: 'ports',
      label: 'Ports',
      sortable: false,
      render: (p) => {
        const list = [...(p.listenPorts || []).map((port) => ['tcp', port]), ...(p.udpPorts || []).map((port) => ['udp', port])];
        if (!list.length) return <span className="faint">—</span>;
        return (
          <span className="row wrap" style={{ gap: 4 }}>
            {list.slice(0, MAX_PORT_CHIPS).map(([proto, port]) => (
              <button
                key={`${proto}${port}`}
                type="button"
                className="explore-port-chip"
                title={`${proto.toUpperCase()} ${port} — open port details`}
                onClick={(e) => {
                  e.stopPropagation();
                  openPort(proto, port);
                }}
                onKeyDown={(e) => e.stopPropagation()}
              >
                {port}
                {proto === 'udp' && <span className="faint" style={{ marginLeft: 3 }}>u</span>}
              </button>
            ))}
            {list.length > MAX_PORT_CHIPS && <span className="xs faint">+{list.length - MAX_PORT_CHIPS}</span>}
          </span>
        );
      },
    },
    { key: 'connections', label: 'Conns', num: true, width: 70, sortable: false, render: (p) => <span className="mono">{p.connections}</span> },
    {
      key: 'cpu',
      label: 'CPU',
      width: 130,
      sortable: false,
      render: (p) =>
        p.cpuPercent == null ? (
          <span className="faint">—</span>
        ) : (
          <span className="explore-bar">
            <Meter value={p.cpuPercent} max={100} />
            <span className="mono xs" style={{ width: 44, textAlign: 'right' }}>{percent(p.cpuPercent)}</span>
          </span>
        ),
    },
    { key: 'memory', label: 'Memory', num: true, width: 90, sortable: false, render: (p) => <span className="mono small">{bytes(p.memoryBytes)}</span> },
    { key: 'uptime', label: 'Uptime', num: true, width: 90, sortable: false, render: (p) => <span className="small">{duration(uptime(p, clock))}</span> },
    {
      key: 'access',
      label: 'Access',
      width: 90,
      sortable: false,
      render: (p) =>
        p.access === 'full' ? (
          <span className="faint xs">Full</span>
        ) : p.access === 'system' ? (
          <Badge title="Windows kernel pseudo-process; it cannot be opened for inspection.">System</Badge>
        ) : (
          <Badge
            tone="warn"
            title="Windows denied query access without elevation — the process is probably elevated, protected or owned by another account. Path, memory and start time may be missing. Portly never elevates."
          >
            Limited
          </Badge>
        ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="Processes"
        sub="Processes that currently own a network socket (listening or connected). Processes without sockets are not shown."
        actions={
          snapshot.seq ? (
            <span className="small muted">
              {plural(summary.count, 'process', 'processes')} · {plural(summary.dev, 'dev server')} · {bytes(summary.memory)} memory
              {filtered && <span className="faint"> (of {procs.length})</span>}
            </span>
          ) : null
        }
      />

      {!snapshot.seq ? (
        <Card>
          <Loading label="Waiting for the first monitoring scan…" />
        </Card>
      ) : (
        <>
          <div className="toolbar">
            <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="Search name, PID, path, port…" width={260} />
            {cats.map((c) => (
              <Chip key={c.value} pressed={f.categories.includes(c.value)} count={c.count} onClick={() => set({ categories: toggleIn(f.categories, c.value) })}>
                {c.label}
              </Chip>
            ))}
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
          </div>
          <div className="explore-toggles">
            {TOGGLES.map(([k, label]) => (
              <label key={k}>
                <Toggle checked={f[k]} onChange={(v) => set({ [k]: v })} label={label} />
                {label}
              </label>
            ))}
          </div>

          <Card flush>
            <Table
              columns={columns}
              rows={rows}
              rowKey={(p) => p.pid}
              groupBy={f.tree ? parentGroup : undefined}
              onRowClick={(p) => openProcess(p.pid)}
              empty={
                procs.length ? (
                  <Empty
                    icon="filter"
                    title="No processes match"
                    action={
                      <Button size="sm" onClick={() => setF({ ...DEFAULT_PROC_FILTERS, sort: f.sort, dir: f.dir, tree: f.tree })}>
                        Clear filters
                      </Button>
                    }
                  >
                    Try a different search or turn off some filters.
                  </Empty>
                ) : (
                  <Empty icon="processes" title="No processes with sockets">
                    No process owns a network socket right now.
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
