// Pure formatting helpers shared by all pages.

export function bytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

export function percent(n, digits = 1) {
  if (n == null || Number.isNaN(n)) return '—';
  return `${n.toFixed(digits)}%`;
}

/** "3s", "5m", "2h 10m", "4d 3h" */
export function duration(ms) {
  if (ms == null || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

/** Relative time like "just now", "5 min ago", "yesterday". */
export function ago(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = now - ts;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 30) return `${d} days ago`;
  return dateTime(ts);
}

export function dateTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function time(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** Formats an address/port pair; IPv6 addresses are bracketed. */
export function endpoint(addr, port) {
  if (!addr) return port != null ? `:${port}` : '—';
  const a = addr.includes(':') ? `[${addr}]` : addr;
  return port != null ? `${a}:${port}` : a;
}

export const SCOPE_LABEL = {
  loopback: 'Localhost only',
  all_interfaces: 'All interfaces',
  link_local: 'Link-local',
  specific: 'Specific interface',
};

export const SCOPE_TONE = {
  loopback: 'ok',
  all_interfaces: 'warn',
  link_local: '',
  specific: 'info',
};

export const STATE_LABEL = {
  listen: 'Listening',
  bound: 'Bound',
  established: 'Established',
  time_wait: 'Time wait',
  close_wait: 'Close wait',
  syn_sent: 'SYN sent',
  syn_received: 'SYN received',
  fin_wait1: 'FIN wait 1',
  fin_wait2: 'FIN wait 2',
  closing: 'Closing',
  last_ack: 'Last ACK',
  closed: 'Closed',
  delete_tcb: 'Delete TCB',
  unknown: 'Unknown',
};

export const CATEGORY_LABEL = {
  dev_runtime: 'Dev runtime',
  database: 'Database',
  web_server: 'Web server',
  container: 'Container / WSL',
  browser: 'Browser',
  system: 'System',
  other: 'Other',
};

export const CONN_CATEGORY_LABEL = {
  listener: 'Listener',
  local: 'Local',
  lan: 'Local network',
  internet: 'Internet',
  other: 'Other',
};

export const HEALTH_LABEL = { up: 'Up', degraded: 'Errors', down: 'Down', unchecked: 'Not checked' };
export const HEALTH_TONE = { up: 'ok', degraded: 'warn', down: 'danger', unchecked: '' };

export const SEVERITY_TONE = { error: 'danger', critical: 'danger', warning: 'warn', info: 'info' };

export const EVENT_LABEL = {
  port_opened: 'Port occupied',
  port_closed: 'Port available',
  owner_changed: 'Owner changed',
  server_down: 'Server unavailable',
  server_up: 'Server recovered',
  conflict: 'Conflict',
  config: 'Configuration',
  process_terminated: 'Process terminated',
};

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Last path segment (works for Windows and POSIX separators). */
export function basename(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

export function dirname(p) {
  if (!p) return '';
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

/** Parses "3000", "3000-3010", "3000, 8080" into a sorted unique port list (max 200). */
export function parsePorts(input) {
  const out = new Set();
  for (const part of String(input || '').split(/[\s,;]+/)) {
    if (!part) continue;
    const m = part.match(/^(\d{1,5})(?:-(\d{1,5}))?$/);
    if (!m) return { ports: [], error: `"${part}" is not a port or range` };
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > 65535 || a > b) return { ports: [], error: `"${part}" is outside 1–65535` };
    for (let p = a; p <= b; p += 1) {
      out.add(p);
      if (out.size > 200) return { ports: [], error: 'At most 200 ports at once' };
    }
  }
  return { ports: [...out].sort((x, y) => x - y), error: null };
}
