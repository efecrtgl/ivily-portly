import { useCallback, useEffect, useState } from 'react';
import Drawer from './ui/Drawer.jsx';
import Icon from './ui/Icon.jsx';
import { Badge, Button, Callout, CopyButton, Loading, ProcIcon } from './ui/primitives.jsx';
import { useConfirm } from './ui/Modal.jsx';
import { useToast } from './ui/Toast.jsx';
import { api } from '../lib/api.js';
import { CATEGORY_LABEL, bytes, dateTime, duration, percent } from '../lib/format.js';
import { useData, useInspect } from '../app/store.jsx';
import { conflictsFor } from '../lib/domain.js';

const RISK_LABEL = { low: 'Low risk', medium: 'Medium risk', high: 'High risk', blocked: 'Blocked' };
const RISK_TONE = { low: 'ok', medium: 'warn', high: 'danger', blocked: 'danger' };

export default function ProcessDrawer({ pid }) {
  const { openPort, openProcess, close } = useInspect();
  const { conflicts } = useData();
  const confirm = useConfirm();
  const toast = useToast();
  const [view, setView] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(
    (record = true) => {
      setError(null);
      return api
        .inspect(pid, record)
        .then(setView)
        .catch((e) => {
          setView(null);
          setError(e);
        });
    },
    [pid],
  );

  useEffect(() => {
    setView(null);
    load(true);
  }, [load]);

  const info = view?.info;
  const sum = view?.summary;
  const term = view?.termination;
  const related = conflictsFor(conflicts, { pid });

  const details = info
    ? [
        `Process: ${info.name}`,
        `PID: ${info.pid}`,
        info.parentPid ? `Parent: ${info.parentName || '?'} (${info.parentPid})` : null,
        info.path ? `Path: ${info.path}` : null,
        info.owner ? `Owner: ${info.owner}` : null,
        info.startTime ? `Started: ${new Date(info.startTime).toISOString()}` : null,
        sum?.listenPorts?.length ? `TCP listening: ${sum.listenPorts.join(', ')}` : null,
        sum?.udpPorts?.length ? `UDP bound: ${sum.udpPorts.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const terminate = async () => {
    if (!term?.allowed) return;
    const ok = await confirm({
      title: `Terminate ${info.name}?`,
      danger: true,
      confirmLabel: 'Terminate process',
      typeToConfirm: term.risk === 'high' ? info.name : undefined,
      body: (
        <div className="stack">
          <p>
            This ends <strong>{info.name}</strong> (PID <span className="mono">{info.pid}</span>) immediately. Portly never terminates
            processes on its own and does not elevate privileges.
          </p>
          <div className="row">
            <Badge tone={RISK_TONE[term.risk]}>{RISK_LABEL[term.risk]}</Badge>
          </div>
          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
            {term.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.terminate(info.pid, info.startTime ?? null, true);
      toast.ok('Process terminated', `${info.name} (PID ${info.pid}) was ended.`);
      close();
    } catch (e) {
      toast.fail('Could not terminate the process', e);
      load(false);
    } finally {
      setBusy(false);
    }
  };

  const openLocation = async () => {
    try {
      await api.openLocation(pid);
    } catch (e) {
      toast.fail('Could not open the file location', e);
    }
  };

  return (
    <Drawer
      title={info?.name || `PID ${pid}`}
      subtitle={info ? `PID ${info.pid}${sum?.kind ? ` · ${sum.kind}` : ''}` : 'Process'}
      icon={<span style={{ transform: 'scale(1.6)', margin: '6px 8px 0 4px' }}><ProcIcon src={view?.icon} /></span>}
      onClose={close}
      actions={<Button size="sm" variant="ghost" icon="refresh" iconOnly aria-label="Refresh" title="Refresh" onClick={() => load(false)} />}
      footer={
        info && (
          <>
            <CopyButton text={String(info.pid)} label="Copy PID" iconOnly={false} />
            <CopyButton text={details} label="Copy details" iconOnly={false} />
            <div className="spacer" />
            <Button
              variant="danger"
              icon="power"
              disabled={!term?.allowed || busy}
              title={term && !term.allowed ? term.reasons.join(' ') : undefined}
              onClick={terminate}
            >
              Terminate…
            </Button>
          </>
        )
      }
    >
      {!view && !error && <Loading label="Inspecting process…" />}
      {error && (
        <Callout tone={error.code === 'not_found' ? 'info' : 'danger'} title={error.code === 'not_found' ? 'Process has exited' : 'Inspection failed'}>
          {error.message}
        </Callout>
      )}
      {info && (
        <>
          {info.access !== 'full' && (
            <Callout tone="info" title={info.access === 'system' ? 'Windows kernel process' : 'Limited information'}>
              {info.access === 'system'
                ? 'This is a pseudo-process managed by the Windows kernel; it has no executable or owner.'
                : 'Windows denied query access — the process is probably elevated, protected or owned by another account. Portly only shows what a standard user may read and never elevates.'}
            </Callout>
          )}

          {related.length > 0 && (
            <section className="stack">
              {related.map((c) => (
                <Callout key={c.id} tone={c.severity === 'error' ? 'danger' : c.severity === 'warning' ? 'warn' : 'info'} title={c.title}>
                  {c.detail}
                </Callout>
              ))}
            </section>
          )}

          <section>
            <div className="section-title">Process</div>
            <dl className="kv">
              <dt>Executable</dt>
              <dd>
                {info.path ? (
                  <div className="row" style={{ alignItems: 'flex-start' }}>
                    <span className="mono selectable small" style={{ flex: 1 }}>{info.path}</span>
                    <CopyButton text={info.path} label="Copy path" />
                  </div>
                ) : (
                  <span className="faint">Not accessible</span>
                )}
              </dd>
              <dt>Owner</dt>
              <dd>{info.owner || <span className="faint">Not accessible</span>}</dd>
              <dt>Parent</dt>
              <dd>
                {info.parentPid ? (
                  <button type="button" className="btn ghost sm" onClick={() => openProcess(info.parentPid)}>
                    {info.parentName || 'Unknown'} <span className="mono faint">{info.parentPid}</span>
                  </button>
                ) : (
                  <span className="faint">—</span>
                )}
              </dd>
              <dt>Started</dt>
              <dd>
                {info.startTime ? (
                  <>
                    {dateTime(info.startTime)} <span className="faint">· up {duration(Date.now() - info.startTime)}</span>
                  </>
                ) : (
                  <span className="faint">Not accessible</span>
                )}
              </dd>
              <dt>Memory</dt>
              <dd className="num">{bytes(info.memoryBytes)}</dd>
              <dt>CPU</dt>
              <dd className="num">
                {percent(sum?.cpuPercent)} <span className="faint">· {info.cpuTimeMs != null ? `${duration(info.cpuTimeMs)} total` : '—'}</span>
              </dd>
              <dt>Threads</dt>
              <dd className="num">{info.threads}</dd>
              {sum && (
                <>
                  <dt>Category</dt>
                  <dd>
                    {CATEGORY_LABEL[sum.category]}
                    {sum.likelyDevServer && (
                      <Badge tone="info" icon="zap">
                        Dev server
                      </Badge>
                    )}
                  </dd>
                </>
              )}
            </dl>
          </section>

          {sum?.devReasons?.length > 0 && (
            <section>
              <div className="section-title">Why Portly classified it this way</div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {sum.devReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          )}

          <section>
            <div className="section-title">Ports & connections</div>
            {sum && (sum.listenPorts.length || sum.udpPorts.length) ? (
              <div className="row wrap">
                {sum.listenPorts.map((p) => (
                  <button key={`t${p}`} type="button" className="chip" onClick={() => openPort('tcp', p)}>
                    <span className="port-num">{p}</span> <span className="faint">TCP</span>
                  </button>
                ))}
                {sum.udpPorts.map((p) => (
                  <button key={`u${p}`} type="button" className="chip" onClick={() => openPort('udp', p)}>
                    <span className="port-num">{p}</span> <span className="faint">UDP</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="faint small">Not listening on any port.</p>
            )}
            {sum && <p className="small muted" style={{ marginTop: 8 }}>{sum.connections} established connection(s).</p>}
          </section>

          {view.projects.length > 0 && (
            <section>
              <div className="section-title">Registered projects</div>
              <div className="stack tight">
                {view.projects.map((p) => (
                  <div key={p.id} className="row between">
                    <span>
                      <strong>{p.name}</strong> <span className="faint small">port {p.ports.join(', ')}</span>
                    </span>
                    {p.directory && (
                      <Button size="sm" variant="ghost" icon="folder" onClick={() => api.projectOpenDir(p.id).catch((e) => toast.fail('Could not open folder', e))}>
                        Open folder
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {sum?.indicators?.length > 0 && (
            <section>
              <div className="section-title">Indicators</div>
              <div className="stack">
                {sum.indicators.map((i) => (
                  <Callout key={i.rule} tone={i.level === 'review' ? 'warn' : 'info'} title={i.title}>
                    {i.detail} <span className="faint xs mono">rule: {i.rule}</span>
                  </Callout>
                ))}
                <p className="xs faint">Indicators are transparent, rule-based hints to help you review unusual listeners. They are not malware detection.</p>
              </div>
            </section>
          )}

          {view.children.length > 0 && (
            <section>
              <div className="section-title">Child processes</div>
              <div className="row wrap">
                {view.children.map(([cpid, name]) => (
                  <button key={cpid} type="button" className="chip" onClick={() => openProcess(cpid)}>
                    {name} <span className="mono faint">{cpid}</span>
                  </button>
                ))}
              </div>
            </section>
          )}

          <section>
            <div className="section-title">Actions</div>
            <div className="row wrap">
              <Button size="sm" icon="folder" disabled={!info.path} onClick={openLocation}>
                Open file location
              </Button>
            </div>
            {term && (
              <div className="stack tight" style={{ marginTop: 12 }}>
                <div className="row">
                  <Icon name="shield" size={14} />
                  <span className="small">Termination:</span>
                  <Badge tone={RISK_TONE[term.risk]}>{RISK_LABEL[term.risk]}</Badge>
                </div>
                <ul className="xs muted" style={{ margin: 0, paddingLeft: 18 }}>
                  {term.reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        </>
      )}
    </Drawer>
  );
}
