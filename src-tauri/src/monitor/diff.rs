//! Change detection between two listener maps.

use super::model::ListenerMap;
use crate::net::Protocol;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum PortChange {
    Opened { protocol: Protocol, port: u16, owners: Vec<(u32, String)> },
    Closed { protocol: Protocol, port: u16, owners: Vec<(u32, String)> },
    OwnerChanged { protocol: Protocol, port: u16, from: Vec<(u32, String)>, to: Vec<(u32, String)> },
}

impl PortChange {
    pub fn key(&self) -> (Protocol, u16) {
        match self {
            PortChange::Opened { protocol, port, .. }
            | PortChange::Closed { protocol, port, .. }
            | PortChange::OwnerChanged { protocol, port, .. } => (*protocol, *port),
        }
    }
}

pub fn diff(prev: &ListenerMap, next: &ListenerMap) -> Vec<PortChange> {
    let mut out = Vec::new();
    for (key, owners) in next {
        match prev.get(key) {
            None => out.push(PortChange::Opened { protocol: key.0, port: key.1, owners: owners.iter().cloned().collect() }),
            Some(old) if old != owners => {
                // Only a change of *who* owns it counts; an owner simply
                // adding an IPv6 binding keeps the same PID set.
                out.push(PortChange::OwnerChanged {
                    protocol: key.0,
                    port: key.1,
                    from: old.iter().cloned().collect(),
                    to: owners.iter().cloned().collect(),
                })
            }
            _ => {}
        }
    }
    for (key, owners) in prev {
        if !next.contains_key(key) {
            out.push(PortChange::Closed { protocol: key.0, port: key.1, owners: owners.iter().cloned().collect() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(items: &[(u16, u32, &str)]) -> ListenerMap {
        let mut m = ListenerMap::new();
        for (port, pid, name) in items {
            m.entry((Protocol::Tcp, *port)).or_default().insert((*pid, name.to_string()));
        }
        m
    }

    #[test]
    fn detects_open_close_and_owner_change() {
        let a = map(&[(3000, 1, "node.exe"), (8080, 2, "java.exe")]);
        let b = map(&[(3000, 5, "python.exe"), (5432, 3, "postgres.exe")]);
        let d = diff(&a, &b);
        assert_eq!(d.len(), 3);
        assert!(d.iter().any(|c| matches!(c, PortChange::OwnerChanged { port: 3000, .. })));
        assert!(d.iter().any(|c| matches!(c, PortChange::Opened { port: 5432, .. })));
        assert!(d.iter().any(|c| matches!(c, PortChange::Closed { port: 8080, .. })));
    }

    #[test]
    fn identical_maps_produce_nothing() {
        let a = map(&[(3000, 1, "node.exe")]);
        assert!(diff(&a, &a.clone()).is_empty());
        assert!(diff(&ListenerMap::new(), &ListenerMap::new()).is_empty());
    }
}
