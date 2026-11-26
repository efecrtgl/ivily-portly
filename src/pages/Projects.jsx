import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import {
  Badge,
  Button,
  Callout,
  Card,
  CopyButton,
  Dot,
  Empty,
  Field,
  Loading,
  PageHeader,
  SearchInput,
  Segmented,
  Select,
  Toggle,
} from '../components/ui/primitives.jsx';
import { Modal, useConfirm } from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import Icon from '../components/ui/Icon.jsx';
import { api } from '../lib/api.js';
import { HEALTH_LABEL, HEALTH_TONE, SEVERITY_TONE, ago, dateTime, percent, plural } from '../lib/format.js';
import { PROJECT_STATE, conflictsFor, projectStatus } from '../lib/domain.js';
import {
  draftFromProcess,
  emptyPortRow,
  filterProjects,
  groupProjects,
  healthSegments,
  portHealthView,
  projectDraft,
  projectInput,
  rowKey,
  sortProjects,
  unregisteredDevServers,
  uptimeStats,
  validatePortRows,
} from '../lib/organize.js';
import { useConfig, useData, useInspect, useNav } from '../app/store.jsx';
import './Projects.css';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'partial', label: 'Partial' },
  { value: 'stopped', label: 'Stopped' },
  { value: 'conflict', label: 'Conflict' },
];
const SORTS = [
  { value: 'name', label: 'Sort: name' },
  { value: 'status', label: 'Sort: status' },
  { value: 'updated', label: 'Sort: recently updated' },
];
const HOSTS = ['localhost', '127.0.0.1', '::1'].map((h) => ({ value: h, label: h }));
const CHECKS = [
  { value: 'none', label: 'None' },
  { value: 'tcp', label: 'TCP' },
  { value: 'http', label: 'HTTP' },
];
const PROTOCOLS = [
  { value: 'tcp', label: 'TCP' },
  { value: 'udp', label: 'UDP' },
];
const PORT_STATUS = {
  up: { label: 'Up', tone: 'ok' },
  degraded: { label: 'Errors', tone: 'warn' },
  down: { label: 'Down', tone: 'danger' },
  unchecked: { label: 'Not checked', tone: '' },
  listening: { label: 'Listening', tone: 'ok' },
  idle: { label: 'Not listening', tone: '' },
};

