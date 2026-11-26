//! Pure classification helpers: binding scope, connection category and
//! well-known port hints. Hints are informational ("commonly used by"),
//! never a claim about what is actually running.

use super::{BindScope, SocketEntry};
use serde::Serialize;
use std::net::IpAddr;

pub fn scope_of(ip: &IpAddr) -> BindScope {
    match ip {
        IpAddr::V4(a) => {
            if a.is_loopback() {
                BindScope::Loopback
            } else if a.is_unspecified() {
                BindScope::AllInterfaces
            } else if a.is_link_local() {
                BindScope::LinkLocal
            } else {
                BindScope::Specific
            }
        }
        IpAddr::V6(a) => {
            if a.is_loopback() {
                BindScope::Loopback
            } else if a.is_unspecified() {
                BindScope::AllInterfaces
            } else if let Some(v4) = a.to_ipv4_mapped() {
                scope_of(&IpAddr::V4(v4))
            } else if (a.segments()[0] & 0xffc0) == 0xfe80 {
                BindScope::LinkLocal
            } else {
                BindScope::Specific
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionCategory {
    /// Listening / bound socket.
    Listener,
    /// Both ends on this machine.
    Local,
    /// Remote end in a private / link-local range.
    Lan,
    /// Remote end is a public address.
    Internet,
    /// Remote unspecified or unparsable (e.g. TIME_WAIT leftovers).
    Other,
}

fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.is_private() || a.is_link_local() || a.octets()[0] == 100 && (a.octets()[1] & 0xC0) == 64,
        IpAddr::V6(a) => {
            if let Some(v4) = a.to_ipv4_mapped() {
                return is_private(&IpAddr::V4(v4));
            }
            let s0 = a.segments()[0];
            (s0 & 0xfe00) == 0xfc00 || (s0 & 0xffc0) == 0xfe80
        }
    }
}

fn is_loopback(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(a) => a.is_loopback(),
        IpAddr::V6(a) => a.is_loopback() || a.to_ipv4_mapped().is_some_and(|v| v.is_loopback()),
    }
}

pub fn category(s: &SocketEntry) -> ConnectionCategory {
    if s.is_listener() {
        return ConnectionCategory::Listener;
    }
    let Some(remote) = s.remote_addr.as_deref().and_then(|r| r.parse::<IpAddr>().ok()) else {
        return ConnectionCategory::Other;
    };
    if remote.is_unspecified() {
        ConnectionCategory::Other
    } else if is_loopback(&remote) {
        ConnectionCategory::Local
    } else if is_private(&remote) {
        ConnectionCategory::Lan
    } else {
        ConnectionCategory::Internet
    }
}

/// Windows' default dynamic (ephemeral) port range.
pub const DYNAMIC_RANGE: (u16, u16) = (49152, 65535);

pub fn is_dynamic(port: u16) -> bool {
    port >= DYNAMIC_RANGE.0
}

/// Well-known / conventional uses of a port. Informational only.
pub fn well_known(port: u16) -> Option<&'static str> {
    Some(match port {
        20 | 21 => "FTP",
        22 => "SSH",
        25 => "SMTP",
        53 => "DNS",
        67 | 68 => "DHCP",
        80 => "HTTP",
        110 => "POP3",
        123 => "NTP",
        135 => "Windows RPC endpoint mapper",
        137..=139 => "NetBIOS",
        143 => "IMAP",
        443 => "HTTPS",
        445 => "SMB (file sharing)",
        1433 => "Microsoft SQL Server",
        1521 => "Oracle Database",
        1900 => "SSDP / UPnP discovery",
        2375 | 2376 => "Docker API",
        3000 => "Dev server (Node / React / Rails)",
        3306 => "MySQL / MariaDB",
        3389 => "Remote Desktop",
        4200 => "Angular dev server",
        4321 => "Astro dev server",
        5000 => "Dev server (Flask / .NET)",
        5037 => "Android Debug Bridge",
        5173 | 5174 => "Vite dev server",
        5353 => "mDNS",
        5355 => "LLMNR",
        5357 => "Web Services for Devices",
        5432 => "PostgreSQL",
        5672 => "RabbitMQ (AMQP)",
        6006 => "Storybook",
        6379 => "Redis",
        8000 => "Dev server (Django / generic)",
        8080 | 8081 => "HTTP alternate / proxy",
        8443 => "HTTPS alternate",
        8888 => "Jupyter / generic dev",
        9000 => "Dev server / PHP-FPM",
        9090 => "Prometheus / generic",
        9200 | 9300 => "Elasticsearch",
        11211 => "Memcached",
        15672 => "RabbitMQ management",
        27017 => "MongoDB",
        _ => return None,
    })
}

/// Ports conventionally used by local development servers.
pub fn is_common_dev_port(port: u16) -> bool {
    matches!(
        port,
        1313 | 3000
            ..=3010
                | 4000
                | 4200
                | 4321
                | 4173
                | 5000
                | 5001
                | 5173
                | 5174
                | 5500
                | 6006
                | 7000
                | 8000
                | 8001
                | 8080
                | 8081
                | 8443
                | 8888
                | 9000
                | 9229
                | 19000
                | 19006
                | 24678
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::net::{make_entry, Protocol, SocketState};

    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn scopes() {
        assert_eq!(scope_of(&ip("127.0.0.1")), BindScope::Loopback);
        assert_eq!(scope_of(&ip("127.4.5.6")), BindScope::Loopback);
        assert_eq!(scope_of(&ip("0.0.0.0")), BindScope::AllInterfaces);
        assert_eq!(scope_of(&ip("::")), BindScope::AllInterfaces);
        assert_eq!(scope_of(&ip("::1")), BindScope::Loopback);
        assert_eq!(scope_of(&ip("fe80::1")), BindScope::LinkLocal);
        assert_eq!(scope_of(&ip("192.168.1.10")), BindScope::Specific);
        assert_eq!(scope_of(&ip("::ffff:127.0.0.1")), BindScope::Loopback);
    }

    #[test]
    fn categories() {
        let l = ip("192.168.1.5");
        let mk = |r: &str| make_entry(Protocol::Tcp, l, 50000, Some((ip(r), 443)), SocketState::Established, 1);
        assert_eq!(category(&mk("127.0.0.1")), ConnectionCategory::Local);
        assert_eq!(category(&mk("10.0.0.2")), ConnectionCategory::Lan);
        assert_eq!(category(&mk("fd00::2")), ConnectionCategory::Lan);
        assert_eq!(category(&mk("140.82.112.3")), ConnectionCategory::Internet);
        assert_eq!(category(&mk("0.0.0.0")), ConnectionCategory::Other);
        let listen = make_entry(Protocol::Tcp, l, 80, None, SocketState::Listen, 1);
        assert_eq!(category(&listen), ConnectionCategory::Listener);
    }

    #[test]
    fn hints() {
        assert_eq!(well_known(5432), Some("PostgreSQL"));
        assert_eq!(well_known(12345), None);
        assert!(is_common_dev_port(5173));
        assert!(!is_common_dev_port(443));
        assert!(is_dynamic(50000) && !is_dynamic(8080));
    }
}
