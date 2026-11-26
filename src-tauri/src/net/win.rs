//! Windows socket tables via IP Helper (`iphlpapi`).
//!
//! `GetExtendedTcpTable` / `GetExtendedUdpTable` with the `*_OWNER_PID`
//! classes return every socket together with its owning PID and work for
//! standard (non-elevated) users.

use super::{make_entry, port_from_dword, Protocol, SocketEntry, SocketState};
use crate::error::{AppError, AppResult};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use windows::Win32::Foundation::{ERROR_INSUFFICIENT_BUFFER, NO_ERROR};
use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, GetExtendedUdpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID,
    TCP_TABLE_OWNER_PID_ALL, UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

/// Calls an IP Helper table function, growing the buffer until it fits.
/// The buffer is `u64`-backed so the table struct is suitably aligned.
fn fetch_table(mut call: impl FnMut(*mut core::ffi::c_void, *mut u32) -> u32) -> AppResult<Vec<u64>> {
    let mut size: u32 = 16 * 1024;
    for _ in 0..8 {
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let mut len = (buf.len() * 8) as u32;
        let rc = call(buf.as_mut_ptr().cast(), &mut len);
        if rc == NO_ERROR.0 {
            return Ok(buf);
        }
        if rc == ERROR_INSUFFICIENT_BUFFER.0 {
            // Tables can grow between calls; add headroom.
            size = len.saturating_add(4096);
            continue;
        }
        return Err(AppError::Os(format!("IP Helper table query failed (code {rc})")));
    }
    Err(AppError::Os("IP Helper table kept growing; giving up".into()))
}

/// Interprets the buffer as `{ dwNumEntries: u32, table: [Row; n] }`.
///
/// # Safety
/// `buf` must hold a table produced by the matching IP Helper call.
unsafe fn rows<R: Copy>(buf: &[u64]) -> Vec<R> {
    let base = buf.as_ptr() as *const u8;
    let count = *(base as *const u32) as usize;
    // The row array starts after the count, aligned for R.
    let align = std::mem::align_of::<R>().max(4);
    let offset = 4usize.div_ceil(align) * align;
    let first = base.add(offset) as *const R;
    let max = (buf.len() * 8).saturating_sub(offset) / std::mem::size_of::<R>().max(1);
    let n = count.min(max);
    (0..n).map(|i| *first.add(i)).collect()
}

fn v4(addr: u32) -> IpAddr {
    IpAddr::V4(Ipv4Addr::from(addr.to_ne_bytes()))
}

fn v6(bytes: [u8; 16]) -> IpAddr {
    let a = Ipv6Addr::from(bytes);
    // Present IPv4-mapped addresses (::ffff:a.b.c.d) as IPv6 still, but keep
    // the canonical text form.
    IpAddr::V6(a)
}

fn tcp4() -> AppResult<Vec<SocketEntry>> {
    let buf = fetch_table(|p, len| unsafe { GetExtendedTcpTable(Some(p), len, false, AF_INET.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0) })?;
    let rows: Vec<MIB_TCPROW_OWNER_PID> = unsafe { rows(&buf) };
    Ok(rows
        .into_iter()
        .map(|r| {
            let state = SocketState::from_mib(r.dwState);
            let remote = (state != SocketState::Listen).then(|| (v4(r.dwRemoteAddr), port_from_dword(r.dwRemotePort)));
            make_entry(Protocol::Tcp, v4(r.dwLocalAddr), port_from_dword(r.dwLocalPort), remote, state, r.dwOwningPid)
        })
        .collect())
}

fn tcp6() -> AppResult<Vec<SocketEntry>> {
    let buf = fetch_table(|p, len| unsafe { GetExtendedTcpTable(Some(p), len, false, AF_INET6.0 as u32, TCP_TABLE_OWNER_PID_ALL, 0) })?;
    let rows: Vec<MIB_TCP6ROW_OWNER_PID> = unsafe { rows(&buf) };
    Ok(rows
        .into_iter()
        .map(|r| {
            let state = SocketState::from_mib(r.dwState);
            let remote = (state != SocketState::Listen).then(|| (v6(r.ucRemoteAddr), port_from_dword(r.dwRemotePort)));
            make_entry(Protocol::Tcp, v6(r.ucLocalAddr), port_from_dword(r.dwLocalPort), remote, state, r.dwOwningPid)
        })
        .collect())
}

fn udp4() -> AppResult<Vec<SocketEntry>> {
    let buf = fetch_table(|p, len| unsafe { GetExtendedUdpTable(Some(p), len, false, AF_INET.0 as u32, UDP_TABLE_OWNER_PID, 0) })?;
    let rows: Vec<MIB_UDPROW_OWNER_PID> = unsafe { rows(&buf) };
    Ok(rows
        .into_iter()
        .map(|r| make_entry(Protocol::Udp, v4(r.dwLocalAddr), port_from_dword(r.dwLocalPort), None, SocketState::Bound, r.dwOwningPid))
        .collect())
}

fn udp6() -> AppResult<Vec<SocketEntry>> {
    let buf = fetch_table(|p, len| unsafe { GetExtendedUdpTable(Some(p), len, false, AF_INET6.0 as u32, UDP_TABLE_OWNER_PID, 0) })?;
    let rows: Vec<MIB_UDP6ROW_OWNER_PID> = unsafe { rows(&buf) };
    Ok(rows
        .into_iter()
        .map(|r| make_entry(Protocol::Udp, v6(r.ucLocalAddr), port_from_dword(r.dwLocalPort), None, SocketState::Bound, r.dwOwningPid))
        .collect())
}

pub fn read_all() -> AppResult<Vec<SocketEntry>> {
    let mut out = tcp4()?;
    out.extend(tcp6()?);
    // UDP tables are best effort: a failure there should not hide TCP data.
    if let Ok(u) = udp4() {
        out.extend(u);
    }
    if let Ok(u) = udp6() {
        out.extend(u);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, UdpSocket};

    #[test]
    fn discovers_own_tcp_listener_with_pid() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let all = read_all().unwrap();
        let me = std::process::id();
        let hit = all
            .iter()
            .find(|s| s.protocol == Protocol::Tcp && s.local_port == port && s.state == SocketState::Listen)
            .expect("own listener must be discovered");
        assert_eq!(hit.pid, me);
        assert_eq!(hit.local_addr, "127.0.0.1");
        assert_eq!(hit.scope, super::super::BindScope::Loopback);
    }

    #[test]
    fn discovers_ipv6_and_udp() {
        let me = std::process::id();
        let u = UdpSocket::bind("127.0.0.1:0").unwrap();
        let uport = u.local_addr().unwrap().port();
        let v6 = TcpListener::bind("[::1]:0").ok();
        let all = read_all().unwrap();
        assert!(all.iter().any(|s| s.protocol == Protocol::Udp && s.local_port == uport && s.pid == me));
        if let Some(l) = v6 {
            let p = l.local_addr().unwrap().port();
            assert!(all.iter().any(|s| s.local_port == p && s.family == super::super::Family::V6 && s.local_addr == "::1"));
        }
    }

    #[test]
    fn discovers_established_connection() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let _c = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _s = l.accept().unwrap();
        let all = read_all().unwrap();
        assert!(all
            .iter()
            .any(|s| s.state == SocketState::Established && s.remote_port == Some(port) && s.remote_addr.as_deref() == Some("127.0.0.1")));
    }
}
