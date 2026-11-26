import { useCallback, useEffect, useState } from 'react';
import Drawer from './ui/Drawer.jsx';
import { Badge, Button, Callout, CopyButton, Field, Loading, ProcIcon, Toggle } from './ui/primitives.jsx';
import { useToast } from './ui/Toast.jsx';
import { api } from '../lib/api.js';
import { EVENT_LABEL, SCOPE_LABEL, SCOPE_TONE, ago, endpoint } from '../lib/format.js';
import { useConfig, useData, useInspect } from '../app/store.jsx';
import { conflictsFor } from '../lib/domain.js';

const CATEGORIES = ['', 'web', 'api', 'database', 'cache', 'proxy', 'tooling', 'testing', 'system', 'other'];

export default function PortDrawer({ protocol, port }) {
  const { openProcess, close } = useInspect();
  const { procByPid, iconFor, conflicts } = useData();
  const { reload } = useConfig();
  const toast = useToast();
  const [detail, setDetail] = useState(null);
  const [avail, setAvail] = useState(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState({ label: '', note: '', category: '', favorite: false });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    setError(null);
    return api
      .portDetail(protocol, port)
      .then((d) => {
        setDetail(d);
        setNote(d.note || { label: '', note: '', category: '', favorite: false });
        setDirty(false);
      })
      .catch(setError);
  }, [protocol, port]);

  const check = useCallback(() => {
    setChecking(true);
    return api
      .portCheck(protocol, port)
      .then(setAvail)
      .catch((e) => toast.fail('Availability check failed', e))
      .finally(() => setChecking(false));
  }, [protocol, port, toast]);

  useEffect(() => {
    setDetail(null);
    setAvail(null);
    load();
    check();
  }, [load, check]);

  const save = async (patch) => {
    const next = { ...note, ...patch, protocol, port };
    try {
      await api.portNoteSave(next);
      setNote(next);
      setDirty(false);
      reload('notes');
      toast.ok('Saved', `Notes for port ${port} updated.`);
    } catch (e) {
      toast.fail('Could not save', e);
    }
  };

  const usage = detail?.usage;
  const related = conflictsFor(conflicts, { protocol, port });
  const set = (k) => (e) => {
    setNote((n) => ({ ...n, [k]: e.target.value }));
    setDirty(true);
  };

  return (
    <Drawer
      title={
        <span>
          Port <span className="port-num">{port}</span> <span className="faint" style={{ fontWeight: 400 }}>{protocol.toUpperCase()}</span>
        </span>
      }
      subtitle={usage?.wellKnown ? `Commonly used by ${usage.wellKnown}` : usage ? 'In use' : 'Not in use'}
      onClose={close}
      actions={
        <>
          <Button
            size="sm"
            variant="ghost"
            icon={note.favorite ? 'star-filled' : 'star'}
            iconOnly
            aria-label={note.favorite ? 'Remove from favorites' : 'Add to favorites'}
            title={note.favorite ? 'Remove from favorites' : 'Add to favorites'}
            onClick={() => save({ favorite: !note.favorite })}
          />
          <CopyButton text={String(port)} label="Copy port" />
        </>
      }
    >
      {!detail && !error && <Loading />}
      {error && <Callout tone="danger" title="Could not load port details">{error.message}</Callout>}
      {detail && (
        <>
          {related.map((c) => (
            <Callout key={c.id} tone={c.severity === 'error' ? 'danger' : c.severity === 'warning' ? 'warn' : 'info'} title={c.title}>
              {c.detail}
              {c.alternativePort && (
                <div style={{ marginTop: 6 }}>
                  Verified free alternative: <span className="port-num">{c.alternativePort}</span>
                </div>
              )}
            </Callout>
          ))}

          <section>
            <div className="section-title">Availability</div>
            {detail.osExcluded ? (
              <Callout tone="danger" title="Excluded by Windows">
                Windows has excluded {detail.osExcluded.start}–{detail.osExcluded.end} for {detail.osExcluded.protocol.toUpperCase()} (
                {detail.osExcluded.administered ? 'administrator-defined' : 'typically Hyper-V, WSL, Docker or WinNAT'}). No program can bind
                this port while the exclusion exists.
              </Callout>
            ) : null}
            {avail ? (
              <Callout tone={avail.available ? 'ok' : usage ? 'info' : 'warn'} title={avail.available ? 'Available' : usage ? 'Occupied' : 'Not available'}>
                {avail.summary}
                {avail.bindError && <div className="mono xs faint">{avail.bindError}</div>}
              </Callout>
            ) : (
              <Loading label="Checking…" />
            )}
            <div className="row" style={{ marginTop: 8 }}>
              <Button size="sm" icon="refresh" disabled={checking} onClick={check}>
                Re-check
              </Button>
              {!detail.osExclusionsVerified && <span className="xs faint">Windows exclusions could not be verified.</span>}
            </div>
          </section>

          <section>
            <div className="section-title">Bindings</div>
            {usage ? (
              <div className="stack tight">
                {usage.bindings.map((b) => {
                  const p = procByPid.get(b.pid);
                  return (
                    <div key={`${b.addr}-${b.pid}`} className="row between card" style={{ padding: '8px 12px' }}>
                      <div className="stack tight" style={{ minWidth: 0 }}>
                        <span className="mono">{endpoint(b.addr, port)}</span>
                        <span className="row">
                          <Badge tone={SCOPE_TONE[b.scope]}>{SCOPE_LABEL[b.scope]}</Badge>
                          <span className="xs faint">{b.family === 'ipv6' ? 'IPv6' : 'IPv4'}</span>
                        </span>
                      </div>
                      <button type="button" className="btn ghost sm" onClick={() => openProcess(b.pid)}>
                        <ProcIcon src={iconFor(b.pid)} />
                        {p?.name || `PID ${b.pid}`} <span className="mono faint">{b.pid}</span>
                      </button>
                    </div>
                  );
                })}
                {protocol === 'tcp' && <p className="small muted">{usage.connections} established connection(s) on this port.</p>}
              </div>
            ) : (
              <p className="faint small">Nothing is listening on this port right now.</p>
            )}
          </section>

          <section>
            <div className="section-title">Claimed in Portly</div>
            {detail.claims.length ? (
              <div className="row wrap">
                {detail.claims.map((c) => (
                  <Badge key={`${c.source}${c.id}`} tone={c.source === 'reservation' ? 'info' : ''} icon={c.source === 'project' ? 'projects' : c.source === 'plan' ? 'map' : 'lock'}>
                    {c.source === 'reservation' ? 'Personal reservation' : c.source}: {c.label}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="faint small">No project, plan or personal reservation uses this port.</p>
            )}
            <p className="xs faint" style={{ marginTop: 6 }}>
              Personal reservations are notes inside Portly; they don't stop other programs from using a port.
            </p>
          </section>

          <section className="stack">
            <div className="section-title">Label & notes</div>
            <div className="row">
              <Field label="Label" style={{ flex: 1 }}>
                <input className="input" value={note.label} onChange={set('label')} maxLength={200} placeholder="e.g. Shop API" />
              </Field>
              <Field label="Category">
                <select className="select" value={note.category} onChange={set('category')}>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c || 'None'}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Notes">
              <textarea className="textarea" value={note.note} onChange={set('note')} maxLength={4000} rows={3} />
            </Field>
            <div className="row between">
              <label className="row small">
                <Toggle checked={note.favorite} onChange={(v) => save({ favorite: v })} label="Favorite" /> Favorite port
              </label>
              <Button size="sm" variant="primary" disabled={!dirty} onClick={() => save({})}>
                Save notes
              </Button>
            </div>
          </section>

          <section>
            <div className="section-title">History</div>
            {detail.history.length ? (
              <div className="stack tight">
                {detail.history.map((e) => (
                  <div key={e.id} className="row small" style={{ alignItems: 'flex-start' }}>
                    <span className="faint" style={{ width: 90, flex: 'none' }}>{ago(e.ts)}</span>
                    <span>
                      <strong>{EVENT_LABEL[e.kind] || e.kind}</strong> <span className="muted">{e.message}</span>
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="faint small">No recorded events for this port. Port history is recorded for registered, favorite, reserved and planned ports (or all ports, if enabled in Settings).</p>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
