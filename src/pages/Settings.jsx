import { useCallback, useEffect, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Badge, Button, Callout, Card, CopyButton, Empty, Loading, PageHeader, Segmented, Select, Toggle } from '../components/ui/primitives.jsx';
import { Modal, useConfirm } from '../components/ui/Modal.jsx';
import { useToast } from '../components/ui/Toast.jsx';
import { api } from '../lib/api.js';
import { ago, bytes, dateTime } from '../lib/format.js';
import { BACKGROUND_PRESETS, INTERVAL_PRESETS, LIMITS, START_PAGES, formatInterval, importRows, updateErrorMessage, validateInt } from '../lib/overview.js';
import { useConfig, useData, useSettings } from '../app/store.jsx';
import './Settings.css';

const REPO_URL = 'https://github.com/efecrtgl/ivily-portly';
const DB_STATE = {
  ok: { label: 'Healthy', tone: 'ok' },
  recovered: { label: 'Recovered', tone: 'warn' },
  'newer-schema': { label: 'Newer schema', tone: 'danger' },
  'memory-fallback': { label: 'Temporary (in memory)', tone: 'danger' },
};

function Row({ title, desc, children, htmlFor }) {
  return (
    <div className="setting-row">
      <div className="setting-text">
        {htmlFor ? <label htmlFor={htmlFor}>{title}</label> : <span>{title}</span>}
        {desc && <span className="setting-desc">{desc}</span>}
      </div>
      <div className="row set-control">{children}</div>
    </div>
  );
}

