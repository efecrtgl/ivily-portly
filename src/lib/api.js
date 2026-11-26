// Thin, documented wrappers around the Rust IPC commands.
// Every call rejects with `{ code, message }` (see src-tauri/src/error.rs).
import { invoke } from '@tauri-apps/api/core';

function normalize(err) {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) return err;
  return { code: 'unknown', message: typeof err === 'string' ? err : err?.message || 'Unexpected error' };
}

export async function call(cmd, args) {
  try {
    return await invoke(cmd, args);
  } catch (e) {
    throw normalize(e);
  }
}

export const api = {
  // app / data
  appInfo: () => call('app_info'),
  dbBackup: (path = null) => call('db_backup', { path }),
  dbBackups: () => call('db_backups'),
  dbRestore: (path) => call('db_restore', { path }),
  openDataDir: () => call('open_data_dir'),

  // monitor
  snapshot: () => call('monitor_snapshot'),
  conflicts: () => call('monitor_conflicts'),
  health: () => call('monitor_health'),
  refresh: () => call('monitor_refresh'),
  setVisible: (visible) => call('monitor_set_visible', { visible }),
  exclusions: (refresh = false) => call('exclusions_get', { refresh }),

  // processes
  inspect: (pid, record = true) => call('process_inspect', { pid, record }),
  icons: (paths) => call('process_icons', { paths }),
  openLocation: (pid) => call('process_open_location', { pid }),
  terminate: (pid, startTime, confirmed) => call('process_terminate', { pid, startTime, confirmed }),

  // ports
  portCheck: (protocol, port) => call('port_check', { protocol, port }),
  portCheckMany: (protocol, ports) => call('port_check_many', { protocol, ports }),
  portSuggest: (protocol, start, end, count = 5) => call('port_suggest', { protocol, start, end, count }),
  portDetail: (protocol, port) => call('port_detail', { protocol, port }),
  portNotes: () => call('port_notes'),
  portNoteSave: (note) => call('port_note_save', { note }),
  reservations: () => call('reservations_list'),
  reservationSave: (reservation) => call('reservation_save', { reservation }),
  reservationDelete: (id) => call('reservation_delete', { id }),
  ranges: () => call('ranges_list'),
  rangeSave: (range) => call('range_save', { range }),
  rangeDelete: (id) => call('range_delete', { id }),

  // projects
  projects: () => call('projects_list'),
  projectSave: (id, input) => call('project_save', { id, input }),
  projectDelete: (id) => call('project_delete', { id }),
  projectFavorite: (id, favorite) => call('project_favorite', { id, favorite }),
  projectOpenDir: (projectId) => call('project_open_dir', { projectId }),
  groups: () => call('groups_list'),
  groupSave: (id, name) => call('group_save', { id, name }),
  groupDelete: (id) => call('group_delete', { id }),
  healthHistory: (projectPortId, hours = 24) => call('health_history', { projectPortId, hours }),

  // profiles
  profiles: () => call('profiles_list'),
  profileSave: (id, input) => call('profile_save', { id, input }),
  profileDelete: (id) => call('profile_delete', { id }),
  profileActivate: (id) => call('profile_activate', { id }),

  // plans
  plans: () => call('plans_list'),
  planSave: (id, input) => call('plan_save', { id, input }),
  planDelete: (id) => call('plan_delete', { id }),
  planValidate: (planId, projectId, entries) => call('plan_validate', { planId, projectId, entries }),
  planExport: (id, format, path) => call('plan_export', { id, format, path }),

  // activity
  events: (filter = {}) => call('events_list', { filter }),
  eventsClear: (filter = {}) => call('events_clear', { filter }),
  activityStats: (hours = 24) => call('activity_stats', { hours }),

  // settings
  settings: () => call('settings_get'),
  settingsUpdate: (settings) => call('settings_update', { settings }),
  settingsReset: () => call('settings_reset'),
  updateRecord: (latestVersion) => call('update_record', { latestVersion }),

  // exchange
  configExport: (path, includeSettings) => call('config_export', { path, includeSettings }),
  configImport: (path, replace, applySettings) => call('config_import', { path, replace, applySettings }),
};
