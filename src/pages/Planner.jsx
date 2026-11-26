import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import { Badge, Button, Callout, Card, Dot, Empty, Field, Loading, PageHeader, Segmented, Select, Tabs } from '../components/ui/primitives.jsx';
import Table from '../components/ui/Table.jsx';
import { Modal, useConfirm } from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import Icon from '../components/ui/Icon.jsx';
import { api } from '../lib/api.js';
import { HEALTH_LABEL, HEALTH_TONE, parsePorts, plural } from '../lib/format.js';
import { usageIndex, portKey } from '../lib/domain.js';
import {
  ENTRY_KINDS,
  ENTRY_KIND_LABEL,
  PLAN_TEMPLATES,
  addEntry,
  bandPosition,
  emptyEntry,
  entriesPayload,
  entryPorts,
  issuesByIndex,
  moveEntry,
  pickFreePort,
  planDraft,
  planInput,
  projectPortMap,
  rangeOccupancy,
  removeEntry,
  suggestWindow,
  updateEntry,
  validateRange,
} from '../lib/organize.js';
import { useConfig, useData, useInspect } from '../app/store.jsx';
import { useDebounced } from './Projects.jsx';
import './Projects.css';

const RESERVATION_LABEL = 'Personal reservation — Portly-only; does not block other programs';
const PROTOCOLS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
];
const HOSTS = ['localhost', '127.0.0.1', '::1'].map((h) => ({ value: h, label: h }));
const CLAIM_LABEL = { project: 'Project', plan: 'Plan', reservation: 'Personal reservation', favorite: 'Favorite' };
const SEV_TONE = { error: 'danger', warning: 'warn', info: 'info' };
const EXPORTS = {
  json: { label: 'JSON', ext: ['json'] },
  csv: { label: 'CSV', ext: ['csv'] },
  markdown: { label: 'Markdown', ext: ['md'] },
};

export default function Planner() {
  const { reservations, ranges, plans } = useConfig();
  const [tab, setTab] = useState('availability');
  return (
    <div className="page">
      <PageHeader
        title="Port Planner"
        sub="Check availability, keep personal reservations and ranges, and plan which ports your services should use."
      />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'availability', label: 'Availability' },
          { value: 'reservations', label: 'Personal reservations', count: reservations.length },
          { value: 'ranges', label: 'Ranges', count: ranges.length },
          { value: 'plans', label: 'Port plans', count: plans.length },
        ]}
      />
      {tab === 'availability' && <AvailabilityTab />}
      {tab === 'reservations' && <ReservationsTab />}
      {tab === 'ranges' && <RangesTab />}
      {tab === 'plans' && <PlansTab />}
    </div>
  );
}

function PortButton({ protocol, port }) {
  const { openPort } = useInspect();
  return (
    <button type="button" className="pj-linkish port-num" onClick={() => openPort(protocol, port)} title="Port details">
      {port}
    </button>
  );
}

function ProcNames({ pids }) {
  const { procByPid } = useData();
  const { openProcess } = useInspect();
  if (!pids?.length) return <span className="faint">—</span>;
  return (
    <span className="row wrap">
      {pids.map((pid) => (
        <button key={pid} type="button" className="pj-linkish small" onClick={() => openProcess(pid)} title={`PID ${pid}`}>
          {procByPid.get(pid)?.name || `PID ${pid}`}
        </button>
      ))}
    </span>
  );
}

// -------------------------------------------------------- availability