/** Integer input that validates and commits on blur or Enter. Re-mount with `key` to sync external changes. */
function NumberInput({ id, value, limits, unit, onCommit, width = 96 }) {
  const [draft, setDraft] = useState(String(value ?? ''));
  const [error, setError] = useState(null);
  const commit = () => {
    if (draft.trim() === String(value)) return setError(null);
    const r = validateInt(draft, limits);
    setError(r.error);
    if (!r.error) onCommit(r.value);
  };
  return (
    <span className="stack tight set-number">
      <span className="row">
        <input
          id={id}
          className="input mono"
          inputMode="numeric"
          value={draft}
          aria-invalid={!!error}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') {
              setDraft(String(value));
              setError(null);
            }
          }}
          style={{ width }}
        />
        {unit && <span className="faint small">{unit}</span>}
      </span>
      {error && (
        <span className="field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

function presetOptions(presets, value) {
  const opts = presets.map((p) => ({ value: String(p.value), label: p.label }));
  if (!presets.some((p) => p.value === value)) opts.push({ value: String(value), label: `Custom (${formatInterval(value)})` });
  return opts;
}

function Checkbox({ checked, onChange, children }) {
  return (
    <label className="set-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

// ------------------------------------------------------------- sections

function GeneralSection({ s, set }) {
  return (
    <Card title="Appearance & general">
      <Row title="Theme" desc="System follows the Windows light/dark setting.">
        <Segmented
          ariaLabel="Theme"
          value={s.general.theme}
          onChange={(v) => set('general.theme', v)}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'System' },
          ]}
        />
      </Row>
      <Row title="Start page" desc="The page shown when Portly opens.">
        <Select ariaLabel="Start page" value={s.general.startPage} onChange={(v) => set('general.startPage', v)} options={START_PAGES} />
      </Row>
    </Card>
  );
}

function MonitoringSection({ s, set, monitorError }) {
  const m = s.monitoring;
  const bgPresets = BACKGROUND_PRESETS.filter((p) => p.value >= m.intervalMs);
  return (
    <Card title="Monitoring" sub="Slower intervals reduce CPU usage. Portly only reads socket tables; it never sends traffic to your ports except configured health checks on loopback.">
      {monitorError && (
        <Callout tone="warn" title="Last scan reported a problem">
          {monitorError}
        </Callout>
      )}
      <Row title="Pause monitoring" desc="Stops port scans and health checks until resumed.">
        <Toggle label="Pause monitoring" checked={m.paused} onChange={(v) => set('monitoring.paused', v)} />
      </Row>
      <Row title="Refresh interval" desc="How often ports and connections are scanned while the window is visible (0.5–60 s).">
        <Select
          ariaLabel="Refresh interval preset"
          value={String(m.intervalMs)}
          onChange={(v) => set('monitoring.intervalMs', Number(v))}
          options={presetOptions(INTERVAL_PRESETS, m.intervalMs)}
        />
        <NumberInput key={m.intervalMs} value={m.intervalMs} limits={LIMITS.intervalMs} unit="ms" onCommit={(v) => set('monitoring.intervalMs', v)} />
      </Row>
      <Row title="Background interval" desc="Used while Portly is minimized or hidden. Never faster than the refresh interval.">
        <Select
          ariaLabel="Background interval preset"
          value={String(m.backgroundIntervalMs)}
          onChange={(v) => set('monitoring.backgroundIntervalMs', Number(v))}
          options={presetOptions(bgPresets, m.backgroundIntervalMs)}
        />
        <NumberInput
          key={m.backgroundIntervalMs}
          value={m.backgroundIntervalMs}
          limits={{ min: m.intervalMs, max: LIMITS.backgroundIntervalMs.max }}
          unit="ms"
          onCommit={(v) => set('monitoring.backgroundIntervalMs', v)}
        />
      </Row>
      <Row title="Include UDP" desc="Show bound UDP ports alongside TCP listeners.">
        <Toggle label="Include UDP" checked={m.includeUdp} onChange={(v) => set('monitoring.includeUdp', v)} />
      </Row>
      <Row title="Health check interval" desc="How often registered project ports are checked (2–3600 s).">
        <NumberInput key={m.healthIntervalS} value={m.healthIntervalS} limits={LIMITS.healthIntervalS} unit="s" onCommit={(v) => set('monitoring.healthIntervalS', v)} />
      </Row>
      <Row title="Health check timeout" desc="A check slower than this counts as down (200–10000 ms).">
        <NumberInput key={m.healthTimeoutMs} value={m.healthTimeoutMs} limits={LIMITS.healthTimeoutMs} unit="ms" onCommit={(v) => set('monitoring.healthTimeoutMs', v)} />
      </Row>
    </Card>
  );
}

function NotificationsSection({ s, set }) {
  const n = s.notifications;
  return (
    <Card title="Notifications" sub="In-app alerts are always shown. These control Windows notifications.">
      <Row title="Windows notifications" desc="Master switch for all system notifications from Portly.">
        <Toggle label="Windows notifications" checked={n.system} onChange={(v) => set('notifications.system', v)} />
      </Row>
      <Row title="Conflicts" desc="A new port conflict is detected.">
        <Toggle label="Conflict notifications" checked={n.conflicts} disabled={!n.system} onChange={(v) => set('notifications.conflicts', v)} />
      </Row>
      <Row title="Server up / down" desc="A registered project server stops responding or recovers.">
        <Toggle label="Server status notifications" checked={n.serverStatus} disabled={!n.system} onChange={(v) => set('notifications.serverStatus', v)} />
      </Row>
      <Row title="Port changes" desc="Watched ports become occupied or available.">
        <Toggle label="Port change notifications" checked={n.portChanges} disabled={!n.system} onChange={(v) => set('notifications.portChanges', v)} />
      </Row>
    </Card>
  );
}

function HistorySection({ s, set }) {
  const h = s.history;
  return (
    <Card title="History & privacy" sub="Activity history is stored only in Portly's local database.">
      <Row title="Record activity history" desc="When off, no new events are stored. Existing history is kept until cleared.">
        <Toggle label="Record activity history" checked={h.enabled} onChange={(v) => set('history.enabled', v)} />
      </Row>
      <Row title="Retention" desc="Events older than this are deleted automatically (1–365 days).">
        <NumberInput key={h.retentionDays} value={h.retentionDays} limits={LIMITS.retentionDays} unit="days" onCommit={(v) => set('history.retentionDays', v)} />
      </Row>
      <Row title="Maximum events" desc="Oldest events are removed beyond this count (500–200,000).">
        <NumberInput key={h.maxEvents} value={h.maxEvents} limits={LIMITS.maxEvents} unit="events" width={110} onCommit={(v) => set('history.maxEvents', v)} />
      </Row>
      <Row
        title="Record all ports"
        desc="Off: only ports that are registered in a project, favorite, personally reserved or planned are recorded. On: every port opening and closing is recorded."
      >
        <Toggle label="Record all ports" checked={h.recordAllPorts} onChange={(v) => set('history.recordAllPorts', v)} />
      </Row>
      <Row
        title="Store executable paths"
        desc="Off by default. Paths can reveal user names and folder layouts; when off, only process names are stored with events."
      >
        <Toggle label="Store executable paths in history" checked={h.storePaths} onChange={(v) => set('history.storePaths', v)} />
      </Row>
    </Card>
  );
}

function EcosystemSection({ s, set, iepVersion }) {
  return (
    <Card title="Ivily Ecosystem (IEP)">
      <Row
        title="Share summaries with Ivily Center"
        desc="The Ivily Ecosystem Protocol lets Ivily Center read summaries from Portly locally on this computer. No network, no background service, read-only. Paths, commands and project directories are never shared. When off, only Portly's identity and version are visible."
      >
        <Toggle label="Enable Ivily Ecosystem Protocol" checked={s.ecosystem.iepEnabled} onChange={(v) => set('ecosystem.iepEnabled', v)} />
      </Row>
      <div className="small faint">
        Protocol version: <span className="mono">{iepVersion || '—'}</span>
      </div>
    </Card>
  );
}

function DataSection({ appInfo, afterRestore, refreshAppInfo }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [backups, setBackups] = useState(null);
  const [backupsError, setBackupsError] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadBackups = useCallback(
    () =>
      api
        .dbBackups()
        .then((b) => {
          setBackups([...b].sort((x, y) => y.modified - x.modified));
          setBackupsError(null);
        })
        .catch(setBackupsError),
    [],
  );
  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const backupNow = async () => {
    setBusy(true);
    try {
      const path = await api.dbBackup(null);
      toast.ok('Backup created', path);
      loadBackups();
      refreshAppInfo();
    } catch (e) {
      toast.fail('Backup failed', e);
    } finally {
      setBusy(false);
    }
  };

  const restore = async (path) => {
    const ok = await confirm({
      title: 'Restore database?',
      danger: true,
      confirmLabel: 'Restore',
      body: (
        <div className="stack tight">
          <p className="muted">All projects, profiles, notes, plans, settings and history will be replaced with the contents of:</p>
          <p className="mono small selectable">{path}</p>
          <p className="muted">The current database is backed up automatically first, so you can undo this by restoring that backup.</p>
        </div>
      ),
    });
    if (!ok) return;
    setBusy(true);
    try {
      const safety = await api.dbRestore(path);
      toast.ok('Database restored', `Previous data was saved to ${safety}`);
      await afterRestore();
      loadBackups();
    } catch (e) {
      toast.fail('Restore failed', e);
    } finally {
      setBusy(false);
    }
  };

  const restoreFromFile = async () => {
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: 'Portly database', extensions: ['db'] }] });
      if (typeof path === 'string') restore(path);
    } catch (e) {
      toast.fail('Could not open the file dialog', e);
    }
  };

  const openDir = () => api.openDataDir().catch((e) => toast.fail('Could not open the data folder', e));
  const db = appInfo?.db;
  const st = db ? DB_STATE[db.state] || { label: db.state, tone: '' } : null;

  return (
    <Card
      title="Data & backups"
      actions={
        <>
          <Button size="sm" icon="folder" onClick={openDir}>
            Open data folder
          </Button>
          <Button size="sm" icon="database" onClick={backupNow} disabled={busy}>
            Back up now
          </Button>
        </>
      }
    >
      {!db ? (
        <Loading label="Reading database status…" />
      ) : (
        <div className="stack">
          {db.message && (
            <Callout tone={st.tone === 'ok' ? 'info' : st.tone || 'info'} title={st.label}>
              {db.message}
              {db.preMigrationBackup && <div className="mono xs selectable">Backup: {db.preMigrationBackup}</div>}
            </Callout>
          )}
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <Badge tone={st.tone}>{st.label}</Badge>
            </dd>
            <dt>Location</dt>
            <dd className="row">
              <span className="mono small selectable truncate">{db.path}</span>
              <CopyButton text={db.path} label="Copy path" />
            </dd>
            <dt>Schema</dt>
            <dd className="mono small">
              v{db.schemaVersion}
              {db.expectedSchemaVersion !== db.schemaVersion && <span className="faint"> (this version expects v{db.expectedSchemaVersion})</span>}
            </dd>
            <dt>Size</dt>
            <dd>{bytes(db.sizeBytes)}</dd>
          </dl>
        </div>
      )}

      <div className="section-title" style={{ marginTop: 16 }}>
        Backups
      </div>
      {backupsError ? (
        <Callout tone="danger" title="Could not list backups">
          {backupsError.message}
        </Callout>
      ) : !backups ? (
        <Loading />
      ) : backups.length === 0 ? (
        <Empty icon="database" title="No backups yet">
          Backups are created before migrations, restores and replace-imports, or when you click “Back up now”.
        </Empty>
      ) : (
        <ul className="set-backups">
          {backups.map((b) => (
            <li key={b.path} className="row between">
              <div className="stack tight" style={{ minWidth: 0 }}>
                <span className="mono small truncate selectable" title={b.path}>
                  {b.name}
                </span>
                <span className="xs faint">
                  {dateTime(b.modified)} · {bytes(b.sizeBytes)}
                </span>
              </div>
              <Button size="sm" variant="ghost" icon="history" onClick={() => restore(b.path)} disabled={busy}>
                Restore
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ marginTop: 12 }}>
        <Button size="sm" icon="upload" onClick={restoreFromFile} disabled={busy}>
          Restore from file…
        </Button>
      </div>
    </Card>
  );
}

function ExchangeSection({ afterImport }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [includeSettings, setIncludeSettings] = useState(true);
  const [pending, setPending] = useState(null); // { path, replace, applySettings }
  const [report, setReport] = useState(null);
  const [busy, setBusy] = useState(false);

  const doExport = async () => {
    try {
      const path = await save({ defaultPath: 'portly-config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!path) return;
      await api.configExport(path, includeSettings);
      toast.ok('Configuration exported', path);
    } catch (e) {
      toast.fail('Export failed', e);
    }
  };

  const pickImport = async () => {
    try {
      const path = await open({ multiple: false, directory: false, filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (typeof path === 'string') setPending({ path, replace: false, applySettings: false });
    } catch (e) {
      toast.fail('Could not open the file dialog', e);
    }
  };

  const doImport = async () => {
    const { path, replace, applySettings } = pending;
    if (replace) {
      const ok = await confirm({
        title: 'Replace current configuration?',
        danger: true,
        confirmLabel: 'Replace',
        body: 'Existing projects, profiles, port notes, personal reservations, ranges and plans will be deleted and replaced by the file contents. A backup of the current database is created automatically first.',
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const rep = await api.configImport(path, replace, applySettings);
      setPending(null);
      setReport(rep);
      await afterImport(applySettings);
    } catch (e) {
      toast.fail('Import failed', e);
    } finally {
      setBusy(false);
    }
  };

  const rows = importRows(report);
  return (
    <Card title="Import / export" sub="Move projects, profiles, port notes, personal reservations, ranges and plans between computers.">
      <Row title="Export configuration" desc="Writes a JSON file. History is never exported.">
        <Checkbox checked={includeSettings} onChange={setIncludeSettings}>
          Include settings
        </Checkbox>
        <Button size="sm" icon="download" onClick={doExport}>
          Export…
        </Button>
      </Row>
      <Row title="Import configuration" desc="Merge into the current configuration or replace it.">
        <Button size="sm" icon="upload" onClick={pickImport}>
          Import…
        </Button>
      </Row>

      {pending && (
        <Modal
          title="Import configuration"
          onClose={() => !busy && setPending(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setPending(null)} disabled={busy}>
                Cancel
              </Button>
              <Button variant={pending.replace ? 'danger' : 'primary'} onClick={doImport} disabled={busy}>
                {busy ? 'Importing…' : pending.replace ? 'Replace…' : 'Merge'}
              </Button>
            </>
          }
        >
          <div className="stack">
            <p className="mono small selectable">{pending.path}</p>
            <fieldset className="set-radio">
              <legend className="field-label">Mode</legend>
              <label>
                <input type="radio" name="import-mode" checked={!pending.replace} onChange={() => setPending({ ...pending, replace: false })} />
                <span>
                  <strong>Merge</strong> <span className="muted">— add new items; items whose names already exist are skipped.</span>
                </span>
              </label>
              <label>
                <input type="radio" name="import-mode" checked={pending.replace} onChange={() => setPending({ ...pending, replace: true })} />
                <span>
                  <strong>Replace</strong> <span className="muted">— delete the current configuration first (an automatic backup is made).</span>
                </span>
              </label>
            </fieldset>
            <Checkbox checked={pending.applySettings} onChange={(v) => setPending({ ...pending, applySettings: v })}>
              Apply settings from the file (if it contains any)
            </Checkbox>
          </div>
        </Modal>
      )}

      {report && (
        <Modal
          title="Import complete"
          onClose={() => setReport(null)}
          footer={
            <Button variant="primary" onClick={() => setReport(null)}>
              Close
            </Button>
          }
        >
          <div className="stack">
            {rows.length ? (
              <dl className="kv">
                {rows.map((r) => (
                  <div key={r.kind} style={{ display: 'contents' }}>
                    <dt>{r.label}</dt>
                    <dd className="mono">{r.count}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="muted">Nothing new was imported.</p>
            )}
            {report.skipped?.length > 0 && (
              <Callout tone="info" title={`Skipped ${report.skipped.length}`}>
                <ul className="set-ul">
                  {report.skipped.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {report.warnings?.length > 0 && (
              <Callout tone="warn" title="Warnings">
                <ul className="set-ul">
                  {report.warnings.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </Callout>
            )}
            {report.backup && (
              <p className="small muted">
                Backup of the previous database: <span className="mono selectable">{report.backup}</span>
              </p>
            )}
          </div>
        </Modal>
      )}
    </Card>
  );
}

function UpdatesSection({ s, set, reloadSettings }) {
  const confirm = useConfirm();
  const toast = useToast();
  const [st, setSt] = useState({ phase: 'idle' }); // idle | checking | none | available | error | installing

  const runCheck = async () => {
    setSt({ phase: 'checking' });
    try {
      const u = await check();
      await api.updateRecord(u ? u.version : __APP_VERSION__).catch(() => {});
      reloadSettings();
      setSt(u ? { phase: 'available', update: u } : { phase: 'none' });
    } catch (e) {
      setSt({ phase: 'error', message: updateErrorMessage(e) });
    }
  };

  const install = async () => {
    const u = st.update;
    const ok = await confirm({
      title: `Install Ivily Portly ${u.version}?`,
      body: 'The update will be downloaded, verified and installed. Portly then restarts; monitoring resumes automatically.',
      confirmLabel: 'Install and restart',
      danger: true,
    });
    if (!ok) return;
    setSt({ phase: 'installing', update: u });
    try {
      await u.downloadAndInstall();
      await relaunch();
    } catch (e) {
      toast.error('Update failed', updateErrorMessage(e));
      setSt({ phase: 'available', update: u });
    }
  };

  const last = s.updates.lastCheckedAt;
  return (
    <Card title="Updates">
      <Row title={`Current version ${__APP_VERSION__}`} desc={last ? `Last checked ${ago(last)} (${dateTime(last)})` : 'Not checked yet'}>
        <Button size="sm" icon="refresh" onClick={runCheck} disabled={st.phase === 'checking' || st.phase === 'installing'}>
          {st.phase === 'checking' ? 'Checking…' : 'Check for updates'}
        </Button>
      </Row>
      <Row title="Check on start" desc="Look for a new version when Portly starts. Updates are never installed without your confirmation.">
        <Toggle label="Check for updates on start" checked={s.updates.checkOnStart} onChange={(v) => set('updates.checkOnStart', v)} />
      </Row>
      {st.phase === 'none' && (
        <Callout tone="ok" title="You're up to date">
          Ivily Portly {__APP_VERSION__} is the latest version.
        </Callout>
      )}
      {st.phase === 'error' && (
        <Callout tone="warn" title="Could not check for updates">
          {st.message}
        </Callout>
      )}
      {(st.phase === 'available' || st.phase === 'installing') && (
        <Callout tone="info" title={`Version ${st.update.version} is available`}>
          {st.update.body && <pre className="set-notes selectable">{st.update.body}</pre>}
          <div className="row" style={{ marginTop: 8 }}>
            <Button size="sm" variant="primary" icon="download" onClick={install} disabled={st.phase === 'installing'}>
              {st.phase === 'installing' ? 'Installing…' : 'Install and restart'}
            </Button>
          </div>
        </Callout>
      )}
    </Card>
  );
}

function AboutSection({ appInfo, onReset }) {
  return (
    <Card title="About">
      <dl className="kv">
        <dt>Version</dt>
        <dd className="mono">{__APP_VERSION__}</dd>
        <dt>License</dt>
        <dd>MIT</dd>
        <dt>Repository</dt>
        <dd className="row">
          <span className="mono small selectable">{REPO_URL}</span>
          <CopyButton text={REPO_URL} label="Copy link" />
        </dd>
        <dt>Data directory</dt>
        <dd className="mono small selectable">{appInfo?.dataDir || '—'}</dd>
        <dt>Current user</dt>
        <dd className="selectable">{appInfo?.currentUser || '—'}</dd>
      </dl>
      <div className="row" style={{ marginTop: 16 }}>
        <Button size="sm" variant="danger" icon="refresh" onClick={onReset}>
          Reset settings to defaults
        </Button>
        <span className="xs faint">Projects, profiles and history are not affected.</span>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------- page

export default function Settings() {
  const { settings, setSettings, update } = useSettings();
  const { appInfo, refreshAppInfo } = useData();
  const { reload } = useConfig();
  const toast = useToast();
  const confirm = useConfirm();

  const set = useCallback(
    async (path, value) => {
      try {
        await update(path, value);
      } catch (e) {
        toast.fail('Could not save setting', e);
      }
    },
    [update, toast],
  );

  const reloadSettings = useCallback(() => api.settings().then(setSettings).catch(() => {}), [setSettings]);

  const afterRestore = async () => {
    await Promise.all([reload(), reloadSettings(), refreshAppInfo()]);
  };
  const afterImport = async (applied) => {
    await Promise.all([reload(), applied ? reloadSettings() : null, refreshAppInfo()]);
  };

  const reset = async () => {
    const ok = await confirm({
      title: 'Reset settings to defaults?',
      body: 'Appearance, monitoring, notification, history, ecosystem and update settings return to their defaults. Your projects, profiles, notes, plans and history are kept.',
      confirmLabel: 'Reset settings',
      danger: true,
    });
    if (!ok) return;
    try {
      setSettings(await api.settingsReset());
      toast.ok('Settings reset', 'Default settings restored.');
    } catch (e) {
      toast.fail('Could not reset settings', e);
    }
  };

  return (
    <div className="page">
      <PageHeader title="Settings" sub="Changes are saved immediately." />
      {!settings ? (
        <Loading label="Loading settings…" />
      ) : (
        <div className="set-layout">
          <GeneralSection s={settings} set={set} />
          <MonitoringSection s={settings} set={set} monitorError={appInfo?.monitorError} />
          <NotificationsSection s={settings} set={set} />
          <HistorySection s={settings} set={set} />
          <EcosystemSection s={settings} set={set} iepVersion={appInfo?.iepVersion} />
          <DataSection appInfo={appInfo} afterRestore={afterRestore} refreshAppInfo={refreshAppInfo} />
          <ExchangeSection afterImport={afterImport} />
          <UpdatesSection s={settings} set={set} reloadSettings={reloadSettings} />
          <AboutSection appInfo={appInfo} onReset={reset} />
        </div>
      )}
    </div>
  );
}