/** Returns `value` after it has been stable for `ms`. */
export function useDebounced(value, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Key/value editor used for project metadata and profile startup notes. */
export function KvEditor({ rows, onChange, keyLabel = 'Key', valueLabel = 'Value', addLabel = 'Add row' }) {
  const set = (i, patch) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="stack tight">
      {rows.map((r, i) => (
        <div className="pj-kv-row" key={r.key}>
          <input className="input" aria-label={`${keyLabel} ${i + 1}`} placeholder={keyLabel} value={r.k} onChange={(e) => set(i, { k: e.target.value })} spellCheck={false} />
          <input className="input" aria-label={`${valueLabel} ${i + 1}`} placeholder={valueLabel} value={r.v} onChange={(e) => set(i, { v: e.target.value })} />
          <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Remove row ${i + 1}`} title="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <div>
        <Button size="sm" icon="plus" onClick={() => onChange([...rows, { key: rowKey(), k: '', v: '' }])}>
          {addLabel}
        </Button>
      </div>
    </div>
  );
}

export default function Projects() {
  const { projects, groups, loaded, reload } = useConfig();
  const { snapshot, health, conflicts, procByPid } = useData();
  const { params } = useNav();
  const toast = useToast();
  const confirm = useConfirm();

  const [search, setSearch] = useState('');
  const [groupId, setGroupId] = useState('');
  const [status, setStatus] = useState('');
  const [favOnly, setFavOnly] = useState(false);
  const [sort, setSort] = useState('name');
  const [grouped, setGrouped] = useState(true);
  const [editor, setEditor] = useState(null); // { id, draft }
  const [groupsOpen, setGroupsOpen] = useState(false);
  const [highlight, setHighlight] = useState(null);
  // Modal re-runs its focus effect when onClose changes, so keep these stable.
  const closeEditor = useCallback(() => setEditor(null), []);
  const closeGroups = useCallback(() => setGroupsOpen(false), []);

  const rows = useMemo(
    () => projects.map((project) => ({ project, status: projectStatus(project, snapshot, health, procByPid) })),
    [projects, snapshot, health, procByPid],
  );
  const visible = useMemo(
    () => sortProjects(filterProjects(rows, { search, groupId, status, favoritesOnly: favOnly }), sort),
    [rows, search, groupId, status, favOnly, sort],
  );
  const detected = useMemo(() => unregisteredDevServers(snapshot.processes, projects), [snapshot.processes, projects]);

  // Navigated here with a project id (e.g. from the dashboard): reveal and highlight it.
  const targetId = params?.projectId != null ? Number(params.projectId) : null;
  useEffect(() => {
    if (targetId == null || !loaded) return;
    setSearch('');
    setGroupId('');
    setStatus('');
    setFavOnly(false);
    setHighlight(targetId);
    const t = setTimeout(() => document.getElementById(`project-${targetId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 60);
    const t2 = setTimeout(() => setHighlight(null), 4000);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
  }, [targetId, loaded]);

  const toggleFavorite = async (p) => {
    try {
      await api.projectFavorite(p.id, !p.favorite);
      await reload('projects');
    } catch (e) {
      toast.fail('Could not update favorite', e);
    }
  };

  const remove = async (p) => {
    const ok = await confirm({
      title: `Delete project "${p.name}"?`,
      body: 'The project, its registered ports and health history are removed from Portly. Nothing on disk is touched and no process is stopped.',
      confirmLabel: 'Delete project',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.projectDelete(p.id);
      await reload('projects', 'groups', 'profiles');
      toast.ok('Project deleted', p.name);
    } catch (e) {
      toast.fail('Could not delete project', e);
    }
  };

  const openDir = async (p) => {
    try {
      await api.projectOpenDir(p.id);
    } catch (e) {
      toast.fail('Could not open folder', e);
    }
  };

  const groupOptions = [
    { value: '', label: 'All groups' },
    ...groups.map((g) => ({ value: String(g.id), label: g.name })),
    { value: 'none', label: 'Ungrouped' },
  ];
  const sections = grouped ? groupProjects(visible) : [{ name: null, items: visible }];
  const filtered = search || groupId || status || favOnly;

  return (
    <div className="page">
      <PageHeader
        title="Projects"
        sub="Local development servers you register, their ports and live health. Portly monitors only — it never starts or stops servers."
        actions={
          <>
            <Button icon="layers" onClick={() => setGroupsOpen(true)}>
              Groups
            </Button>
            <Button variant="primary" icon="plus" onClick={() => setEditor({ id: null, draft: projectDraft(null) })}>
              New project
            </Button>
          </>
        }
      />

      {loaded && projects.length > 0 && (
        <div className="toolbar">
          <SearchInput value={search} onChange={setSearch} placeholder="Search projects, ports, processes…" width={260} />
          <Select value={groupId} onChange={setGroupId} options={groupOptions} ariaLabel="Filter by group" />
          <Segmented value={status} onChange={setStatus} options={STATUS_FILTERS} ariaLabel="Filter by status" />
          <label className="row small muted">
            <Toggle checked={favOnly} onChange={setFavOnly} label="Favorites only" />
            Favorites
          </label>
          <span className="spacer" />
          <label className="row small muted">
            <Toggle checked={grouped} onChange={setGrouped} label="Group by group" />
            Group
          </label>
          <Select value={sort} onChange={setSort} options={SORTS} ariaLabel="Sort projects" />
        </div>
      )}

      {!loaded ? (
        <Loading label="Loading projects…" />
      ) : projects.length === 0 ? (
        <Card>
          <Empty
            icon="projects"
            title="No projects yet"
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditor({ id: null, draft: projectDraft(null) })}>
                Register a project
              </Button>
            }
          >
            Register a local project and the ports it uses. Portly will show whether each server is up, who occupies its ports and flag conflicts.
          </Empty>
        </Card>
      ) : visible.length === 0 ? (
        <Card>
          <Empty icon="filter" title="No matching projects">
            {filtered ? 'Try a different search or clear the filters.' : null}
          </Empty>
        </Card>
      ) : (
        sections.map((sec) => (
          <section key={sec.name || 'all'} className="stack">
            {sec.name && (
              <div className="section-title">
                {sec.name} <span className="faint">· {sec.items.length}</span>
              </div>
            )}
            {sec.items.map((row) => (
              <ProjectCard
                key={row.project.id}
                row={row}
                conflicts={conflictsFor(conflicts, { projectId: row.project.id })}
                highlight={highlight === row.project.id}
                onFavorite={() => toggleFavorite(row.project)}
                onEdit={() => setEditor({ id: row.project.id, draft: projectDraft(row.project) })}
                onDelete={() => remove(row.project)}
                onOpenDir={() => openDir(row.project)}
              />
            ))}
          </section>
        ))
      )}

      {loaded && detected.length > 0 && (
        <Card
          title="Detected dev servers not registered"
          sub="Processes that look like development servers and listen on ports no project registers."
        >
          <DetectedList items={detected} onRegister={(proc, ports) => setEditor({ id: null, draft: draftFromProcess(proc, ports) })} />
        </Card>
      )}

      {editor && (
        <ProjectEditor
          id={editor.id}
          initial={editor.draft}
          groups={groups}
          onClose={closeEditor}
          onSaved={async (p) => {
            setEditor(null);
            await reload('projects', 'groups');
            toast.ok(editor.id ? 'Project updated' : 'Project registered', p?.name);
          }}
        />
      )}
      {groupsOpen && <GroupsModal groups={groups} onClose={closeGroups} />}
    </div>
  );
}

function DetectedList({ items, onRegister }) {
  const { openProcess, openPort } = useInspect();
  return (
    <div className="list">
      {items.map(({ proc, ports }) => (
        <div className="list-item" key={proc.pid}>
          <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
            <div className="row">
              <button type="button" className="pj-linkish" onClick={() => openProcess(proc.pid)}>
                <strong>{proc.name}</strong>
              </button>
              <span className="mono xs faint">PID {proc.pid}</span>
              {proc.kind && <Badge tone="info">{proc.kind}</Badge>}
            </div>
            {proc.devReasons?.length > 0 && <div className="xs faint truncate">{proc.devReasons.join(' · ')}</div>}
          </div>
          <div className="row wrap">
            {ports.map((port) => (
              <button key={port} type="button" className="pj-linkish port-num" onClick={() => openPort('tcp', port)}>
                :{port}
              </button>
            ))}
          </div>
          <Button size="sm" icon="plus" onClick={() => onRegister(proc, ports)}>
            Register as project
          </Button>
        </div>
      ))}
    </div>
  );
}

function ProjectCard({ row, conflicts, highlight, onFavorite, onEdit, onDelete, onOpenDir }) {
  const { project: p, status } = row;
  const st = PROJECT_STATE[status.state] || PROJECT_STATE.empty;
  const meta = Object.entries(p.metadata || {});
  return (
    <section id={`project-${p.id}`} className={`card pj-card ${highlight ? 'highlight' : ''}`} aria-label={p.name}>
      <div className="pj-card-head">
        <Button
          size="sm"
          variant="ghost"
          icon={p.favorite ? 'star-filled' : 'star'}
          iconOnly
          aria-label={p.favorite ? `Remove ${p.name} from favorites` : `Add ${p.name} to favorites`}
          title={p.favorite ? 'Remove from favorites' : 'Add to favorites'}
          aria-pressed={p.favorite}
          onClick={onFavorite}
        />
        <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
          <div className="row wrap">
            <h2 className="pj-card-title">{p.name}</h2>
            <Badge tone={st.tone}>{st.label}</Badge>
            {status.total > 0 && (
              <span className="xs faint">
                {status.up}/{status.total} up
              </span>
            )}
            {p.groupName && <Badge icon="layers">{p.groupName}</Badge>}
          </div>
          {p.description && <div className="muted small">{p.description}</div>}
          <div className="row wrap xs faint">
            {p.directory && (
              <span className="mono truncate" title={p.directory} style={{ maxWidth: 420 }}>
                {p.directory}
              </span>
            )}
            {p.startCommand && (
              <span title="Reference only — Portly never runs it">
                <Icon name="terminal" size={11} /> <span className="mono">{p.startCommand}</span>
              </span>
            )}
            {meta.map(([k, v]) => (
              <span key={k}>
                {k}: <span className="muted">{v}</span>
              </span>
            ))}
            <span>Updated {ago(p.updatedAt)}</span>
          </div>
        </div>
        <div className="row">
          {p.directory && <Button size="sm" variant="ghost" icon="folder" iconOnly aria-label="Open project folder" title="Open project folder" onClick={onOpenDir} />}
          <Button size="sm" variant="ghost" icon="edit" iconOnly aria-label={`Edit ${p.name}`} title="Edit" onClick={onEdit} />
          <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Delete ${p.name}`} title="Delete" onClick={onDelete} />
        </div>
      </div>

      {conflicts.length > 0 && (
        <div className="stack tight" style={{ marginTop: 'var(--sp-3)' }}>
          {conflicts.map((c) => (
            <Callout key={c.id} tone={SEVERITY_TONE[c.severity] || 'info'} title={c.title}>
              {c.detail}
              {c.alternativePort && (
                <div style={{ marginTop: 4 }}>
                  Verified free alternative: <span className="port-num">{c.alternativePort}</span>
                </div>
              )}
              {c.suggestions?.length > 0 && <div className="xs faint" style={{ marginTop: 4 }}>{c.suggestions.join(' · ')}</div>}
            </Callout>
          ))}
        </div>
      )}

      {status.ports.length > 0 ? (
        <div className="pj-ports" role="list" aria-label={`Ports of ${p.name}`}>
          {status.ports.map((info) => (
            <PortRow key={info.pp.id} info={info} />
          ))}
        </div>
      ) : (
        <div className="xs faint" style={{ marginTop: 'var(--sp-3)' }}>
          No ports registered. Edit the project to add the ports its servers use.
        </div>
      )}
    </section>
  );
}

function PortRow({ info }) {
  const { pp, usage, owners, health, unexpected } = info;
  const { openPort, openProcess } = useInspect();
  const [history, setHistory] = useState(false);
  const view = portHealthView(pp, health, !!usage);
  const ps = PORT_STATUS[view.status] || PORT_STATUS.unchecked;
  const last = view.last;
  const url = `${pp.host === '::1' ? '[::1]' : pp.host}:${pp.port}`;
  return (
    <>
      <div className="pj-port" role="listitem">
        <div className="row">
          <button type="button" className="pj-linkish port-num" onClick={() => openPort(pp.protocol, pp.port)} title="Port details">
            {pp.port}
          </button>
          <span className="xs faint">{pp.protocol.toUpperCase()}</span>
        </div>
        <div className="stack tight" style={{ minWidth: 0 }}>
          <span className="truncate">{pp.role || <span className="faint">No role</span>}</span>
          <span className="xs faint mono truncate">
            {pp.host} · {pp.checkKind === 'http' ? `HTTP ${pp.httpPath}` : pp.checkKind === 'tcp' ? 'TCP check' : 'no check'}
          </span>
        </div>
        <div className="stack tight" style={{ minWidth: 0 }}>
          <span className="row">
            <Dot tone={ps.tone} pulse={view.status === 'down'} />
            <span>{ps.label}</span>
            {last?.latencyMs != null && <span className="xs faint mono">{last.latencyMs} ms</span>}
            {last?.httpStatus != null && <Badge tone={last.httpStatus < 400 ? 'ok' : 'warn'}>HTTP {last.httpStatus}</Badge>}
          </span>
          {last && (
            <span className="xs faint truncate" title={[...(last.responded || []).map((a) => `answered: ${a}`), ...(last.failed || []).map((a) => `failed: ${a}`), last.error].filter(Boolean).join('\n')}>
              {last.responded?.length ? `answered on ${last.responded.join(', ')}` : last.error || (last.failed?.length ? `no answer on ${last.failed.join(', ')}` : `checked ${ago(last.checkedAt)}`)}
            </span>
          )}
        </div>
        <div className="stack tight" style={{ minWidth: 0 }}>
          {owners.length ? (
            <span className="row wrap">
              {owners.map((o) => (
                <button key={o.pid} type="button" className="pj-linkish small" onClick={() => openProcess(o.pid)} title={`PID ${o.pid}`}>
                  {o.name} <span className="faint mono xs">{o.pid}</span>
                </button>
              ))}
            </span>
          ) : (
            <span className="faint small">Not in use</span>
          )}
          {unexpected && (
            <span className="xs row" style={{ color: 'var(--danger)' }}>
              <Icon name="alert" size={11} /> Occupied by an unrelated process (expected {pp.expectedProcess})
            </span>
          )}
          {!unexpected && pp.expectedProcess && <span className="xs faint">expects {pp.expectedProcess}</span>}
        </div>
        <div className="row">
          <CopyButton text={url} label={`Copy ${url}`} />
          {pp.checkKind !== 'none' && (
            <Button size="sm" variant="ghost" icon="history" iconOnly aria-label="Health history" aria-expanded={history} title="History (24 h)" onClick={() => setHistory((h) => !h)} />
          )}
        </div>
      </div>
      {history && (
        <div className="pj-port-extra">
          <HistoryStrip projectPortId={pp.id} />
        </div>
      )}
    </>
  );
}

function HistoryStrip({ projectPortId }) {
  const [samples, setSamples] = useState(null);
  const [error, setError] = useState(null);
  const [now] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    api
      .healthHistory(projectPortId, 24)
      .then((s) => alive && setSamples(s))
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
  }, [projectPortId]);
  if (error) return <div className="xs" style={{ color: 'var(--danger)' }}>Could not load history: {error.message}</div>;
  if (!samples) return <Loading label="Loading history…" />;
  if (!samples.length) return <div className="xs faint">No health samples in the last 24 hours. Samples are recorded while health monitoring runs.</div>;
  const stats = uptimeStats(samples);
  const segs = healthSegments(samples, { now, hours: 24, buckets: 48 });
  return (
    <div className="stack tight">
      <div className="row between xs">
        <span className="muted">
          Last 24 h · uptime <strong>{stats.pct == null ? '—' : percent(stats.pct)}</strong> · {plural(stats.checked, 'check')}
          {stats.down > 0 && <span style={{ color: 'var(--danger)' }}> · {stats.down} down</span>}
        </span>
        <span className="faint">
          {Object.entries(HEALTH_LABEL).map(([k, l]) => (
            <span key={k} style={{ marginLeft: 8 }}>
              <Dot tone={HEALTH_TONE[k]} /> {l}
            </span>
          ))}
        </span>
      </div>
      <div className="pj-strip" role="img" aria-label={`Health over the last 24 hours, uptime ${stats.pct == null ? 'unknown' : percent(stats.pct)}`}>
        {segs.map((s) => (
          <span key={s.start} className={s.status} title={`${dateTime(s.start)} — ${s.count ? `${HEALTH_LABEL[s.status] || s.status} (${s.count})` : 'no samples'}`} />
        ))}
      </div>
      <div className="row between xs faint mono">
        <span>-24 h</span>
        <span>now</span>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- editor

function ProjectEditor({ id, initial, groups, onClose, onSaved }) {
  const { reload } = useConfig();
  const toast = useToast();
  const [d, setD] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [newGroup, setNewGroup] = useState(null);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));
  const portErrors = validatePortRows(d.ports);

  const browse = async () => {
    try {
      const dir = await open({ directory: true, multiple: false, defaultPath: d.directory || undefined });
      if (typeof dir === 'string') set({ directory: dir });
    } catch (e) {
      toast.fail('Folder picker failed', e);
    }
  };

  const createGroup = async () => {
    const name = (newGroup || '').trim();
    if (!name) return;
    try {
      const gid = await api.groupSave(null, name);
      await reload('groups');
      set({ groupId: String(gid) });
      setNewGroup(null);
    } catch (e) {
      setError(e.message || String(e));
    }
  };

  const save = async (e) => {
    e?.preventDefault();
    const built = projectInput(d);
    if (built.error) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      const p = await api.projectSave(id, built.input);
      await onSaved(p);
    } catch (err) {
      setError(err.message || String(err));
      setSaving(false);
    }
  };

  const setPort = (i, patch) => set({ ports: d.ports.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <Modal
      wide
      title={id ? `Edit project — ${initial.name}` : 'New project'}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" icon="check" onClick={save} disabled={saving}>
            {saving ? 'Saving…' : id ? 'Save changes' : 'Register project'}
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={save}>
        {error && (
          <Callout tone="danger" title="Could not save">
            {error}
          </Callout>
        )}
        <div className="pj-editor-grid">
          <Field label="Name">
            <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} required />
          </Field>
          <Field label="Group">
            {newGroup == null ? (
              <Select
                value={d.groupId}
                ariaLabel="Group"
                onChange={(v) => (v === '__new' ? setNewGroup('') : set({ groupId: v }))}
                options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: String(g.id), label: g.name })), { value: '__new', label: 'New group…' }]}
              />
            ) : (
              <div className="row">
                <input
                  className="input"
                  aria-label="New group name"
                  placeholder="New group name"
                  value={newGroup}
                  autoFocus
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      createGroup();
                    }
                  }}
                  style={{ flex: 1 }}
                />
                <Button size="sm" variant="primary" onClick={createGroup} disabled={!newGroup.trim()}>
                  Create
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setNewGroup(null)}>
                  Cancel
                </Button>
              </div>
            )}
          </Field>
          <Field label="Description" style={{ gridColumn: '1 / -1' }}>
            <textarea className="textarea" rows={2} value={d.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label="Directory" hint="Absolute path to the project folder (optional)." style={{ gridColumn: '1 / -1' }}>
            <div className="row">
              <input className="input mono" value={d.directory} onChange={(e) => set({ directory: e.target.value })} placeholder={'C:\\code\\my-app'} spellCheck={false} style={{ flex: 1 }} />
              <Button icon="folder" onClick={browse}>
                Browse…
              </Button>
            </div>
          </Field>
          <Field label="Start command (reference only — Portly never runs it)" style={{ gridColumn: '1 / -1' }}>
            <input className="input mono" value={d.startCommand} onChange={(e) => set({ startCommand: e.target.value })} placeholder="npm run dev" spellCheck={false} />
          </Field>
          <label className="row small" style={{ gridColumn: '1 / -1' }}>
            <Toggle checked={d.favorite} onChange={(v) => set({ favorite: v })} label="Favorite" />
            Favorite
          </label>
        </div>

        <div>
          <div className="section-title">Ports</div>
          <div className="stack tight">
            {d.ports.map((r, i) => (
              <PortEditRow
                key={r.key}
                row={r}
                index={i}
                projectId={id}
                error={portErrors[i]}
                onChange={(patch) => setPort(i, patch)}
                onRemove={() => set({ ports: d.ports.filter((_, j) => j !== i) })}
              />
            ))}
            {!d.ports.length && <div className="xs faint">No ports. Add the ports this project's servers listen on.</div>}
            <div>
              <Button size="sm" icon="plus" onClick={() => set({ ports: [...d.ports, emptyPortRow()] })} disabled={d.ports.length >= 32}>
                Add port
              </Button>
            </div>
          </div>
        </div>

        <div>
          <div className="section-title">Metadata</div>
          <KvEditor rows={d.metadata} onChange={(metadata) => set({ metadata })} keyLabel="Key" valueLabel="Value" addLabel="Add field" />
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

function PortEditRow({ row, index, projectId, error, onChange, onRemove }) {
  const { snapshot, procByPid } = useData();
  const toast = useToast();
  const [avail, setAvail] = useState(null);
  const [checking, setChecking] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const portNum = /^\d+$/.test(String(row.port).trim()) ? Number(row.port) : null;
  const valid = portNum != null && portNum >= 1 && portNum <= 65535;
  const debounced = useDebounced(valid ? `${row.protocol}:${portNum}` : null, 400);
  const reqSeq = useRef(0);

  useEffect(() => {
    if (!debounced) return;
    const [protocol, port] = debounced.split(':');
    const seq = ++reqSeq.current;
    setChecking(true);
    api
      .portCheck(protocol, Number(port))
      .then((a) => seq === reqSeq.current && setAvail(a))
      .catch(() => seq === reqSeq.current && setAvail(null))
      .finally(() => seq === reqSeq.current && setChecking(false));
  }, [debounced]);

  const occupant = useMemo(() => {
    if (!valid) return null;
    const u = snapshot.ports.find((x) => x.protocol === row.protocol && x.port === portNum);
    const pid = u?.pids?.[0];
    return pid != null ? procByPid.get(pid)?.name || null : null;
  }, [snapshot.ports, procByPid, row.protocol, portNum, valid]);

  const suggest = async () => {
    setSuggesting(true);
    try {
      const start = valid ? portNum : 3000;
      const [p] = await api.portSuggest(row.protocol, start, Math.min(65535, start + 1000), 1);
      if (p) onChange({ port: String(p) });
      else toast.warn('No free port found', `Nothing free between ${start} and ${Math.min(65535, start + 1000)}.`);
    } catch (e) {
      toast.fail('Could not suggest a port', e);
    } finally {
      setSuggesting(false);
    }
  };

  const current = avail && valid && avail.port === portNum && avail.protocol === row.protocol ? avail : null;
  let hint = null;
  if (valid && current) {
    const names = current.occupiedBy.map((pid) => procByPid.get(pid)?.name || `PID ${pid}`);
    const claims = current.claims.filter((c) => !(c.source === 'project' && c.id === projectId));
    if (current.osExcluded) hint = { tone: 'danger', text: 'Excluded by Windows — no program can bind it' };
    else if (names.length) hint = { tone: 'warn', text: `In use by ${[...new Set(names)].join(', ')}` };
    else if (current.available) hint = { tone: 'ok', text: 'Free' };
    else hint = { tone: 'warn', text: current.summary };
    if (claims.length) hint.claims = claims.map((c) => `${c.source === 'reservation' ? 'personal reservation' : c.source} "${c.label}"`).join(', ');
  }

  const n = index + 1;
  return (
    <div className="pj-port-edit" role="group" aria-label={`Port row ${n}`}>
      <Field label="Port" error={row.port !== '' ? error : null}>
        <input className="input mono" inputMode="numeric" value={row.port} onChange={(e) => onChange({ port: e.target.value.replace(/[^\d]/g, '') })} placeholder="3000" />
      </Field>
      <Field label="Protocol">
        <Select
          value={row.protocol}
          ariaLabel={`Protocol, row ${n}`}
          options={PROTOCOLS}
          onChange={(v) => onChange(v === 'udp' ? { protocol: v, checkKind: 'none' } : { protocol: v })}
        />
      </Field>
      <Field label="Role">
        <input className="input" value={row.role} onChange={(e) => onChange({ role: e.target.value })} placeholder="web, api, db…" />
      </Field>
      <Field label="Host">
        <Select value={row.host} ariaLabel={`Host, row ${n}`} options={HOSTS} onChange={(v) => onChange({ host: v })} />
      </Field>
      <Field label="Health check">
        <Select
          value={row.checkKind}
          ariaLabel={`Health check, row ${n}`}
          options={row.protocol === 'udp' ? CHECKS.slice(0, 1) : CHECKS}
          onChange={(v) => onChange({ checkKind: v })}
        />
      </Field>
      {row.checkKind === 'http' && (
        <Field label="HTTP path">
          <input className="input mono" value={row.httpPath} onChange={(e) => onChange({ httpPath: e.target.value })} placeholder="/" spellCheck={false} />
        </Field>
      )}
      <Field label="Expected process (optional)" style={{ gridColumn: row.checkKind === 'http' ? 'span 2' : 'span 3' }}>
        <div className="row">
          <input className="input mono" value={row.expectedProcess} onChange={(e) => onChange({ expectedProcess: e.target.value })} placeholder="node.exe" spellCheck={false} style={{ flex: 1 }} />
          <Button size="sm" disabled={!occupant} onClick={() => onChange({ expectedProcess: occupant })} title={occupant ? `Use ${occupant}` : 'Nothing is listening on this port'}>
            Use current occupant
          </Button>
        </div>
      </Field>
      <div className="row" style={{ gridColumn: 'span 2', justifyContent: 'flex-end', alignSelf: 'end' }}>
        <Button size="sm" icon="zap" onClick={suggest} disabled={suggesting}>
          Suggest free port
        </Button>
        <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Remove port row ${n}`} title="Remove port" onClick={onRemove} />
      </div>
      <div className="full xs row wrap" aria-live="polite">
        {!valid ? (
          <span className="faint">Enter a port to check availability.</span>
        ) : checking && !current ? (
          <span className="faint">Checking…</span>
        ) : hint ? (
          <>
            <Badge tone={hint.tone}>{hint.text}</Badge>
            {hint.claims && <span className="faint">Also registered as {hint.claims}</span>}
          </>
        ) : null}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- groups

function GroupsModal({ groups, onClose }) {
  const { reload } = useConfig();
  const toast = useToast();
  const confirm = useConfirm();
  const [names, setNames] = useState(() => Object.fromEntries(groups.map((g) => [g.id, g.name])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setNames((prev) => Object.fromEntries(groups.map((g) => [g.id, prev[g.id] ?? g.name])));
  }, [groups]);

  const run = useCallback(
    async (fn) => {
      setBusy(true);
      setError(null);
      try {
        await fn();
        await reload('groups', 'projects');
      } catch (e) {
        setError(e.message || String(e));
      } finally {
        setBusy(false);
      }
    },
    [reload],
  );

  const rename = (g) => run(async () => {
    await api.groupSave(g.id, names[g.id]);
    toast.ok('Group renamed', names[g.id]);
  });
  const remove = async (g) => {
    const ok = await confirm({
      title: `Delete group "${g.name}"?`,
      body: g.projectCount ? `${plural(g.projectCount, 'project')} in this group will become ungrouped. The projects themselves are kept.` : 'The group is empty.',
      confirmLabel: 'Delete group',
      danger: true,
    });
    if (ok) run(() => api.groupDelete(g.id));
  };

  return (
    <Modal title="Project groups" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
      <div className="stack">
        {error && <Callout tone="danger">{error}</Callout>}
        {groups.length === 0 ? (
          <Empty icon="layers" title="No groups">
            Create groups from the project editor ("New group…") to organize projects.
          </Empty>
        ) : (
          groups.map((g) => (
            <div key={g.id} className="row">
              <input className="input" aria-label={`Name of group ${g.name}`} value={names[g.id] ?? ''} onChange={(e) => setNames((n) => ({ ...n, [g.id]: e.target.value }))} style={{ flex: 1 }} />
              <span className="xs faint" style={{ width: 70 }}>
                {plural(g.projectCount, 'project')}
              </span>
              <Button size="sm" disabled={busy || !names[g.id]?.trim() || names[g.id] === g.name} onClick={() => rename(g)}>
                Rename
              </Button>
              <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Delete group ${g.name}`} title="Delete group" disabled={busy} onClick={() => remove(g)} />
            </div>
          ))
        )}
      </div>
    </Modal>
  );
}
