//! Port availability and assignment suggestions.
//!
//! A port is reported **available** only when all of these hold:
//! 1. no socket in the live table uses it (any address, any process);
//! 2. it is not inside a Windows excluded port range (verified via netsh);
//! 3. a test bind on 0.0.0.0 and 127.0.0.1 (and :: when IPv6 exists)
//!    succeeds right now — Windows allows a more specific bind next to a
//!    wildcard one, so both are tried.
//!
//! Personal reservations, project registrations and plans don't make a port
//! "occupied"; they're reported as *claims* so the user can decide.

use crate::net::excluded::ExclusionReport;
use crate::net::{Protocol, SocketEntry};
use serde::Serialize;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, TcpListener, UdpSocket};

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Claim {
    /// `project`, `plan`, `reservation`, `favorite`
    pub source: &'static str,
    pub id: i64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Availability {
    pub protocol: Protocol,
    pub port: u16,
    pub available: bool,
    /// PIDs currently using the port according to the socket table.
    pub occupied_by: Vec<u32>,
    pub os_excluded: bool,
    pub os_excluded_administered: bool,
    /// Whether OS exclusions could be verified at all.
    pub os_exclusions_verified: bool,
    pub bind_ok: Option<bool>,
    pub bind_error: Option<String>,
    pub claims: Vec<Claim>,
    pub well_known: Option<&'static str>,
    pub dynamic: bool,
    pub summary: String,
}

/// Attempts to bind the port on wildcard and loopback addresses.
pub fn test_bind(protocol: Protocol, port: u16) -> Result<(), String> {
    let mut addrs = vec![SocketAddr::from((Ipv4Addr::UNSPECIFIED, port)), SocketAddr::from((Ipv4Addr::LOCALHOST, port))];
    // Only test IPv6 if the stack supports it.
    if TcpListener::bind((Ipv6Addr::LOCALHOST, 0)).is_ok() {
        addrs.push(SocketAddr::from((Ipv6Addr::UNSPECIFIED, port)));
    }
    for a in addrs {
        let r = match protocol {
            Protocol::Tcp => TcpListener::bind(a).map(drop),
            Protocol::Udp => UdpSocket::bind(a).map(drop),
        };
        if let Err(e) = r {
            return Err(format!("{a}: {e}"));
        }
    }
    Ok(())
}

pub fn users_of(sockets: &[SocketEntry], protocol: Protocol, port: u16) -> Vec<u32> {
    let mut pids: Vec<u32> = sockets
        .iter()
        .filter(|s| s.protocol == protocol && s.local_port == port && (s.is_listener() || protocol == Protocol::Tcp))
        .map(|s| s.pid)
        .collect();
    pids.sort_unstable();
    pids.dedup();
    pids
}

pub fn assess(
    protocol: Protocol,
    port: u16,
    sockets: &[SocketEntry],
    excl: &ExclusionReport,
    claims: Vec<Claim>,
    do_bind: bool,
) -> Availability {
    let occupied_by = users_of(sockets, protocol, port);
    let ex = excl.find(protocol.as_str(), port);
    let (bind_ok, bind_error) = if do_bind && occupied_by.is_empty() && ex.is_none() {
        match test_bind(protocol, port) {
            Ok(()) => (Some(true), None),
            Err(e) => (Some(false), Some(e)),
        }
    } else {
        (None, None)
    };
    let available = occupied_by.is_empty() && ex.is_none() && bind_ok != Some(false) && (bind_ok == Some(true) || !do_bind);
    let summary = if !occupied_by.is_empty() {
        format!("In use by {} process(es).", occupied_by.len())
    } else if let Some(r) = ex {
        format!(
            "Excluded by Windows ({}–{}{}). Programs cannot bind it.",
            r.start,
            r.end,
            if r.administered { ", administrator-defined" } else { "" }
        )
    } else if bind_ok == Some(false) {
        "A test bind failed, so the port can't be used right now.".to_string()
    } else if !claims.is_empty() {
        format!("Free right now, but claimed in Portly by {}.", claims.iter().map(|c| c.label.as_str()).collect::<Vec<_>>().join(", "))
    } else {
        "Free: not in use, not excluded by Windows, and a test bind succeeded.".to_string()
    };
    Availability {
        protocol,
        port,
        available,
        occupied_by,
        os_excluded: ex.is_some(),
        os_excluded_administered: ex.is_some_and(|r| r.administered),
        os_exclusions_verified: excl.verified,
        bind_ok,
        bind_error,
        claims,
        well_known: crate::net::classify::well_known(port),
        dynamic: crate::net::classify::is_dynamic(port),
        summary,
    }
}

/// Finds up to `count` ports in `[start, end]` that are verified available
/// and unclaimed. `claimed` returns true for ports claimed in Portly.
#[allow(clippy::too_many_arguments)]
pub fn suggest(
    protocol: Protocol,
    start: u16,
    end: u16,
    count: usize,
    sockets: &[SocketEntry],
    excl: &ExclusionReport,
    claimed: &dyn Fn(u16) -> bool,
    do_bind: bool,
) -> Vec<u16> {
    let mut out = Vec::new();
    let mut tried = 0u32;
    for port in start..=end {
        if out.len() >= count || tried > 2000 {
            break;
        }
        if claimed(port) || !users_of(sockets, protocol, port).is_empty() || excl.find(protocol.as_str(), port).is_some() {
            continue;
        }
        tried += 1;
        if !do_bind || test_bind(protocol, port).is_ok() {
            out.push(port);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::excluded::ExcludedRange;
    use crate::net::{make_entry, SocketState};

    fn excl() -> ExclusionReport {
        ExclusionReport {
            ranges: vec![ExcludedRange { protocol: "tcp", family: "ipv4", start: 50000, end: 50009, administered: false }],
            verified: true,
            error: None,
        }
    }

    #[test]
    fn occupied_port_is_unavailable() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let socks = vec![make_entry(Protocol::Tcp, "127.0.0.1".parse().unwrap(), port, None, SocketState::Listen, 77)];
        let a = assess(Protocol::Tcp, port, &socks, &excl(), vec![], true);
        assert!(!a.available);
        assert_eq!(a.occupied_by, vec![77]);
    }

    #[test]
    fn bind_detects_hidden_occupant() {
        // Socket table says free but the port is actually bound: bind must catch it.
        let l = TcpListener::bind("0.0.0.0:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let a = assess(Protocol::Tcp, port, &[], &excl(), vec![], true);
        assert!(!a.available);
        assert_eq!(a.bind_ok, Some(false));
    }

    #[test]
    fn os_excluded_is_unavailable_and_explained() {
        let a = assess(Protocol::Tcp, 50005, &[], &excl(), vec![], true);
        assert!(!a.available && a.os_excluded);
        assert!(a.summary.contains("Excluded by Windows"));
    }

    #[test]
    fn claims_do_not_make_port_unavailable_but_are_reported() {
        let port = { TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port() };
        let claims = vec![Claim { source: "reservation", id: 1, label: "My API".into() }];
        let a = assess(Protocol::Tcp, port, &[], &excl(), claims, true);
        assert!(a.available, "{}", a.summary);
        assert!(a.summary.contains("My API"));
    }

    #[test]
    fn suggestions_skip_claimed_excluded_and_bound() {
        let held = TcpListener::bind("0.0.0.0:0").unwrap();
        let hp = held.local_addr().unwrap().port();
        let start = hp.saturating_sub(2).max(1024);
        let claimed = move |p: u16| p == start;
        let s = suggest(Protocol::Tcp, start, start + 20, 3, &[], &excl(), &claimed, true);
        assert_eq!(s.len(), 3);
        assert!(!s.contains(&start) && !s.contains(&hp));
        let s = suggest(Protocol::Tcp, 50000, 50009, 3, &[], &excl(), &|_| false, false);
        assert!(s.is_empty(), "OS-excluded range yields nothing");
    }
}
