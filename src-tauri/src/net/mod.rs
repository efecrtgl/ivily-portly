//! Port and socket discovery.
//!
//! The data model is platform independent so classification, diffing and
//! conflict logic can be unit tested anywhere. The Windows implementation
//! lives in [`win`] and reads the IP Helper owner-PID tables, which do not
//! require administrator privileges.

pub mod classify;
pub mod excluded;
#[cfg(windows)]
mod win;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
}

impl Protocol {
    pub fn as_str(self) -> &'static str {
        match self {
            Protocol::Tcp => "tcp",
            Protocol::Udp => "udp",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "tcp" => Some(Protocol::Tcp),
            "udp" => Some(Protocol::Udp),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Family {
    #[serde(rename = "ipv4")]
    V4,
    #[serde(rename = "ipv6")]
    V6,
}

/// TCP connection state as reported by `MIB_TCP_STATE`. UDP sockets have no
/// state and use [`SocketState::Bound`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SocketState {
    Closed,
    Listen,
    SynSent,
    SynReceived,
    Established,
    FinWait1,
    FinWait2,
    CloseWait,
    Closing,
    LastAck,
    TimeWait,
    DeleteTcb,
    Bound,
    Unknown,
}

impl SocketState {
    pub fn from_mib(v: u32) -> Self {
        match v {
            1 => SocketState::Closed,
            2 => SocketState::Listen,
            3 => SocketState::SynSent,
            4 => SocketState::SynReceived,
            5 => SocketState::Established,
            6 => SocketState::FinWait1,
            7 => SocketState::FinWait2,
            8 => SocketState::CloseWait,
            9 => SocketState::Closing,
            10 => SocketState::LastAck,
            11 => SocketState::TimeWait,
            12 => SocketState::DeleteTcb,
            _ => SocketState::Unknown,
        }
    }
}

/// Where a socket is reachable from, derived from its local address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BindScope {
    /// 127.0.0.0/8 or ::1 — only this machine.
    Loopback,
    /// 0.0.0.0 or :: — every interface, potentially reachable from the network.
    AllInterfaces,
    /// fe80::/10 — link-local.
    LinkLocal,
    /// A specific interface address.
    Specific,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SocketEntry {
    pub protocol: Protocol,
    pub family: Family,
    pub local_addr: String,
    pub local_port: u16,
    pub remote_addr: Option<String>,
    pub remote_port: Option<u16>,
    pub state: SocketState,
    pub pid: u32,
    pub scope: BindScope,
}

impl SocketEntry {
    /// A socket that accepts traffic on its local port: a listening TCP
    /// socket or any bound UDP socket.
    pub fn is_listener(&self) -> bool {
        matches!(self.state, SocketState::Listen | SocketState::Bound)
    }
}

/// Reads every TCP and UDP socket (IPv4 and IPv6) with its owning PID.
#[cfg(windows)]
pub fn read_sockets() -> crate::error::AppResult<Vec<SocketEntry>> {
    win::read_all()
}

#[cfg(not(windows))]
pub fn read_sockets() -> crate::error::AppResult<Vec<SocketEntry>> {
    Err(crate::error::AppError::Unsupported("socket discovery is implemented for Windows only".into()))
}

/// Builds a [`SocketEntry`] from parsed parts, deriving scope. Shared by the
/// Windows reader and tests.
pub fn make_entry(
    protocol: Protocol,
    local: std::net::IpAddr,
    local_port: u16,
    remote: Option<(std::net::IpAddr, u16)>,
    state: SocketState,
    pid: u32,
) -> SocketEntry {
    let family = if local.is_ipv4() { Family::V4 } else { Family::V6 };
    SocketEntry {
        protocol,
        family,
        local_addr: local.to_string(),
        local_port,
        remote_addr: remote.map(|(a, _)| a.to_string()),
        remote_port: remote.map(|(_, p)| p),
        state,
        pid,
        scope: classify::scope_of(&local),
    }
}

/// Converts the low 16 bits of a `dwLocalPort`/`dwRemotePort` value (stored in
/// network byte order) into a host port number.
pub fn port_from_dword(v: u32) -> u16 {
    u16::from_be((v & 0xFFFF) as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn port_conversion_handles_network_order() {
        // 3000 = 0x0BB8, stored big-endian in the low word: bytes [0x0B, 0xB8].
        let raw = u16::from_ne_bytes([0x0B, 0xB8]) as u32;
        assert_eq!(port_from_dword(raw), 3000);
        let raw = u16::from_ne_bytes([0x1F, 0x90]) as u32 | 0xABCD_0000;
        assert_eq!(port_from_dword(raw), 8080, "high word must be ignored");
    }

    #[test]
    fn mib_states_map() {
        assert_eq!(SocketState::from_mib(2), SocketState::Listen);
        assert_eq!(SocketState::from_mib(5), SocketState::Established);
        assert_eq!(SocketState::from_mib(11), SocketState::TimeWait);
        assert_eq!(SocketState::from_mib(99), SocketState::Unknown);
    }

    #[test]
    fn listener_detection() {
        let ip = "127.0.0.1".parse().unwrap();
        let l = make_entry(Protocol::Tcp, ip, 80, None, SocketState::Listen, 1);
        let u = make_entry(Protocol::Udp, ip, 53, None, SocketState::Bound, 1);
        let e = make_entry(Protocol::Tcp, ip, 5000, Some((ip, 80)), SocketState::Established, 1);
        assert!(l.is_listener() && u.is_listener() && !e.is_listener());
        assert_eq!(l.family, Family::V4);
        assert_eq!(l.scope, BindScope::Loopback);
    }
}
