//! Server health checks for registered project ports.
//!
//! Checks only ever contact loopback addresses (enforced by `validate` when a
//! project is saved and again here). A TCP check opens and closes a
//! connection; an HTTP check sends one `GET` with `Connection: close` and
//! reads only the status line. No TLS, no redirects, no request bodies.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Up,
    /// Reachable but returned an HTTP 5xx.
    Degraded,
    Down,
    /// Checking disabled for this port.
    Unchecked,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Up => "up",
            Status::Degraded => "degraded",
            Status::Down => "down",
            Status::Unchecked => "unchecked",
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    pub status: Status,
    pub latency_ms: Option<u64>,
    pub http_status: Option<u16>,
    /// Loopback addresses that accepted a connection.
    pub responded: Vec<String>,
    /// Loopback addresses that refused / timed out.
    pub failed: Vec<String>,
    pub error: Option<String>,
    pub checked_at: i64,
}

/// Addresses to probe for a configured host. `localhost` tries both IPv4
/// and IPv6 loopback so address mismatches can be detected.
pub fn targets(host: &str) -> Vec<IpAddr> {
    match host {
        "localhost" => vec![IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST)],
        h => match h.parse::<IpAddr>() {
            Ok(ip) if ip.is_loopback() => vec![ip],
            _ => vec![],
        },
    }
}

/// Parses `HTTP/1.x NNN ...` from the start of a response.
pub fn parse_status_line(buf: &[u8]) -> Option<u16> {
    let line = buf.split(|b| *b == b'\n').next()?;
    let s = std::str::from_utf8(line).ok()?;
    let mut it = s.split_whitespace();
    let proto = it.next()?;
    if !proto.starts_with("HTTP/") {
        return None;
    }
    it.next()?.parse().ok().filter(|c| (100..600).contains(c))
}

fn http_probe(addr: SocketAddr, host_header: &str, path: &str, timeout: Duration) -> Result<u16, String> {
    let mut s = TcpStream::connect_timeout(&addr, timeout).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(timeout)).ok();
    s.set_write_timeout(Some(timeout)).ok();
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: IvilyPortly/{}\r\nAccept: */*\r\nConnection: close\r\n\r\n",
        crate::APP_VERSION
    );
    s.write_all(req.as_bytes()).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 256];
    let mut n = 0;
    while n < buf.len() {
        match s.read(&mut buf[n..]) {
            Ok(0) => break,
            Ok(k) => {
                n += k;
                if buf[..n].contains(&b'\n') {
                    break;
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    parse_status_line(&buf[..n]).ok_or_else(|| "response was not HTTP".to_string())
}

/// Runs one check. `kind` is `none`, `tcp` or `http`.
pub fn check(host: &str, port: u16, kind: &str, path: &str, timeout: Duration) -> CheckResult {
    let now = crate::db::now_ms();
    let mut r = CheckResult {
        status: Status::Down,
        latency_ms: None,
        http_status: None,
        responded: vec![],
        failed: vec![],
        error: None,
        checked_at: now,
    };
    if kind == "none" {
        r.status = Status::Unchecked;
        return r;
    }
    let addrs = targets(host);
    if addrs.is_empty() {
        r.error = Some("host is not a loopback address".into());
        return r;
    }
    let mut best: Option<(Status, u64, Option<u16>)> = None;
    for ip in addrs {
        let sa = SocketAddr::new(ip, port);
        let start = Instant::now();
        let outcome = if kind == "http" {
            let hh = if host == "localhost" { format!("localhost:{port}") } else { format!("{sa}") };
            http_probe(sa, &hh, path, timeout).map(|code| (if code >= 500 { Status::Degraded } else { Status::Up }, Some(code)))
        } else {
            TcpStream::connect_timeout(&sa, timeout).map(|_| (Status::Up, None)).map_err(|e| e.to_string())
        };
        let ms = start.elapsed().as_millis() as u64;
        match outcome {
            Ok((st, code)) => {
                r.responded.push(ip.to_string());
                if best.is_none_or(|(b, _, _)| b != Status::Up && st == Status::Up) {
                    best = Some((st, ms, code));
                }
            }
            Err(e) => {
                r.failed.push(ip.to_string());
                r.error.get_or_insert(e);
            }
        }
    }
    if let Some((st, ms, code)) = best {
        r.status = st;
        r.latency_ms = Some(ms);
        r.http_status = code;
        r.error = None;
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    const T: Duration = Duration::from_millis(800);

    #[test]
    fn status_line_parsing() {
        assert_eq!(parse_status_line(b"HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_line(b"HTTP/1.0 503 Service Unavailable\r\n"), Some(503));
        assert_eq!(parse_status_line(b"SSH-2.0-OpenSSH\r\n"), None);
        assert_eq!(parse_status_line(b"HTTP/1.1 999 X"), None);
    }

    #[test]
    fn targets_are_loopback_only() {
        assert_eq!(targets("localhost").len(), 2);
        assert_eq!(targets("127.0.0.1").len(), 1);
        assert!(targets("10.0.0.1").is_empty());
        assert!(targets("example.com").is_empty());
        let r = check("10.0.0.1", 80, "tcp", "/", T);
        assert_eq!(r.status, Status::Down);
        assert!(r.error.is_some());
    }

    #[test]
    fn tcp_check_up_and_down() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let r = check("127.0.0.1", port, "tcp", "/", T);
        assert_eq!(r.status, Status::Up);
        assert_eq!(r.responded, vec!["127.0.0.1"]);
        drop(l);
        let r = check("127.0.0.1", port, "tcp", "/", T);
        assert_eq!(r.status, Status::Down);
        assert_eq!(check("127.0.0.1", port, "none", "/", T).status, Status::Unchecked);
    }

    #[test]
    fn localhost_reports_which_family_answered() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let r = check("localhost", port, "tcp", "/", T);
        assert_eq!(r.status, Status::Up);
        assert_eq!(r.responded, vec!["127.0.0.1"]);
        assert_eq!(r.failed, vec!["::1"]);
    }

    fn serve_once(l: TcpListener, response: &'static [u8]) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            let mut buf = [0u8; 1024];
            let n = s.read(&mut buf).unwrap();
            s.write_all(response).unwrap();
            String::from_utf8_lossy(&buf[..n]).into_owned()
        })
    }

    #[test]
    fn http_check_reads_status() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = serve_once(l, b"HTTP/1.1 204 No Content\r\n\r\n");
        let r = check("127.0.0.1", port, "http", "/health", T);
        let req = h.join().unwrap();
        assert!(req.starts_with("GET /health HTTP/1.1\r\n"));
        assert!(req.contains("Connection: close"));
        assert_eq!(r.status, Status::Up);
        assert_eq!(r.http_status, Some(204));

        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = serve_once(l, b"HTTP/1.1 500 Oops\r\n\r\n");
        let r = check("127.0.0.1", port, "http", "/", T);
        h.join().unwrap();
        assert_eq!(r.status, Status::Degraded);
    }
}
