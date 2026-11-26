import { Component, Suspense, lazy, useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { AppProviders, useConfig, useData, useInspect, useNav, useSettings } from './store.jsx';
import { ToastProvider } from '../components/ui/Toast.jsx';
import { ConfirmProvider } from '../components/ui/Modal.jsx';
import Icon from '../components/ui/Icon.jsx';
import { Button, Callout, Loading } from '../components/ui/primitives.jsx';
import ProcessDrawer from '../components/ProcessDrawer.jsx';
import PortDrawer from '../components/PortDrawer.jsx';
import { NAV, PAGE_IDS } from './nav.js';
import logo from '../../assets/logo.svg';

const PAGES = {
  dashboard: lazy(() => import('../pages/Dashboard.jsx')),
  ports: lazy(() => import('../pages/Ports.jsx')),
  connections: lazy(() => import('../pages/Connections.jsx')),
  processes: lazy(() => import('../pages/Processes.jsx')),
  projects: lazy(() => import('../pages/Projects.jsx')),
  planner: lazy(() => import('../pages/Planner.jsx')),
  profiles: lazy(() => import('../pages/Profiles.jsx')),
  activity: lazy(() => import('../pages/Activity.jsx')),
  settings: lazy(() => import('../pages/Settings.jsx')),
};

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidUpdate(prev) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <Callout tone="danger" title="This view crashed">
          <p>{String(this.state.error?.message || this.state.error)}</p>
          <div style={{ marginTop: 8 }}>
            <Button size="sm" onClick={() => this.setState({ error: null })}>
              Try again
            </Button>
          </div>
        </Callout>
      </div>
    );
  }
}

