import { useMemo, useState } from 'react';
import { Badge, Button, Callout, Card, Chip, Empty, Loading, PageHeader, ProcIcon, SearchInput, Segmented, Select, Tabs } from '../components/ui/primitives.jsx';
import Table from '../components/ui/Table.jsx';
import { useData, useInspect } from '../app/store.jsx';
import { CONN_CATEGORY_LABEL, SCOPE_LABEL, SCOPE_TONE, STATE_LABEL, endpoint, plural } from '../lib/format.js';
import {
  CONN_CATEGORIES,
  DEFAULT_CONN_FILTERS,
  buildConnectionRows,
  buildListenerRows,
  connTabRows,
  connectionSummary,
  countBy,
  exposedListeners,
  filterConnections,
  filterConnectionsBase,
  reviewHints,
  toggleIn,
} from '../lib/explore.js';
import './Ports.css';

const CATEGORY_TONE = { local: 'ok', lan: 'info', internet: 'warn', other: '', listener: '' };
const PROTOCOLS = [
  { value: 'all', label: 'All' },
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
];

function ProcButton({ pid, name, icon, onOpen }) {
  return (
    <button
      type="button"
      className="explore-proc-btn"
      title={`Inspect ${name} (PID ${pid})`}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(pid);
      }}
    >
      <ProcIcon src={icon} />
      <span className="truncate">{name}</span>
      <span className="mono faint xs">{pid}</span>
    </button>
  );
}

