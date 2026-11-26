//! The monitoring snapshot sent to the UI: sockets, ports grouped by
//! (protocol, port) and summaries of the processes behind them.

use crate::insight::{self, Indicator};
use crate::net::classify::{self, ConnectionCategory};
use crate::net::{BindScope, Protocol, SocketEntry, SocketState};
use crate::process::devserver::{self, ProcessCategory};
use crate::process::{Access, ProcessBasic, ProcessDetails};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet, HashMap};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcSummary {
    pub pid: u32,
    pub name: String,
    pub parent_pid: Option<u32>,
    pub parent_name: Option<String>,
    pub path: Option<String>,
    pub start_time: Option<i64>,
    pub memory_bytes: Option<u64>,
    pub cpu_percent: Option<f32>,
    pub threads: u32,
    pub access: Access,
    pub category: ProcessCategory,
    pub kind: Option<&'static str>,
    pub likely_dev_server: bool,
    pub dev_reasons: Vec<String>,
    pub indicators: Vec<Indicator>,
    pub listen_ports: Vec<u16>,
    pub udp_ports: Vec<u16>,
    pub connections: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub addr: String,
    pub family: crate::net::Family,
    pub scope: BindScope,
    pub pid: u32,
}

/// One listening TCP port or bound UDP port with all its bindings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortUsage {
    pub protocol: Protocol,
    pub port: u16,
    pub bindings: Vec<Binding>,
    pub pids: Vec<u32>,
    /// Widest exposure among bindings.
    pub exposure: BindScope,
    pub well_known: Option<&'static str>,
    pub dynamic: bool,
    /// Established connections to/from this local port.
    pub connections: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    #[serde(flatten)]
    pub socket: SocketEntry,
    pub category: ConnectionCategory,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub tcp_listeners: u32,
    pub udp_bound: u32,
    pub established: u32,
    pub time_wait: u32,
    pub processes: u32,
    pub dev_servers: u32,
    pub exposed: u32,
    pub scan_ms: u32,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub ts: i64,
    pub seq: u64,
    pub ports: Vec<PortUsage>,
    pub connections: Vec<ConnectionView>,
    pub processes: Vec<ProcSummary>,
    pub stats: Stats,
}

/// Key used for diffing listeners: (protocol, port) → set of (pid, name).
pub type ListenerMap = BTreeMap<(Protocol, u16), BTreeSet<(u32, String)>>;

impl Snapshot {
    pub fn listener_map(&self) -> ListenerMap {
        let names: HashMap<u32, &str> = self.processes.iter().map(|p| (p.pid, p.name.as_str())).collect();
        self.ports
            .iter()
            .map(|u| {
                let owners = u.pids.iter().map(|pid| (*pid, names.get(pid).copied().unwrap_or("?").to_string())).collect();
                ((u.protocol, u.port), owners)
            })
            .collect()
    }

    pub fn process(&self, pid: u32) -> Option<&ProcSummary> {
        self.processes.iter().find(|p| p.pid == pid)
    }

    /// Cheap fingerprint of the structural state (ports + connections).
    pub fn fingerprint(&self) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        for p in &self.ports {
            (p.protocol, p.port, &p.pids, p.connections).hash(&mut h);
        }
        for c in &self.connections {
            (&c.socket.local_port, &c.socket.remote_addr, &c.socket.remote_port, c.socket.pid, c.socket.state as u8).hash(&mut h);
        }
        h.finish()
    }
}

fn widest(a: BindScope, b: BindScope) -> BindScope {
    let rank = |s: BindScope| match s {
        BindScope::Loopback => 0,
        BindScope::LinkLocal => 1,
        BindScope::Specific => 2,
        BindScope::AllInterfaces => 3,
    };
    if rank(b) > rank(a) {
        b
    } else {
        a
    }
}

pub struct BuildInput<'a> {
    pub sockets: Vec<SocketEntry>,
    pub procs: &'a HashMap<u32, ProcessBasic>,
    /// Details per PID (already fetched by the caller).
    pub details: &'a HashMap<u32, (Access, ProcessDetails)>,
    /// CPU percent per PID computed from the previous sample.
    pub cpu: &'a HashMap<u32, f32>,
    pub windows_dir: &'a str,
    pub include_udp: bool,
    pub ts: i64,
    pub seq: u64,
}