function useTheme() {
  const { settings } = useSettings();
  const theme = settings?.general?.theme || 'dark';
  useEffect(() => {
    const apply = () => {
      const t = theme === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : theme;
      document.documentElement.dataset.theme = t;
    };
    apply();
    if (theme !== 'system') return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, [theme]);
}

function TitleBar() {
  const { snapshot, conflicts, refresh } = useData();
  const { settings, update } = useSettings();
  const [maximized, setMaximized] = useState(false);
  const win = getCurrentWindow();
  useEffect(() => {
    let un;
    win.isMaximized().then(setMaximized).catch(() => {});
    win
      .onResized(() => win.isMaximized().then(setMaximized).catch(() => {}))
      .then((u) => (un = u))
      .catch(() => {});
    return () => un?.();
  }, [win]);
  const paused = settings?.monitoring?.paused;
  const st = snapshot.stats || {};
  return (
    <header className="titlebar">
      <div className="titlebar-drag" data-tauri-drag-region onDoubleClick={() => win.toggleMaximize()}>
        <div className="titlebar-brand" data-tauri-drag-region>
          <img src={logo} alt="" />
          Ivily Portly
        </div>
        <div className="titlebar-status" data-tauri-drag-region>
          <span className={`dot ${paused ? '' : 'ok pulse'}`} />
          {paused ? 'Monitoring paused' : snapshot.seq ? `${st.tcpListeners ?? 0} listening · ${st.established ?? 0} connections` : 'Starting…'}
          {conflicts.some((c) => c.severity !== 'info') && <span style={{ color: 'var(--warn)' }}>· {conflicts.filter((c) => c.severity !== 'info').length} conflict(s)</span>}
        </div>
      </div>
      <div className="titlebar-actions">
        <Button size="sm" variant="ghost" icon="refresh" iconOnly title="Refresh now" aria-label="Refresh now" onClick={refresh} />
        <Button
          size="sm"
          variant="ghost"
          icon={paused ? 'play' : 'pause'}
          iconOnly
          title={paused ? 'Resume monitoring' : 'Pause monitoring'}
          aria-label={paused ? 'Resume monitoring' : 'Pause monitoring'}
          disabled={!settings}
          onClick={() => update('monitoring.paused', !paused).catch(() => {})}
        />
      </div>
      <div className="win-controls">
        <button type="button" className="win-btn" aria-label="Minimize" onClick={() => win.minimize()}>
          <Icon name="minimize" size={14} />
        </button>
        <button type="button" className="win-btn" aria-label={maximized ? 'Restore' : 'Maximize'} onClick={() => win.toggleMaximize()}>
          <Icon name={maximized ? 'restore' : 'maximize'} size={12} />
        </button>
        <button type="button" className="win-btn close" aria-label="Close" onClick={() => win.close()}>
          <Icon name="close" size={14} />
        </button>
      </div>
    </header>
  );
}

function Sidebar() {
  const { page, navigate } = useNav();
  const { snapshot, conflicts } = useData();
  const { projects, profiles } = useConfig();
  const { settings, update } = useSettings();
  const theme = settings?.general?.theme || 'dark';
  const nextTheme = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
  const errors = conflicts.filter((c) => c.severity === 'error').length;
  const warnings = conflicts.filter((c) => c.severity === 'warning').length;
  const counts = {
    ports: snapshot.ports.length,
    connections: snapshot.connections.length,
    processes: snapshot.processes.length,
    projects: projects.length,
  };
  const active = profiles.find((p) => p.id === settings?.general?.activeProfileId);
  return (
    <nav className="sidebar" aria-label="Main">
      {NAV.map((g) => (
        <div key={g.label}>
          <div className="nav-group-label">{g.label}</div>
          {g.items.map((item) => (
            <button key={item.id} type="button" className="nav-item" aria-current={page === item.id ? 'page' : undefined} onClick={() => navigate(item.id)}>
              <Icon name={item.icon} />
              <span>{item.label}</span>
              {item.id === 'dashboard' && errors + warnings > 0 ? (
                <span className={`nav-alert ${errors ? 'error' : ''}`} title={`${errors + warnings} conflict(s)`}>
                  {errors + warnings}
                </span>
              ) : counts[item.id] ? (
                <span className="nav-count">{counts[item.id]}</span>
              ) : null}
            </button>
          ))}
        </div>
      ))}
      <div className="sidebar-footer">
        <button type="button" className="profile-pill" onClick={() => navigate('profiles')} title="Active profile">
          <Icon name="layers" size={14} />
          <span className="truncate">{active ? active.name : 'All projects'}</span>
        </button>
        <div className="row between">
          <span>v{__APP_VERSION__}</span>
          <Button
            size="sm"
            variant="ghost"
            icon={theme === 'light' ? 'sun' : theme === 'dark' ? 'moon' : 'monitor'}
            iconOnly
            title={`Theme: ${theme} (click for ${nextTheme})`}
            aria-label="Change theme"
            disabled={!settings}
            onClick={() => update('general.theme', nextTheme).catch(() => {})}
          />
        </div>
      </div>
    </nav>
  );
}

function DbBanner() {
  const { appInfo } = useData();
  const db = appInfo?.db;
  if (!db || db.state === 'ok') return null;
  return (
    <div style={{ padding: '12px 32px 0' }}>
      <Callout tone={db.state === 'recovered' ? 'warn' : 'danger'} title={db.state === 'recovered' ? 'Database recovered' : 'Data is not being saved'}>
        {db.message}
      </Callout>
    </div>
  );
}

function Shell() {
  useTheme();
  const { page, navigate } = useNav();
  const { settings } = useSettings();
  const { current } = useInspect();
  useEffect(() => {
    if (page || !settings) return;
    const start = settings.general.startPage;
    navigate(PAGE_IDS.includes(start) ? start : 'dashboard');
  }, [page, settings, navigate]);
  const id = page || 'dashboard';
  const Page = PAGES[id] || PAGES.dashboard;
  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar />
        <main className="main" id="main">
          <DbBanner />
          <ErrorBoundary resetKey={id}>
            <Suspense fallback={<Loading />}>{page || settings ? <Page /> : <Loading />}</Suspense>
          </ErrorBoundary>
        </main>
      </div>
      {current?.type === 'process' && <ProcessDrawer key={`p${current.pid}`} pid={current.pid} />}
      {current?.type === 'port' && <PortDrawer key={`${current.protocol}${current.port}`} protocol={current.protocol} port={current.port} />}
    </div>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppProviders>
          <Shell />
        </AppProviders>
      </ConfirmProvider>
    </ToastProvider>
  );
}