export default function Connections() {
  const { snapshot, procByPid, iconFor } = useData();
  const { openProcess } = useInspect();
  const [f, setF] = useState(DEFAULT_CONN_FILTERS);
  const set = (patch) => setF((prev) => ({ ...prev, ...patch }));

  const connRows = useMemo(() => buildConnectionRows(snapshot.connections, procByPid), [snapshot.connections, procByPid]);
  const listenerRows = useMemo(() => buildListenerRows(snapshot.ports, procByPid), [snapshot.ports, procByPid]);
  const tabRows = useMemo(() => connTabRows(f.tab, connRows, listenerRows), [f.tab, connRows, listenerRows]);
  const baseRows = useMemo(() => filterConnectionsBase(tabRows, f), [tabRows, f]);
  const rows = useMemo(() => filterConnections(tabRows, f), [tabRows, f]);
  const catCounts = useMemo(() => countBy(baseRows, (r) => r.category), [baseRows]);
  const summary = useMemo(() => connectionSummary(connRows), [connRows]);
  const hints = useMemo(() => reviewHints(snapshot.processes), [snapshot.processes]);
  const exposed = useMemo(() => exposedListeners(snapshot.processes), [snapshot.processes]);

  const established = connRows.filter((r) => r.state === 'established').length;
  const listening = f.tab === 'listening';

  const stateOptions = useMemo(() => {
    const states = [...countBy(tabRows, (r) => r.state).entries()].sort((a, b) => b[1] - a[1]);
    return [{ value: 'all', label: 'Any state' }, ...states.map(([s, n]) => ({ value: s, label: `${STATE_LABEL[s] || s} (${n})` }))];
  }, [tabRows]);

  const columns = [
    {
      key: 'proc',
      label: 'Process',
      sort: (r) => r.procName.toLowerCase(),
      render: (r) => <ProcButton pid={r.pid} name={r.procName} icon={iconFor(r.pid)} onOpen={openProcess} />,
    },
    { key: 'protocol', label: 'Proto', width: 64, render: (r) => <span className="xs muted">{r.protocol.toUpperCase()}</span> },
    {
      key: 'local',
      label: 'Local endpoint',
      sort: (r) => r.localPort,
      render: (r) => <span className="mono small">{endpoint(r.localAddr, r.localPort)}</span>,
    },
    listening
      ? {
          key: 'scope',
          label: 'Exposure',
          sort: (r) => r.scope,
          render: (r) => <Badge tone={SCOPE_TONE[r.scope]}>{SCOPE_LABEL[r.scope] || r.scope}</Badge>,
        }
      : {
          key: 'remote',
          label: 'Remote endpoint',
          sort: (r) => r.remoteAddr || null,
          render: (r) => (r.remoteAddr ? <span className="mono small">{endpoint(r.remoteAddr, r.remotePort)}</span> : <span className="faint">—</span>),
        },
    { key: 'state', label: 'State', sort: (r) => STATE_LABEL[r.state] || r.state, render: (r) => <span className="small">{STATE_LABEL[r.state] || r.state}</span> },
    {
      key: 'category',
      label: 'Category',
      render: (r) => <Badge tone={CATEGORY_TONE[r.category]}>{CONN_CATEGORY_LABEL[r.category] || r.category}</Badge>,
    },
  ];

  if (!snapshot.seq) {
    return (
      <div className="page">
        <PageHeader title="Connections" sub="Network connections and listening sockets of this machine." />
        <Card>
          <Loading label="Waiting for the first monitoring scan…" />
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Connections"
        sub={`${plural(established, 'established connection')} · ${plural(connRows.length, 'non-listening socket')} · ${plural(listenerRows.length, 'listening socket')}. Read from the Windows socket table — Portly does not capture or inspect traffic.`}
      />

      <div className="grid cols-3" style={{ marginBottom: 'var(--sp-4)' }}>
        <Card title="By category" sub="All non-listening sockets">
          <div className="list">
            {CONN_CATEGORIES.map((c) => (
              <div key={c} className="row between small" style={{ padding: '3px 0' }}>
                <Badge tone={CATEGORY_TONE[c]}>{CONN_CATEGORY_LABEL[c]}</Badge>
                <span className="mono">{summary.byCategory[c]}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card title="Top remote endpoints" sub="By number of sockets">
          {summary.remotes.length ? (
            <div className="list">
              {summary.remotes.map((r) => (
                <button
                  key={r.key}
                  type="button"
                  className="explore-proc-btn row between small"
                  style={{ margin: 0, width: '100%', padding: '3px 4px' }}
                  title={`Filter by ${r.key}`}
                  onClick={() => set({ q: r.key, tab: 'all', categories: [] })}
                >
                  <span className="mono truncate">{r.key}</span>
                  <span className="mono">{r.count}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="faint small">No remote endpoints.</p>
          )}
        </Card>
        <Card title="Top processes" sub="By number of sockets">
          {summary.procs.length ? (
            <div className="list">
              {summary.procs.map((p) => (
                <div key={p.pid} className="row between small" style={{ padding: '2px 0' }}>
                  <ProcButton pid={p.pid} name={p.name} icon={iconFor(p.pid)} onOpen={openProcess} />
                  <span className="mono">{p.count}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="faint small">No connections.</p>
          )}
        </Card>
      </div>

      <Tabs
        value={f.tab}
        onChange={(tab) => set({ tab, state: 'all', categories: tab === 'listening' ? [] : f.categories })}
        tabs={[
          { value: 'established', label: 'Established', count: established },
          { value: 'all', label: 'All non-listening', count: connRows.length },
          { value: 'listening', label: 'Listening sockets', count: listenerRows.length },
        ]}
      />

      <div className="toolbar" style={{ marginTop: 'var(--sp-3)' }}>
        <SearchInput value={f.q} onChange={(q) => set({ q })} placeholder="Search address, port, process…" width={260} />
        {!listening &&
          CONN_CATEGORIES.map((c) => (
            <Chip key={c} pressed={f.categories.includes(c)} count={catCounts.get(c) || 0} onClick={() => set({ categories: toggleIn(f.categories, c) })}>
              {CONN_CATEGORY_LABEL[c]}
            </Chip>
          ))}
        <span className="spacer" />
        <Select value={f.state} onChange={(state) => set({ state })} options={stateOptions} ariaLabel="State" />
        <Segmented value={f.protocol} onChange={(protocol) => set({ protocol })} options={PROTOCOLS} ariaLabel="Protocol" />
      </div>

      <Card flush>
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.key}
          initialSort={{ key: 'proc', dir: 'asc' }}
          maxHeight={520}
          dense
          empty={
            tabRows.length ? (
              <Empty
                icon="filter"
                title="Nothing matches"
                action={
                  <Button size="sm" onClick={() => setF({ ...DEFAULT_CONN_FILTERS, tab: f.tab })}>
                    Clear filters
                  </Button>
                }
              >
                Try another search or category.
              </Empty>
            ) : (
              <Empty icon="connections" title={listening ? 'No listening sockets' : 'No connections'}>
                {listening ? 'Nothing is listening right now.' : 'There are no matching sockets in the current snapshot.'}
              </Empty>
            )
          }
        />
      </Card>

      <div className="grid cols-2" style={{ marginTop: 'var(--sp-4)' }}>
        <Card title="Review hints" sub="Rule-based hints about listening processes">
          <Callout tone="info">
            These are simple rule-based hints, not malware detection. Portly only looks at process metadata and the socket table; it does not
            inspect traffic.
          </Callout>
          {hints.length ? (
            <div className="list" style={{ marginTop: 'var(--sp-3)' }}>
              {hints.map(({ proc, indicator }) => (
                <HintRow key={`${proc.pid}-${indicator.rule}`} proc={proc} indicator={indicator} icon={iconFor(proc.pid)} onOpen={openProcess} tone="warn" />
              ))}
            </div>
          ) : (
            <p className="faint small" style={{ marginTop: 'var(--sp-3)' }}>
              No process currently matches a review rule.
            </p>
          )}
        </Card>
        <Card title="Exposed listeners" sub="Processes reachable from other machines on the network">
          {exposed.length ? (
            <div className="list">
              {exposed.map(({ proc, indicator }) => (
                <HintRow key={`${proc.pid}-${indicator.rule}`} proc={proc} indicator={indicator} icon={iconFor(proc.pid)} onOpen={openProcess} tone="info" />
              ))}
            </div>
          ) : (
            <p className="faint small">No process listens on all interfaces.</p>
          )}
        </Card>
      </div>
    </div>
  );
}

function HintRow({ proc, indicator, icon, onOpen, tone }) {
  return (
    <div className="stack tight" style={{ padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
      <div className="row between">
        <ProcButton pid={proc.pid} name={proc.name} icon={icon} onOpen={onOpen} />
        <Badge tone={tone}>{indicator.title}</Badge>
      </div>
      <span className="small muted">{indicator.detail}</span>
    </div>
  );
}