function AvailabilityTab() {
  const { ranges, reservations } = useConfig();
  const toast = useToast();
  const [protocol, setProtocol] = useState('tcp');
  const [query, setQuery] = useState('3000, 5173, 8000-8010');
  const [results, setResults] = useState(null);
  const [checkError, setCheckError] = useState(null);
  const [checking, setChecking] = useState(false);

  const [sStart, setSStart] = useState('3000');
  const [sEnd, setSEnd] = useState('3999');
  const [sCount, setSCount] = useState('5');
  const [suggested, setSuggested] = useState(null);
  const [suggesting, setSuggesting] = useState(false);

  const [excl, setExcl] = useState(null);
  const [exclError, setExclError] = useState(null);
  const [exclLoading, setExclLoading] = useState(false);

  const loadExcl = useCallback((refresh) => {
    setExclLoading(true);
    setExclError(null);
    return api
      .exclusions(refresh)
      .then(setExcl)
      .catch(setExclError)
      .finally(() => setExclLoading(false));
  }, []);
  useEffect(() => {
    loadExcl(false);
  }, [loadExcl]);

  const check = async (e) => {
    e?.preventDefault();
    const { ports, error } = parsePorts(query);
    if (error) return setCheckError(error);
    if (!ports.length) return setCheckError('Enter at least one port, e.g. 3000 or 3000-3010.');
    setCheckError(null);
    setChecking(true);
    try {
      setResults(await api.portCheckMany(protocol, ports));
    } catch (err) {
      setCheckError(err.message);
    } finally {
      setChecking(false);
    }
  };

  const suggest = async (e) => {
    e?.preventDefault();
    const err = validateRange(sStart, sEnd);
    if (err) return toast.error('Invalid range', err);
    setSuggesting(true);
    try {
      setSuggested(await api.portSuggest(protocol, Number(sStart), Number(sEnd), Math.max(1, Math.min(20, Number(sCount) || 5))));
    } catch (er) {
      toast.fail('Could not suggest ports', er);
    } finally {
      setSuggesting(false);
    }
  };

  const columns = [
    { key: 'port', label: 'Port', width: 80, render: (r) => <PortButton protocol={r.protocol} port={r.port} /> },
    {
      key: 'available',
      label: 'Status',
      width: 120,
      sort: (r) => (r.available ? 0 : 1),
      render: (r) => (r.available ? <Badge tone="ok">Available</Badge> : r.osExcluded ? <Badge tone="danger">Excluded</Badge> : <Badge tone="warn">Unavailable</Badge>),
    },
    { key: 'summary', label: 'Summary', render: (r) => <span className="small">{r.summary}{r.wellKnown ? <span className="faint"> · commonly {r.wellKnown}</span> : null}</span> },
    { key: 'occupiedBy', label: 'Occupied by', sortable: false, render: (r) => <ProcNames pids={r.occupiedBy} /> },
    {
      key: 'osExcluded',
      label: 'Windows',
      width: 130,
      sort: (r) => (r.osExcluded ? 0 : 1),
      render: (r) =>
        r.osExcluded ? (
          <Badge tone="danger" title={r.osExcludedAdministered ? 'Administrator-defined exclusion' : 'Typically Hyper-V, WSL, Docker or WinNAT'}>
            Reserved by Windows
          </Badge>
        ) : r.osExclusionsVerified ? (
          <span className="faint xs">Not excluded</span>
        ) : (
          <span className="faint xs">Unverified</span>
        ),
    },
    {
      key: 'claims',
      label: 'Claims',
      sortable: false,
      render: (r) =>
        r.claims.length ? (
          <span className="row wrap">
            {r.claims.map((c) => (
              <Badge key={`${c.source}-${c.id}`} tone={c.source === 'reservation' ? 'info' : ''} title={c.source === 'reservation' ? RESERVATION_LABEL : undefined}>
                {CLAIM_LABEL[c.source] || c.source}: {c.label}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="faint">—</span>
        ),
    },
  ];

  return (
    <div className="stack">
      <Card title="Check availability" sub="A port is available only when nothing uses it, Windows does not exclude it and a test bind succeeds right now.">
        <form className="row wrap" onSubmit={check}>
          <Segmented value={protocol} onChange={setProtocol} options={PROTOCOLS} ariaLabel="Protocol" />
          <label className="field" style={{ flex: 1, minWidth: 240 }}>
            <span className="visually-hidden">Ports to check</span>
            <input className="input mono" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="3000, 8080, 5000-5010" spellCheck={false} />
          </label>
          <Button type="submit" variant="primary" icon="search" disabled={checking}>
            {checking ? 'Checking…' : 'Check'}
          </Button>
        </form>
        <div className="xs faint" style={{ marginTop: 6 }}>Single ports, lists and ranges — up to 200 ports at once.</div>
        {checkError && (
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <Callout tone="danger">{checkError}</Callout>
          </div>
        )}
        {results && (
          <div style={{ marginTop: 'var(--sp-3)' }}>
            <div className="xs muted" style={{ marginBottom: 6 }}>
              {results.filter((r) => r.available).length} of {plural(results.length, 'port')} available
            </div>
            <Table columns={columns} rows={results} rowKey={(r) => `${r.protocol}:${r.port}`} maxHeight={420} dense />
          </div>
        )}
      </Card>

      <Card title="Suggest free ports" sub="Skips ports in use, excluded by Windows, or already claimed by projects, plans and personal reservations.">
        <form className="row wrap" onSubmit={suggest} style={{ alignItems: 'flex-end' }}>
          {ranges.length > 0 && (
            <Field label="Custom range">
              <Select
                value=""
                ariaLabel="Pick a custom range"
                onChange={(v) => {
                  const r = ranges.find((x) => String(x.id) === v);
                  if (r) {
                    setSStart(String(r.portStart));
                    setSEnd(String(r.portEnd));
                  }
                }}
                options={[{ value: '', label: 'Pick a range…' }, ...ranges.map((r) => ({ value: String(r.id), label: `${r.name} (${r.portStart}–${r.portEnd})` }))]}
              />
            </Field>
          )}
          <Field label="Start">
            <input className="input mono" style={{ width: 100 }} inputMode="numeric" value={sStart} onChange={(e) => setSStart(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="End">
            <input className="input mono" style={{ width: 100 }} inputMode="numeric" value={sEnd} onChange={(e) => setSEnd(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Count">
            <input className="input mono" style={{ width: 70 }} inputMode="numeric" value={sCount} onChange={(e) => setSCount(e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Button type="submit" icon="zap" disabled={suggesting}>
            {suggesting ? 'Searching…' : 'Suggest'}
          </Button>
        </form>
        {suggested && (
          <div className="row wrap" style={{ marginTop: 'var(--sp-3)' }}>
            {suggested.length ? (
              <>
                <span className="xs muted">Free ({protocol.toUpperCase()}):</span>
                {suggested.map((p) => (
                  <Badge key={p} tone="ok">
                    <PortButton protocol={protocol} port={p} />
                  </Badge>
                ))}
              </>
            ) : (
              <span className="small muted">No free port found in this range.</span>
            )}
          </div>
        )}
      </Card>

      <Card
        title="Reserved by Windows (verified via netsh)"
        sub="Excluded port ranges from `netsh int ipv4/ipv6 show excludedportrange`. No program can bind these ports while the exclusion exists."
        actions={
          <Button size="sm" icon="refresh" disabled={exclLoading} onClick={() => loadExcl(true)}>
            Refresh
          </Button>
        }
      >
        {exclError ? (
          <Callout tone="danger" title="Could not load Windows exclusions">{exclError.message}</Callout>
        ) : !excl ? (
          <Loading label="Querying Windows…" />
        ) : (
          <div className="stack">
            {!excl.verified && (
              <Callout tone="warn" title="Exclusions could not be verified">
                {excl.error || 'netsh did not return a usable result.'} Availability results may miss Windows-excluded ports.
              </Callout>
            )}
            <PortBand exclusions={excl.ranges} reservations={reservations} ranges={ranges} />
            {excl.ranges.length ? (
              <Table
                dense
                maxHeight={300}
                rows={excl.ranges}
                rowKey={(r) => `${r.protocol}-${r.family}-${r.start}-${r.end}`}
                initialSort={{ key: 'start', dir: 'asc' }}
                columns={[
                  { key: 'protocol', label: 'Protocol', width: 90, render: (r) => r.protocol.toUpperCase() },
                  { key: 'family', label: 'Family', width: 90, render: (r) => (r.family === 'ipv6' ? 'IPv6' : 'IPv4') },
                  { key: 'start', label: 'Range', render: (r) => <span className="port-num">{r.start === r.end ? r.start : `${r.start}–${r.end}`}</span> },
                  { key: 'size', label: 'Ports', num: true, sort: (r) => r.end - r.start + 1, render: (r) => r.end - r.start + 1 },
                  {
                    key: 'administered',
                    label: 'Source',
                    render: (r) => (r.administered ? <Badge>Administrator</Badge> : <span className="faint xs">System (Hyper-V / WSL / Docker / WinNAT)</span>),
                  },
                ]}
              />
            ) : (
              excl.verified && <div className="small muted">Windows currently excludes no ports.</div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function PortBand({ exclusions, reservations, ranges }) {
  return (
    <div className="stack tight">
      <div className="pj-band" role="img" aria-label="Port space 1–65535 with Windows exclusions, personal reservations and custom ranges">
        {exclusions.map((r) => (
          <span key={`e${r.protocol}${r.family}${r.start}`} className="excluded" style={bandPosition(r.start, r.end)} title={`Reserved by Windows ${r.start}–${r.end}`} />
        ))}
        {reservations.map((r) => (
          <span key={`r${r.id}`} className="reservation" style={bandPosition(r.portStart, r.portEnd)} title={`Personal reservation "${r.label}" ${r.portStart}–${r.portEnd}`} />
        ))}
        {ranges.map((r) => (
          <span key={`g${r.id}`} className="range" style={bandPosition(r.portStart, r.portEnd)} title={`Range "${r.name}" ${r.portStart}–${r.portEnd}`} />
        ))}
      </div>
      <div className="pj-band-axis">
        <span>1</span>
        <span>16384</span>
        <span>32768</span>
        <span>49152</span>
        <span>65535</span>
      </div>
      <div className="row wrap xs muted">
        <span>
          <span className="pj-legend" style={{ background: 'var(--danger)' }} />
          Reserved by Windows
        </span>
        <span>
          <span className="pj-legend" style={{ background: 'var(--info)' }} />
          Personal reservations (Portly-only)
        </span>
        <span>
          <span className="pj-legend" style={{ background: 'var(--text-3)' }} />
          Custom ranges
        </span>
      </div>
    </div>
  );
}

// -------------------------------------------------------- reservations

function ReservationsTab() {
  const { reservations, projects, loaded, reload } = useConfig();
  const { snapshot } = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const close = useCallback(() => setEditing(null), []);

  const rows = useMemo(() => reservations.map((r) => ({ ...r, occ: rangeOccupancy(r, snapshot) })), [reservations, snapshot]);
  const projectName = (id) => projects.find((p) => p.id === id)?.name;

  const remove = async (r) => {
    const ok = await confirm({ title: `Delete personal reservation "${r.label}"?`, body: 'Only the Portly note is removed; no program is affected.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.reservationDelete(r.id);
      await reload('reservations');
      toast.ok('Reservation deleted', r.label);
    } catch (e) {
      toast.fail('Could not delete reservation', e);
    }
  };

  return (
    <Card
      title="Personal reservations"
      sub={`${RESERVATION_LABEL}. Portly warns when something else occupies these ports and avoids them when suggesting.`}
      actions={
        <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ id: 0, protocol: 'tcp', portStart: '', portEnd: '', label: '', note: '', projectId: null })}>
          New reservation
        </Button>
      }
    >
      {!loaded ? (
        <Loading />
      ) : (
        <Table
          rows={rows}
          rowKey={(r) => r.id}
          initialSort={{ key: 'portStart', dir: 'asc' }}
          empty={<Empty icon="tag" title="No personal reservations">Mark port ranges you want to keep for yourself. They are Portly-only notes and do not block other programs.</Empty>}
          columns={[
            { key: 'label', label: 'Label', render: (r) => <span className="stack tight"><strong>{r.label}</strong>{r.note && <span className="xs faint">{r.note}</span>}</span> },
            { key: 'protocol', label: 'Proto', width: 70, render: (r) => r.protocol.toUpperCase() },
            { key: 'portStart', label: 'Ports', render: (r) => <span className="port-num">{r.portStart === r.portEnd ? r.portStart : `${r.portStart}–${r.portEnd}`}</span> },
            { key: 'projectId', label: 'Project', sort: (r) => projectName(r.projectId) || null, render: (r) => projectName(r.projectId) || <span className="faint">—</span> },
            {
              key: 'occ',
              label: 'Live occupancy',
              sort: (r) => r.occ.count,
              render: (r) =>
                r.occ.count ? (
                  <span className="row wrap">
                    <Badge tone="warn">
                      {r.occ.count}/{r.occ.size} in use
                    </Badge>
                    {r.occ.ports.slice(0, 8).map((u) => (
                      <PortButton key={u.port} protocol={u.protocol} port={u.port} />
                    ))}
                    {r.occ.count > 8 && <span className="xs faint">+{r.occ.count - 8}</span>}
                  </span>
                ) : (
                  <Badge tone="ok">Free</Badge>
                ),
            },
            {
              key: 'actions',
              label: '',
              sortable: false,
              width: 80,
              render: (r) => (
                <span className="row">
                  <Button size="sm" variant="ghost" icon="edit" iconOnly aria-label={`Edit ${r.label}`} onClick={() => setEditing({ ...r })} />
                  <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Delete ${r.label}`} onClick={() => remove(r)} />
                </span>
              ),
            },
          ]}
        />
      )}
      {editing && <ReservationModal initial={editing} projects={projects} onClose={close} />}
    </Card>
  );
}

function ReservationModal({ initial, projects, onClose }) {
  const { reload } = useConfig();
  const toast = useToast();
  const [r, setR] = useState({ ...initial, portStart: String(initial.portStart), portEnd: String(initial.portEnd) });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setR((x) => ({ ...x, ...patch }));

  const submit = async (e) => {
    e?.preventDefault();
    const end = r.portEnd === '' ? r.portStart : r.portEnd;
    const err = !r.label.trim() ? 'Label is required' : validateRange(r.portStart, end);
    if (err) return setError(err);
    setSaving(true);
    setError(null);
    try {
      await api.reservationSave({
        id: r.id || 0,
        protocol: r.protocol,
        portStart: Number(r.portStart),
        portEnd: Number(end),
        label: r.label.trim(),
        note: r.note.trim(),
        projectId: r.projectId ? Number(r.projectId) : null,
      });
      await reload('reservations');
      toast.ok('Personal reservation saved', r.label.trim());
      onClose();
    } catch (er) {
      setError(er.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      title={r.id ? 'Edit personal reservation' : 'New personal reservation'}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Save
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        <Callout tone="info">{RESERVATION_LABEL}.</Callout>
        {error && <Callout tone="danger" title="Could not save">{error}</Callout>}
        <Field label="Label">
          <input className="input" value={r.label} onChange={(e) => set({ label: e.target.value })} maxLength={120} />
        </Field>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <Field label="Protocol">
            <Select value={r.protocol} onChange={(v) => set({ protocol: v })} options={PROTOCOLS} ariaLabel="Protocol" />
          </Field>
          <Field label="First port">
            <input className="input mono" style={{ width: 110 }} inputMode="numeric" value={r.portStart} onChange={(e) => set({ portStart: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Last port" hint="Blank = single port">
            <input className="input mono" style={{ width: 110 }} inputMode="numeric" value={r.portEnd} onChange={(e) => set({ portEnd: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        <Field label="Project (optional)">
          <Select
            value={r.projectId != null ? String(r.projectId) : ''}
            ariaLabel="Project"
            onChange={(v) => set({ projectId: v || null })}
            options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: String(p.id), label: p.name }))]}
          />
        </Field>
        <Field label="Note">
          <textarea className="textarea" rows={2} value={r.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

// -------------------------------------------------------------- ranges

function RangesTab() {
  const { ranges, loaded, reload } = useConfig();
  const { snapshot } = useData();
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const [suggestions, setSuggestions] = useState({});
  const close = useCallback(() => setEditing(null), []);

  const remove = async (r) => {
    const ok = await confirm({ title: `Delete range "${r.name}"?`, body: 'Only the range definition is removed.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      await api.rangeDelete(r.id);
      await reload('ranges');
    } catch (e) {
      toast.fail('Could not delete range', e);
    }
  };

  const suggest = async (r) => {
    try {
      const [p] = await api.portSuggest('tcp', r.portStart, r.portEnd, 1);
      setSuggestions((s) => ({ ...s, [r.id]: p ?? null }));
    } catch (e) {
      toast.fail('Could not suggest a port', e);
    }
  };

  return (
    <Card
      title="Custom port ranges"
      sub="Named ranges for organizing which kinds of services go where (e.g. 3000–3099 front ends). Ranges are labels only."
      actions={
        <Button variant="primary" size="sm" icon="plus" onClick={() => setEditing({ id: 0, name: '', portStart: '', portEnd: '', purpose: '' })}>
          New range
        </Button>
      }
    >
      {!loaded ? (
        <Loading />
      ) : (
        <Table
          rows={ranges}
          rowKey={(r) => r.id}
          initialSort={{ key: 'portStart', dir: 'asc' }}
          empty={<Empty icon="map" title="No ranges">Define ranges like "Front ends 3000–3099" to get suggestions from them.</Empty>}
          columns={[
            { key: 'name', label: 'Name', render: (r) => <strong>{r.name}</strong> },
            { key: 'portStart', label: 'Ports', render: (r) => <span className="port-num">{r.portStart}–{r.portEnd}</span> },
            { key: 'purpose', label: 'Purpose', render: (r) => r.purpose || <span className="faint">—</span> },
            {
              key: 'occ',
              label: 'In use',
              sort: (r) => rangeOccupancy(r, snapshot).count,
              render: (r) => {
                const o = rangeOccupancy(r, snapshot);
                return (
                  <span className="small" title={o.ports.map((u) => `${u.protocol}:${u.port}`).join(', ')}>
                    {o.count} / {o.size}
                  </span>
                );
              },
            },
            {
              key: 'suggest',
              label: 'Suggestion',
              sortable: false,
              render: (r) => (
                <span className="row">
                  <Button size="sm" icon="zap" onClick={() => suggest(r)}>
                    Suggest port from this range
                  </Button>
                  {r.id in suggestions &&
                    (suggestions[r.id] ? (
                      <Badge tone="ok">
                        <PortButton protocol="tcp" port={suggestions[r.id]} />
                      </Badge>
                    ) : (
                      <span className="xs faint">None free</span>
                    ))}
                </span>
              ),
            },
            {
              key: 'actions',
              label: '',
              sortable: false,
              width: 80,
              render: (r) => (
                <span className="row">
                  <Button size="sm" variant="ghost" icon="edit" iconOnly aria-label={`Edit ${r.name}`} onClick={() => setEditing({ ...r })} />
                  <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Delete ${r.name}`} onClick={() => remove(r)} />
                </span>
              ),
            },
          ]}
        />
      )}
      {editing && <RangeModal initial={editing} onClose={close} />}
    </Card>
  );
}

function RangeModal({ initial, onClose }) {
  const { reload } = useConfig();
  const [r, setR] = useState({ ...initial, portStart: String(initial.portStart), portEnd: String(initial.portEnd) });
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setR((x) => ({ ...x, ...patch }));
  const submit = async (e) => {
    e?.preventDefault();
    const err = !r.name.trim() ? 'Name is required' : validateRange(r.portStart, r.portEnd);
    if (err) return setError(err);
    setSaving(true);
    setError(null);
    try {
      await api.rangeSave({ id: r.id || 0, name: r.name.trim(), portStart: Number(r.portStart), portEnd: Number(r.portEnd), purpose: r.purpose.trim() });
      await reload('ranges');
      onClose();
    } catch (er) {
      setError(er.message);
      setSaving(false);
    }
  };
  return (
    <Modal
      title={r.id ? 'Edit range' : 'New range'}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={saving}>
            Save
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        {error && <Callout tone="danger" title="Could not save">{error}</Callout>}
        <Field label="Name">
          <input className="input" value={r.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} />
        </Field>
        <div className="row">
          <Field label="First port">
            <input className="input mono" style={{ width: 110 }} inputMode="numeric" value={r.portStart} onChange={(e) => set({ portStart: e.target.value.replace(/\D/g, '') })} />
          </Field>
          <Field label="Last port">
            <input className="input mono" style={{ width: 110 }} inputMode="numeric" value={r.portEnd} onChange={(e) => set({ portEnd: e.target.value.replace(/\D/g, '') })} />
          </Field>
        </div>
        <Field label="Purpose">
          <textarea className="textarea" rows={2} value={r.purpose} onChange={(e) => set({ purpose: e.target.value })} />
        </Field>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

// --------------------------------------------------------------- plans

function PlansTab() {
  const { plans, projects, loaded } = useConfig();
  const [selected, setSelected] = useState(null); // plan id | 'new' | null
  const current = selected === 'new' ? null : plans.find((p) => p.id === selected) || null;
  const editorOpen = selected === 'new' || !!current;

  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 280px) 1fr', alignItems: 'start' }}>
        <Card
          flush
          title="Port plans"
          actions={
            <Button size="sm" variant="primary" icon="plus" onClick={() => setSelected('new')}>
              New plan
            </Button>
          }
        >
          {!loaded ? (
            <Loading />
          ) : plans.length === 0 ? (
            <Empty icon="map" title="No plans">Plan which ports each service of a project should use.</Empty>
          ) : (
            <div className="list" role="listbox" aria-label="Port plans">
              {plans.map((p) => (
                <div
                  key={p.id}
                  role="option"
                  tabIndex={0}
                  aria-selected={selected === p.id}
                  className="list-item clickable"
                  style={selected === p.id ? { background: 'var(--surface-2)' } : undefined}
                  onClick={() => setSelected(p.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSelected(p.id))}
                >
                  <div className="stack tight" style={{ minWidth: 0 }}>
                    <strong className="truncate">{p.name}</strong>
                    <span className="xs faint truncate">
                      {plural(p.entries.length, 'entry', 'entries')}
                      {p.projectId != null && ` · ${projects.find((x) => x.id === p.projectId)?.name || 'project'}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        {editorOpen ? (
          <PlanEditor key={selected} plan={current} onSaved={(p) => setSelected(p.id)} onDeleted={() => setSelected(null)} onCancel={() => setSelected(null)} />
        ) : (
          <Card>
            <Empty icon="map" title="Select a plan">
              Choose a plan to edit it, or create a new one. Plans are personal allocation maps — they don't reserve anything in Windows.
            </Empty>
          </Card>
        )}
      </div>
      <ProjectPortMapCard />
    </div>
  );
}

function PlanEditor({ plan, onSaved, onDeleted, onCancel }) {
  const { projects, profiles, reload } = useConfig();
  const toast = useToast();
  const confirm = useConfirm();
  const [d, setD] = useState(() => planDraft(plan));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(null);
  const [issues, setIssues] = useState([]);
  const [validating, setValidating] = useState(false);
  const [exportFmt, setExportFmt] = useState('json');
  const set = (patch) => {
    setD((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  const setEntries = (fn) => {
    setD((x) => ({ ...x, entries: fn(x.entries) }));
    setDirty(true);
  };

  // Live collision validation (debounced).
  const payloadKey = JSON.stringify([d.projectId, entriesPayload(d.entries)]);
  const debouncedKey = useDebounced(payloadKey, 450);
  const seq = useRef(0);
  useEffect(() => {
    const [projectId, entries] = JSON.parse(debouncedKey);
    const my = ++seq.current;
    if (!entries.length) {
      setIssues([]);
      return;
    }
    setValidating(true);
    api
      .planValidate(plan?.id ?? null, projectId ? Number(projectId) : null, entries)
      .then((r) => my === seq.current && setIssues(r))
      .catch((e) => my === seq.current && setIssues([{ index: -1, code: 'error', severity: 'error', message: e.message }]))
      .finally(() => my === seq.current && setValidating(false));
  }, [debouncedKey, plan?.id]);
  const byIndex = issuesByIndex(issues);
  const errorsCount = issues.filter((i) => i.severity === 'error').length;

  const addTemplate = async (t) => {
    setAdding(t.id);
    try {
      const used = entryPorts(d.entries, 'tcp');
      let port = null;
      if (!used.has(t.port)) {
        const a = await api.portCheck('tcp', t.port);
        const foreign = a.claims.filter((c) => !(c.source === 'plan' && c.id === plan?.id));
        if (a.available && !foreign.length) port = t.port;
      }
      if (port == null) {
        const w = suggestWindow(t.port);
        port = pickFreePort(await api.portSuggest('tcp', w.start, w.end, 20), used);
        if (port != null) toast.info(`${t.service}: using ${port}`, `${t.port} is taken or claimed, so Portly picked the next free port.`);
      }
      if (port == null) {
        toast.warn('No free port found', `Nothing free near ${t.port}; added with the default port.`);
        port = t.port;
      }
      setEntries((list) => addEntry(list, emptyEntry({ service: t.service, kind: t.kind, port: String(port) })));
    } catch (e) {
      toast.fail('Could not add template', e);
    } finally {
      setAdding(null);
    }
  };

  const submit = async () => {
    const built = planInput(d);
    if (built.error) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      const p = await api.planSave(plan?.id ?? null, built.input);
      await reload('plans', 'profiles');
      setDirty(false);
      toast.ok('Plan saved', p.name);
      onSaved(p);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    const ok = await confirm({ title: `Delete plan "${plan.name}"?`, body: 'The plan and its entries are removed. Nothing else changes.', confirmLabel: 'Delete plan', danger: true });
    if (!ok) return;
    try {
      await api.planDelete(plan.id);
      await reload('plans', 'profiles');
      toast.ok('Plan deleted', plan.name);
      onDeleted();
    } catch (e) {
      toast.fail('Could not delete plan', e);
    }
  };

  const doExport = async () => {
    const f = EXPORTS[exportFmt];
    try {
      const safe = (plan.name || 'plan').replace(/[^\w.-]+/g, '-');
      const path = await saveDialog({ defaultPath: `${safe}.${f.ext[0]}`, filters: [{ name: f.label, extensions: f.ext }] });
      if (!path) return;
      await api.planExport(plan.id, exportFmt, path);
      toast.ok('Plan exported', path);
    } catch (e) {
      toast.fail('Export failed', e);
    }
  };

  return (
    <Card
      title={plan ? plan.name : 'New plan'}
      sub={dirty ? 'Unsaved changes' : plan ? 'Saved' : 'Not saved yet'}
      actions={
        <>
          {plan && (
            <>
              <Select value={exportFmt} onChange={setExportFmt} ariaLabel="Export format" options={Object.entries(EXPORTS).map(([value, f]) => ({ value, label: f.label }))} />
              <Button size="sm" icon="download" onClick={doExport} title={dirty ? 'Exports the last saved version' : 'Export plan'}>
                Export
              </Button>
              <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label="Delete plan" title="Delete plan" onClick={remove} />
            </>
          )}
        </>
      }
    >
      <div className="stack">
        {error && <Callout tone="danger" title="Could not save">{error}</Callout>}
        {plan && dirty && <div className="xs faint">Export uses the last saved version of the plan.</div>}
        <div className="pj-editor-grid">
          <Field label="Name">
            <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Description">
            <input className="input" value={d.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label="Project">
            <Select value={d.projectId} ariaLabel="Linked project" onChange={(v) => set({ projectId: v })} options={[{ value: '', label: 'None' }, ...projects.map((p) => ({ value: String(p.id), label: p.name }))]} />
          </Field>
          <Field label="Profile">
            <Select value={d.profileId} ariaLabel="Linked profile" onChange={(v) => set({ profileId: v })} options={[{ value: '', label: 'None' }, ...profiles.map((p) => ({ value: String(p.id), label: p.name }))]} />
          </Field>
        </div>

        <div>
          <div className="row between">
            <div className="section-title">Entries</div>
            <span className="xs faint">
              {validating ? 'Validating…' : issues.length ? `${plural(issues.length, 'issue')}${errorsCount ? `, ${errorsCount} blocking` : ''}` : d.entries.length ? 'No collisions found' : ''}
            </span>
          </div>
          {byIndex[-1]?.map((i) => (
            <Callout key={i.message} tone="danger">{i.message}</Callout>
          ))}
          <div className="stack tight">
            {d.entries.map((e, i) => {
              const iss = byIndex[i] || [];
              const worst = iss.some((x) => x.severity === 'error') ? 'error' : iss.some((x) => x.severity === 'warning') ? 'warning' : '';
              return (
                <div key={e.key} className={`pj-entry-wrap ${worst}`}>
                  <div className="pj-entry" role="group" aria-label={`Entry ${i + 1}`}>
                    <input className="input" aria-label={`Service, entry ${i + 1}`} placeholder="Service" value={e.service} onChange={(ev) => setEntries((l) => updateEntry(l, i, { service: ev.target.value }))} />
                    <Select value={e.kind} ariaLabel={`Kind, entry ${i + 1}`} onChange={(v) => setEntries((l) => updateEntry(l, i, { kind: v }))} options={ENTRY_KINDS.map((k) => ({ value: k, label: ENTRY_KIND_LABEL[k] }))} />
                    <input className="input mono" aria-label={`Port, entry ${i + 1}`} placeholder="Port" inputMode="numeric" value={e.port} onChange={(ev) => setEntries((l) => updateEntry(l, i, { port: ev.target.value.replace(/\D/g, '') }))} />
                    <Select value={e.protocol} ariaLabel={`Protocol, entry ${i + 1}`} onChange={(v) => setEntries((l) => updateEntry(l, i, { protocol: v }))} options={PROTOCOLS} />
                    <input className="input" aria-label={`Note, entry ${i + 1}`} placeholder="Note" value={e.note} onChange={(ev) => setEntries((l) => updateEntry(l, i, { note: ev.target.value }))} />
                    <span className="row">
                      <Button size="sm" variant="ghost" icon="chevronDown" iconOnly aria-label={`Move entry ${i + 1} up`} title="Move up" disabled={i === 0} onClick={() => setEntries((l) => moveEntry(l, i, -1))} className="pj-up" />
                      <Button size="sm" variant="ghost" icon="chevronDown" iconOnly aria-label={`Move entry ${i + 1} down`} title="Move down" disabled={i === d.entries.length - 1} onClick={() => setEntries((l) => moveEntry(l, i, 1))} />
                      <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Remove entry ${i + 1}`} title="Remove" onClick={() => setEntries((l) => removeEntry(l, i))} />
                    </span>
                  </div>
                  <div className="row xs faint" style={{ marginTop: 4 }}>
                    <label className="row">
                      Host
                      <select className="select" style={{ height: 24, fontSize: 'var(--fs-xs)' }} aria-label={`Host, entry ${i + 1}`} value={e.host} onChange={(ev) => setEntries((l) => updateEntry(l, i, { host: ev.target.value }))}>
                        {HOSTS.map((h) => (
                          <option key={h.value} value={h.value}>
                            {h.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {iss.map((x, j) => (
                    <div key={`${x.code}-${j}`} className={`pj-issue ${x.severity}`}>
                      <Icon name={x.severity === 'info' ? 'info' : 'alert'} size={11} />
                      {x.message}
                    </div>
                  ))}
                </div>
              );
            })}
            {!d.entries.length && <div className="xs faint">No entries yet. Add one or start from a template.</div>}
          </div>
          <div className="row wrap" style={{ marginTop: 'var(--sp-3)' }}>
            <Button size="sm" icon="plus" onClick={() => setEntries((l) => addEntry(l))} disabled={d.entries.length >= 200}>
              Add entry
            </Button>
            <span className="xs faint">Quick add:</span>
            {PLAN_TEMPLATES.map((t) => (
              <Button key={t.id} size="sm" variant="ghost" disabled={adding != null} onClick={() => addTemplate(t)} title={`Default port ${t.port}; a free port is picked if it is taken`}>
                {adding === t.id ? 'Checking…' : `${t.service} ${t.port}`}
              </Button>
            ))}
          </div>
        </div>

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onCancel} disabled={saving}>
            Close
          </Button>
          <Button variant="primary" icon="check" onClick={submit} disabled={saving || (!dirty && !!plan)}>
            {saving ? 'Saving…' : 'Save plan'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

function ProjectPortMapCard() {
  const { projects, plans } = useConfig();
  const { snapshot, health } = useData();
  const [projectId, setProjectId] = useState('');
  const project = projects.find((p) => String(p.id) === projectId) || null;
  const idx = useMemo(() => usageIndex(snapshot), [snapshot]);
  const rows = useMemo(() => projectPortMap(project, plans), [project, plans]);
  const dupes = useMemo(() => {
    const count = new Map();
    for (const r of rows) count.set(portKey(r.protocol, r.port), (count.get(portKey(r.protocol, r.port)) || 0) + 1);
    return count;
  }, [rows]);

  return (
    <Card
      title="Project port map"
      sub="A project's registered ports combined with entries of plans linked to it, with live status."
      actions={
        <Select value={projectId} onChange={setProjectId} ariaLabel="Project for port map" options={[{ value: '', label: 'Select a project…' }, ...projects.map((p) => ({ value: String(p.id), label: p.name }))]} />
      }
    >
      {!project ? (
        <div className="small muted">{projects.length ? 'Select a project to see its combined port map.' : 'Register a project first.'}</div>
      ) : (
        <Table
          rows={rows}
          rowKey={(r) => r.key}
          dense
          empty={<div className="small muted">This project has no registered ports and no linked plans.</div>}
          columns={[
            { key: 'port', label: 'Port', width: 80, render: (r) => <PortButton protocol={r.protocol} port={r.port} /> },
            { key: 'protocol', label: 'Proto', width: 70, render: (r) => r.protocol.toUpperCase() },
            { key: 'service', label: 'Service', render: (r) => r.service || <span className="faint">—</span> },
            { key: 'source', label: 'Source', render: (r) => (r.source === 'project' ? <Badge>Project</Badge> : <Badge tone="info">Plan · {r.planName}</Badge>) },
            { key: 'host', label: 'Host', render: (r) => <span className="mono small">{r.host}</span> },
            {
              key: 'live',
              label: 'Live status',
              sortable: false,
              render: (r) => {
                const u = idx.get(portKey(r.protocol, r.port));
                const pp = r.source === 'project' ? project.ports.find((x) => `pp:${x.id}` === r.key) : null;
                const h = pp ? health?.[pp.id]?.last?.status : null;
                return (
                  <span className="row wrap">
                    {u ? <Badge tone="ok">Listening</Badge> : <Badge>Not in use</Badge>}
                    {h && (
                      <span className="row xs">
                        <Dot tone={HEALTH_TONE[h]} /> {HEALTH_LABEL[h] || h}
                      </span>
                    )}
                    {u && <ProcNames pids={u.pids} />}
                    {dupes.get(portKey(r.protocol, r.port)) > 1 && r.source === 'plan' && <span className="xs faint">also listed above</span>}
                  </span>
                );
              },
            },
          ]}
        />
      )}
    </Card>
  );
}
