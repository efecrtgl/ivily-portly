// Application data layer: live monitor state pushed from Rust, configuration
// collections with explicit reloads, settings, navigation and shared drawers.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { api } from '../lib/api.js';

const DataContext = createContext(null);
const ConfigContext = createContext(null);
const SettingsContext = createContext(null);
const NavContext = createContext(null);
const InspectContext = createContext(null);

const EMPTY_SNAPSHOT = { ts: 0, seq: 0, ports: [], connections: [], processes: [], stats: {} };
const CONFIG_KINDS = ['projects', 'profiles', 'notes', 'reservations', 'ranges', 'plans', 'groups'];
const LOADERS = {
  projects: api.projects,
  profiles: api.profiles,
  notes: api.portNotes,
  reservations: api.reservations,
  ranges: api.ranges,
  plans: api.plans,
  groups: api.groups,
};

export function AppProviders({ children }) {
  // ---------------------------------------------------------------- live data
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [conflicts, setConflicts] = useState([]);
  const [health, setHealth] = useState({});
  const [eventSeq, setEventSeq] = useState(0);
  const [lastEvent, setLastEvent] = useState(null);
  const [appInfo, setAppInfo] = useState(null);
  const [icons, setIcons] = useState({});
  const requested = useRef(new Set());

  useEffect(() => {
    let alive = true;
    const unsubs = [];
    api.snapshot().then((s) => alive && s?.seq && setSnapshot(s)).catch(() => {});
    api.conflicts().then((c) => alive && setConflicts(c)).catch(() => {});
    api.health().then((h) => alive && setHealth(h)).catch(() => {});
    api.appInfo().then((i) => alive && setAppInfo(i)).catch(() => {});
    listen('portly://snapshot', (e) => setSnapshot(e.payload)).then((u) => unsubs.push(u));
    listen('portly://conflicts', (e) => setConflicts(e.payload)).then((u) => unsubs.push(u));
    listen('portly://health', (e) => setHealth(e.payload)).then((u) => unsubs.push(u));
    listen('portly://event', (e) => {
      setLastEvent(e.payload);
      setEventSeq((n) => n + 1);
    }).then((u) => unsubs.push(u));
    const onVis = () => api.setVisible(!document.hidden).catch(() => {});
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      unsubs.forEach((u) => u());
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // Batch-load icons for executables seen in the snapshot.
  useEffect(() => {
    const missing = snapshot.processes.map((p) => p.path).filter((p) => p && !requested.current.has(p));
    if (!missing.length) return;
    missing.forEach((p) => requested.current.add(p));
    api
      .icons(missing.slice(0, 300))
      .then((m) => setIcons((prev) => ({ ...prev, ...m })))
      .catch(() => {});
  }, [snapshot.processes]);

  const refreshAppInfo = useCallback(() => api.appInfo().then(setAppInfo).catch(() => {}), []);

  const data = useMemo(() => {
    const procByPid = new Map(snapshot.processes.map((p) => [p.pid, p]));
    return {
      snapshot,
      conflicts,
      health,
      eventSeq,
      lastEvent,
      appInfo,
      refreshAppInfo,
      icons,
      procByPid,
      iconFor: (pid) => {
        const p = procByPid.get(pid);
        return p?.path ? icons[p.path] || null : null;
      },
      refresh: () => api.refresh().catch(() => {}),
    };
  }, [snapshot, conflicts, health, eventSeq, lastEvent, appInfo, refreshAppInfo, icons]);

  // ----------------------------------------------------------------- config
  const [config, setConfig] = useState(() => Object.fromEntries(CONFIG_KINDS.map((k) => [k, []])));
  const [configLoaded, setConfigLoaded] = useState(false);
  const reload = useCallback(async (...kinds) => {
    const list = kinds.length ? kinds : CONFIG_KINDS;
    const results = await Promise.allSettled(list.map((k) => LOADERS[k]()));
    setConfig((prev) => {
      const next = { ...prev };
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') next[list[i]] = r.value;
      });
      return next;
    });
  }, []);
  useEffect(() => {
    reload().finally(() => setConfigLoaded(true));
  }, [reload]);
  const configValue = useMemo(() => ({ ...config, loaded: configLoaded, reload }), [config, configLoaded, reload]);

  // --------------------------------------------------------------- settings
  const [settings, setSettings] = useState(null);
  useEffect(() => {
    api.settings().then(setSettings).catch(() => {});
  }, []);
  const saveSettings = useCallback(async (next) => {
    const saved = await api.settingsUpdate(next);
    setSettings(saved);
    return saved;
  }, []);
  /** Updates one dotted path, e.g. update('monitoring.intervalMs', 3000). */
  const update = useCallback(
    async (path, value) => {
      const [section, key] = path.split('.');
      const next = { ...settings, [section]: { ...settings[section], [key]: value } };
      setSettings(next);
      try {
        return await saveSettings(next);
      } catch (e) {
        setSettings(settings);
        throw e;
      }
    },
    [settings, saveSettings],
  );
  const settingsValue = useMemo(() => ({ settings, setSettings, saveSettings, update }), [settings, saveSettings, update]);

  // ------------------------------------------------------------- navigation
  const [route, setRoute] = useState({ page: null, params: null });
  const navigate = useCallback((page, params = null) => setRoute({ page, params }), []);
  const navValue = useMemo(() => ({ ...route, navigate }), [route, navigate]);

  // ---------------------------------------------------------------- drawers
  const [inspect, setInspect] = useState(null);
  const inspectValue = useMemo(
    () => ({
      current: inspect,
      openProcess: (pid) => setInspect({ type: 'process', pid }),
      openPort: (protocol, port) => setInspect({ type: 'port', protocol, port }),
      close: () => setInspect(null),
    }),
    [inspect],
  );

  return (
    <DataContext.Provider value={data}>
      <ConfigContext.Provider value={configValue}>
        <SettingsContext.Provider value={settingsValue}>
          <NavContext.Provider value={navValue}>
            <InspectContext.Provider value={inspectValue}>{children}</InspectContext.Provider>
          </NavContext.Provider>
        </SettingsContext.Provider>
      </ConfigContext.Provider>
    </DataContext.Provider>
  );
}

/** Live monitor data: snapshot, conflicts, health (keyed by project port id), icons. */
export const useData = () => useContext(DataContext);
/** Configuration collections + `reload(...kinds)`. */
export const useConfig = () => useContext(ConfigContext);
/** `{ settings, update(path, value), saveSettings(obj) }` — settings is null until loaded. */
export const useSettings = () => useContext(SettingsContext);
/** `{ page, params, navigate(page, params) }` */
export const useNav = () => useContext(NavContext);
/** `{ openProcess(pid), openPort(protocol, port), close() }` */
export const useInspect = () => useContext(InspectContext);
