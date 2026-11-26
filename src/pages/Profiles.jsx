import { useCallback, useMemo, useState } from 'react';
import { Badge, Button, Callout, Card, Empty, Field, Loading, PageHeader, Select, Toggle } from '../components/ui/primitives.jsx';
import { Modal, useConfirm } from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import Icon from '../components/ui/Icon.jsx';
import { api } from '../lib/api.js';
import { plural } from '../lib/format.js';
import { projectStatus } from '../lib/domain.js';
import {
  PROFILE_KIND_ICON,
  PROFILE_KIND_LABEL,
  PROFILE_TEMPLATES,
  aggregateStatus,
  aggregateTone,
  profileDraft,
  profileInput,
  toggleId,
} from '../lib/organize.js';
import { useConfig, useData, useNav, useSettings } from '../app/store.jsx';
import { KvEditor } from './Projects.jsx';
import './Projects.css';

const KIND_OPTIONS = Object.entries(PROFILE_KIND_LABEL).map(([value, label]) => ({ value, label }));

export default function Profiles() {
  const { profiles, projects, plans, loaded, reload } = useConfig();
  const { snapshot, health, procByPid } = useData();
  const { settings, setSettings } = useSettings();
  const { navigate } = useNav();
  const toast = useToast();
  const confirm = useConfirm();
  const [editor, setEditor] = useState(null); // { id, draft }
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(null);
  const closeEditor = useCallback(() => setEditor(null), []);
  const closePicker = useCallback(() => setPicking(false), []);

  const activeId = settings?.general?.activeProfileId ?? null;
  const stateByProject = useMemo(
    () => new Map(projects.map((p) => [p.id, projectStatus(p, snapshot, health, procByPid).state])),
    [projects, snapshot, health, procByPid],
  );

  const activate = async (p) => {
    const next = activeId === p.id ? null : p.id;
    setBusy(p.id);
    try {
      const saved = await api.profileActivate(next);
      setSettings(saved);
      toast.ok(next ? `"${p.name}" is active` : 'Profile deactivated', next ? 'Dashboard and health monitoring now focus on its projects.' : 'All projects are in scope again.');
    } catch (e) {
      toast.fail('Could not change the active profile', e);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (p) => {
    const ok = await confirm({
      title: `Delete profile "${p.name}"?`,
      body: activeId === p.id ? 'This profile is active; deleting it clears the active profile. Projects and plans are kept.' : 'Projects and plans linked to it are kept.',
      confirmLabel: 'Delete profile',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.profileDelete(p.id);
      await reload('profiles', 'projects', 'plans');
      if (activeId === p.id) {
        const s = await api.settings().catch(() => null);
        if (s) setSettings(s);
      }
      toast.ok('Profile deleted', p.name);
    } catch (e) {
      toast.fail('Could not delete profile', e);
    }
  };

  return (
    <div className="page">
      <PageHeader
        title="Server Profiles"
        sub="Named sets of projects for different kinds of work. Activating a profile focuses the dashboard and health monitoring on its projects — it never starts or runs anything."
        actions={
          <Button variant="primary" icon="plus" onClick={() => setPicking(true)}>
            New profile
          </Button>
        }
      />

      {!loaded || !settings ? (
        <Loading label="Loading profiles…" />
      ) : profiles.length === 0 ? (
        <Card>
          <Empty
            icon="profiles"
            title="No profiles yet"
            action={
              <Button variant="primary" icon="plus" onClick={() => setPicking(true)}>
                Create from a template
              </Button>
            }
          >
            Group projects into profiles such as "Web development" or "Testing", then activate one to focus monitoring on it.
          </Empty>
        </Card>
      ) : (
        <div className="grid cols-2">
          {profiles.map((p) => {
            const active = activeId === p.id;
            const agg = aggregateStatus(p.projectIds.map((id) => stateByProject.get(id)).filter(Boolean));
            const tone = aggregateTone(agg);
            const linkedPlans = p.planIds.map((id) => plans.find((x) => x.id === id)?.name).filter(Boolean);
            const linkedProjects = p.projectIds.map((id) => projects.find((x) => x.id === id)).filter(Boolean);
            const startup = Object.entries(p.startup || {});
            return (
              <section key={p.id} className={`card pj-card ${active ? 'active' : ''}`} aria-label={p.name}>
                <div className="pj-profile-head">
                  <span className="pj-profile-icon" aria-hidden="true">
                    <Icon name={PROFILE_KIND_ICON[p.kind] || 'tag'} size={16} />
                  </span>
                  <div className="stack tight" style={{ flex: 1, minWidth: 0 }}>
                    <div className="row wrap">
                      <h2 className="pj-card-title">{p.name}</h2>
                      {active && (
                        <Badge tone="ok" icon="check">
                          Active
                        </Badge>
                      )}
                    </div>
                    <span className="xs faint">{PROFILE_KIND_LABEL[p.kind] || p.kind}</span>
                  </div>
                  <div className="row">
                    <Button size="sm" variant="ghost" icon="edit" iconOnly aria-label={`Edit ${p.name}`} title="Edit" onClick={() => setEditor({ id: p.id, draft: profileDraft(p) })} />
                    <Button size="sm" variant="ghost" icon="trash" iconOnly aria-label={`Delete ${p.name}`} title="Delete" onClick={() => remove(p)} />
                  </div>
                </div>

                {p.description && <p className="muted small" style={{ margin: 'var(--sp-3) 0 0' }}>{p.description}</p>}

                <dl className="kv small" style={{ marginTop: 'var(--sp-3)' }}>
                  <dt>Projects</dt>
                  <dd>
                    {linkedProjects.length ? (
                      <span className="row wrap">
                        {linkedProjects.map((x) => (
                          <button key={x.id} type="button" className="pj-linkish" onClick={() => navigate('projects', { projectId: x.id })}>
                            {x.name}
                          </button>
                        ))}
                      </span>
                    ) : (
                      <span className="faint">None</span>
                    )}
                  </dd>
                  <dt>Status</dt>
                  <dd>
                    {agg.total ? (
                      <span className="row wrap">
                        <Badge tone={tone}>
                          {agg.running}/{agg.total} running
                        </Badge>
                        {agg.partial > 0 && <Badge tone="warn">{agg.partial} partial</Badge>}
                        {agg.conflict > 0 && <Badge tone="danger">{plural(agg.conflict, 'conflict')}</Badge>}
                      </span>
                    ) : (
                      <span className="faint">—</span>
                    )}
                  </dd>
                  <dt>Plans</dt>
                  <dd>{linkedPlans.length ? linkedPlans.join(', ') : <span className="faint">None</span>}</dd>
                  <dt>Health</dt>
                  <dd>{p.monitorHealth ? 'Checked while active' : <span className="faint">Not checked</span>}</dd>
                  {startup.length > 0 && (
                    <>
                      <dt>Startup notes</dt>
                      <dd className="xs">
                        {startup.map(([k, v]) => (
                          <div key={k}>
                            {k}: <span className="muted">{v}</span>
                          </div>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>
                {p.notes && <div className="xs faint" style={{ marginTop: 'var(--sp-2)', whiteSpace: 'pre-wrap' }}>{p.notes}</div>}

                <div className="row" style={{ marginTop: 'var(--sp-3)', justifyContent: 'flex-end' }}>
                  <Button size="sm" variant={active ? '' : 'primary'} icon={active ? 'pause' : 'play'} disabled={busy != null} onClick={() => activate(p)}>
                    {active ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              </section>
            );
          })}
        </div>
      )}

      {picking && (
        <TemplatePicker
          onClose={closePicker}
          onPick={(t) => {
            setPicking(false);
            setEditor({ id: null, draft: profileDraft(null, t) });
          }}
        />
      )}
      {editor && (
        <ProfileEditor
          id={editor.id}
          initial={editor.draft}
          projects={projects}
          onClose={closeEditor}
          onSaved={async (p) => {
            setEditor(null);
            await reload('profiles', 'projects');
            toast.ok(editor.id ? 'Profile updated' : 'Profile created', p?.name);
          }}
        />
      )}
    </div>
  );
}

function TemplatePicker({ onClose, onPick }) {
  return (
    <Modal title="New profile" onClose={onClose} footer={<Button variant="ghost" onClick={onClose}>Cancel</Button>}>
      <div className="stack tight">
        <p className="muted small" style={{ margin: 0 }}>Start from a template. You can change everything afterwards.</p>
        <div className="list card flush">
          {PROFILE_TEMPLATES.map((t) => (
            <button key={t.kind} type="button" className="list-item clickable pj-linkish" style={{ width: '100%' }} onClick={() => onPick(t)}>
              <span className="pj-profile-icon" aria-hidden="true">
                <Icon name={PROFILE_KIND_ICON[t.kind]} size={16} />
              </span>
              <span className="stack tight">
                <strong>{t.name}</strong>
                {t.description && <span className="xs faint">{t.description}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ProfileEditor({ id, initial, projects, onClose, onSaved }) {
  const [d, setD] = useState(initial);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (patch) => setD((x) => ({ ...x, ...patch }));

  const submit = async (e) => {
    e?.preventDefault();
    const built = profileInput(d);
    if (built.error) return setError(built.error);
    setSaving(true);
    setError(null);
    try {
      const p = await api.profileSave(id, built.input);
      await onSaved(p);
    } catch (er) {
      setError(er.message);
      setSaving(false);
    }
  };

  return (
    <Modal
      wide
      title={id ? `Edit profile — ${initial.name}` : 'New profile'}
      onClose={onClose}
      dismissable={!saving}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" icon="check" onClick={submit} disabled={saving}>
            {saving ? 'Saving…' : 'Save profile'}
          </Button>
        </>
      }
    >
      <form className="stack" onSubmit={submit}>
        {error && <Callout tone="danger" title="Could not save">{error}</Callout>}
        <div className="pj-editor-grid">
          <Field label="Name">
            <input className="input" value={d.name} onChange={(e) => set({ name: e.target.value })} maxLength={120} />
          </Field>
          <Field label="Kind">
            <Select value={d.kind} onChange={(v) => set({ kind: v })} options={KIND_OPTIONS} ariaLabel="Kind" />
          </Field>
          <Field label="Description" style={{ gridColumn: '1 / -1' }}>
            <input className="input" value={d.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>
          <Field label="Notes" style={{ gridColumn: '1 / -1' }}>
            <textarea className="textarea" rows={3} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
          </Field>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <div>Health-check this profile's projects while active</div>
            <div className="setting-desc">Runs the configured TCP/HTTP checks for these projects' ports. Nothing is started.</div>
          </div>
          <Toggle checked={d.monitorHealth} onChange={(v) => set({ monitorHealth: v })} label="Health-check this profile's projects while active" />
        </div>

        <div>
          <div className="row between">
            <div className="section-title">Projects</div>
            <span className="xs faint">{d.projectIds.length} selected</span>
          </div>
          {projects.length ? (
            <div className="pj-check-list">
              {projects.map((p) => (
                <label key={p.id}>
                  <input type="checkbox" checked={d.projectIds.includes(p.id)} onChange={() => set({ projectIds: toggleId(d.projectIds, p.id) })} />
                  <span>{p.name}</span>
                  {p.groupName && <span className="xs faint">{p.groupName}</span>}
                  <span className="spacer" />
                  <span className="xs faint mono">{p.ports.map((x) => x.port).join(', ')}</span>
                </label>
              ))}
            </div>
          ) : (
            <div className="small muted">No projects registered yet. You can add them to this profile later.</div>
          )}
        </div>

        <div>
          <div className="section-title">Startup notes (metadata only — never executed)</div>
          <KvEditor rows={d.startup} onChange={(startup) => set({ startup })} keyLabel="Name" valueLabel="Note" addLabel="Add note" />
        </div>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}