pub fn build(input: BuildInput) -> Snapshot {
    let BuildInput { sockets, procs, details, cpu, windows_dir, include_udp, ts, seq } = input;
    let mut ports: BTreeMap<(Protocol, u16), PortUsage> = BTreeMap::new();
    let mut connections = Vec::new();
    let mut stats = Stats::default();
    let mut per_pid_listen: HashMap<u32, BTreeSet<u16>> = HashMap::new();
    let mut per_pid_udp: HashMap<u32, BTreeSet<u16>> = HashMap::new();
    let mut per_pid_scopes: HashMap<u32, BTreeSet<u8>> = HashMap::new();
    let mut per_pid_conns: HashMap<u32, u32> = HashMap::new();
    let mut conn_per_port: HashMap<u16, u32> = HashMap::new();

    for s in sockets {
        if s.protocol == Protocol::Udp && !include_udp {
            continue;
        }
        if s.is_listener() {
            match s.protocol {
                Protocol::Tcp => {
                    stats.tcp_listeners += 1;
                    per_pid_listen.entry(s.pid).or_default().insert(s.local_port);
                }
                Protocol::Udp => {
                    stats.udp_bound += 1;
                    per_pid_udp.entry(s.pid).or_default().insert(s.local_port);
                }
            }
            per_pid_scopes.entry(s.pid).or_default().insert(s.scope as u8);
            let e = ports.entry((s.protocol, s.local_port)).or_insert_with(|| PortUsage {
                protocol: s.protocol,
                port: s.local_port,
                bindings: vec![],
                pids: vec![],
                exposure: s.scope,
                well_known: classify::well_known(s.local_port),
                dynamic: classify::is_dynamic(s.local_port),
                connections: 0,
            });
            e.exposure = widest(e.exposure, s.scope);
            let b = Binding { addr: s.local_addr.clone(), family: s.family, scope: s.scope, pid: s.pid };
            if !e.bindings.contains(&b) {
                e.bindings.push(b);
            }
            if !e.pids.contains(&s.pid) {
                e.pids.push(s.pid);
            }
        } else {
            match s.state {
                SocketState::Established => {
                    stats.established += 1;
                    *conn_per_port.entry(s.local_port).or_default() += 1;
                    *per_pid_conns.entry(s.pid).or_default() += 1;
                }
                SocketState::TimeWait => stats.time_wait += 1,
                _ => {}
            }
            let category = classify::category(&s);
            connections.push(ConnectionView { socket: s, category });
        }
    }
    for ((proto, port), u) in ports.iter_mut() {
        if *proto == Protocol::Tcp {
            u.connections = conn_per_port.get(port).copied().unwrap_or(0);
        }
        u.pids.sort_unstable();
        if u.exposure == BindScope::AllInterfaces {
            stats.exposed += 1;
        }
    }

    // Processes that own at least one socket.
    let mut pids: BTreeSet<u32> = per_pid_listen.keys().chain(per_pid_udp.keys()).copied().collect();
    pids.extend(connections.iter().map(|c| c.socket.pid));
    let mut processes = Vec::with_capacity(pids.len());
    for pid in pids {
        let basic = procs.get(&pid);
        let name = match (pid, basic) {
            (0, _) => "System Idle Process".to_string(),
            (_, Some(b)) => b.name.clone(),
            (4, None) => "System".to_string(),
            _ => format!("PID {pid}"),
        };
        let (access, d) = if pid == 0 || pid == 4 {
            (Access::System, ProcessDetails::default())
        } else {
            details.get(&pid).cloned().unwrap_or((Access::Denied, ProcessDetails::default()))
        };
        let listen: Vec<u16> = per_pid_listen.get(&pid).map(|s| s.iter().copied().collect()).unwrap_or_default();
        let udp: Vec<u16> = per_pid_udp.get(&pid).map(|s| s.iter().copied().collect()).unwrap_or_default();
        let a = devserver::assess(&name, d.path.as_deref(), windows_dir, &listen);
        let scopes: Vec<BindScope> = per_pid_scopes
            .get(&pid)
            .map(|s| {
                s.iter()
                    .map(|v| match v {
                        0 => BindScope::Loopback,
                        1 => BindScope::AllInterfaces,
                        2 => BindScope::LinkLocal,
                        _ => BindScope::Specific,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let all_listen: Vec<u16> = listen.iter().chain(udp.iter()).copied().collect();
        let indicators = if pid == 0 || pid == 4 {
            vec![]
        } else {
            insight::indicators(&insight::ListenerFacts {
                name: &name,
                path: d.path.as_deref(),
                path_exists: d.path.as_deref().map(|p| std::path::Path::new(p).exists()),
                windows_dir,
                scopes: &scopes,
                listen_ports: &all_listen,
                likely_dev_server: a.likely_dev_server,
            })
        };
        if a.likely_dev_server {
            stats.dev_servers += 1;
        }
        let parent = basic.map(|b| b.parent_pid).filter(|p| *p != 0 && *p != pid);
        processes.push(ProcSummary {
            pid,
            parent_name: parent.and_then(|p| procs.get(&p)).map(|p| p.name.clone()),
            parent_pid: parent,
            name,
            path: d.path,
            start_time: d.start_time,
            memory_bytes: d.memory_bytes,
            cpu_percent: cpu.get(&pid).copied(),
            threads: basic.map(|b| b.threads).unwrap_or(0),
            access,
            category: a.category,
            kind: a.kind,
            likely_dev_server: a.likely_dev_server,
            dev_reasons: a.reasons,
            indicators,
            listen_ports: listen,
            udp_ports: udp,
            connections: per_pid_conns.get(&pid).copied().unwrap_or(0),
        });
    }
    stats.processes = processes.len() as u32;
    Snapshot { ts, seq, ports: ports.into_values().collect(), connections, processes, stats }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::net::make_entry;

    pub fn sock(proto: Protocol, addr: &str, port: u16, state: SocketState, pid: u32) -> SocketEntry {
        let remote = (state == SocketState::Established).then(|| ("127.0.0.1".parse().unwrap(), 50000));
        make_entry(proto, addr.parse().unwrap(), port, remote, state, pid)
    }

    pub fn basic(pid: u32, name: &str) -> (u32, ProcessBasic) {
        (pid, ProcessBasic { pid, parent_pid: 1, name: name.into(), threads: 3 })
    }

    pub fn snapshot_of(sockets: Vec<SocketEntry>, names: &[(u32, &str)]) -> Snapshot {
        let procs: HashMap<_, _> = names.iter().map(|(p, n)| basic(*p, n)).collect();
        build(BuildInput {
            sockets,
            procs: &procs,
            details: &HashMap::new(),
            cpu: &HashMap::new(),
            windows_dir: "C:\\Windows",
            include_udp: true,
            ts: 0,
            seq: 1,
        })
    }

    #[test]
    fn groups_bindings_per_port() {
        let s = snapshot_of(
            vec![
                sock(Protocol::Tcp, "127.0.0.1", 3000, SocketState::Listen, 10),
                sock(Protocol::Tcp, "::1", 3000, SocketState::Listen, 10),
                sock(Protocol::Tcp, "0.0.0.0", 8080, SocketState::Listen, 11),
                sock(Protocol::Tcp, "127.0.0.1", 3000, SocketState::Established, 10),
                sock(Protocol::Udp, "0.0.0.0", 5353, SocketState::Bound, 12),
            ],
            &[(10, "node.exe"), (11, "java.exe"), (12, "svc.exe")],
        );
        assert_eq!(s.ports.len(), 3);
        let p3000 = s.ports.iter().find(|p| p.port == 3000).unwrap();
        assert_eq!(p3000.bindings.len(), 2);
        assert_eq!(p3000.pids, vec![10]);
        assert_eq!(p3000.exposure, BindScope::Loopback);
        assert_eq!(p3000.connections, 1);
        assert_eq!(s.stats.tcp_listeners, 3);
        assert_eq!(s.stats.udp_bound, 1);
        assert_eq!(s.stats.exposed, 2);
        let node = s.process(10).unwrap();
        assert!(node.likely_dev_server, "node on 3000 is a dev server");
        assert_eq!(node.listen_ports, vec![3000]);
        assert_eq!(s.connections.len(), 1);
    }

    #[test]
    fn udp_can_be_excluded_and_fingerprint_changes() {
        let socks = vec![sock(Protocol::Udp, "0.0.0.0", 5353, SocketState::Bound, 12)];
        let procs: HashMap<_, _> = [basic(12, "svc.exe")].into_iter().collect();
        let s = build(BuildInput {
            sockets: socks,
            procs: &procs,
            details: &HashMap::new(),
            cpu: &HashMap::new(),
            windows_dir: "C:\\Windows",
            include_udp: false,
            ts: 0,
            seq: 1,
        });
        assert!(s.ports.is_empty());
        let a = snapshot_of(vec![sock(Protocol::Tcp, "127.0.0.1", 1, SocketState::Listen, 1)], &[(1, "a")]);
        let b = snapshot_of(vec![sock(Protocol::Tcp, "127.0.0.1", 2, SocketState::Listen, 1)], &[(1, "a")]);
        assert_ne!(a.fingerprint(), b.fingerprint());
        assert_eq!(a.listener_map().len(), 1);
    }
}
