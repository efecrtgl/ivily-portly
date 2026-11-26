//! Rule-based development-server recognition and process categorization.
//! Every result carries the human-readable reasons that produced it.

use crate::net::classify::is_common_dev_port;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProcessCategory {
    DevRuntime,
    Database,
    WebServer,
    Container,
    Browser,
    System,
    Other,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assessment {
    pub category: ProcessCategory,
    /// Friendly runtime / product name, e.g. "Node.js".
    pub kind: Option<&'static str>,
    pub likely_dev_server: bool,
    pub reasons: Vec<String>,
}

fn runtime(name: &str) -> Option<(ProcessCategory, &'static str)> {
    use ProcessCategory::*;
    Some(match name {
        "node.exe" => (DevRuntime, "Node.js"),
        "deno.exe" => (DevRuntime, "Deno"),
        "bun.exe" => (DevRuntime, "Bun"),
        "python.exe" | "pythonw.exe" | "py.exe" | "uvicorn.exe" | "gunicorn.exe" | "flask.exe" => (DevRuntime, "Python"),
        "java.exe" | "javaw.exe" => (DevRuntime, "Java / JVM"),
        "dotnet.exe" | "iisexpress.exe" => (DevRuntime, ".NET"),
        "ruby.exe" | "rails.exe" | "puma.exe" => (DevRuntime, "Ruby"),
        "php.exe" | "php-cgi.exe" => (DevRuntime, "PHP"),
        "go.exe" | "air.exe" => (DevRuntime, "Go"),
        "dart.exe" | "flutter.exe" => (DevRuntime, "Dart / Flutter"),
        "hugo.exe" => (DevRuntime, "Hugo"),
        "esbuild.exe" => (DevRuntime, "esbuild"),
        "cargo.exe" => (DevRuntime, "Rust (cargo)"),
        "godot.exe" | "unity.exe" | "unrealeditor.exe" => (DevRuntime, "Game engine"),
        "nginx.exe" => (WebServer, "nginx"),
        "httpd.exe" => (WebServer, "Apache httpd"),
        "caddy.exe" => (WebServer, "Caddy"),
        "traefik.exe" => (WebServer, "Traefik"),
        "postgres.exe" => (Database, "PostgreSQL"),
        "mysqld.exe" | "mariadbd.exe" => (Database, "MySQL / MariaDB"),
        "redis-server.exe" | "memurai.exe" => (Database, "Redis"),
        "mongod.exe" => (Database, "MongoDB"),
        "sqlservr.exe" => (Database, "SQL Server"),
        "com.docker.backend.exe" | "docker.exe" | "dockerd.exe" | "vpnkit.exe" | "wslrelay.exe" | "wslhost.exe" => {
            (Container, "Docker / WSL")
        }
        "chrome.exe" | "msedge.exe" | "firefox.exe" | "brave.exe" | "opera.exe" => (Browser, "Browser"),
        _ => return None,
    })
}

const BUILD_PATH_MARKERS: &[(&str, &str)] = &[
    ("\\target\\debug\\", "runs from a Rust debug build folder"),
    ("\\target\\release\\", "runs from a Rust build folder"),
    ("\\bin\\debug\\", "runs from a .NET Debug build folder"),
    ("\\node_modules\\", "runs from a node_modules folder"),
    ("\\.venv\\", "runs from a Python virtual environment"),
    ("\\venv\\", "runs from a Python virtual environment"),
    ("\\go-build", "is a temporary `go run` build"),
];

/// `ports` are the TCP listening ports of the process.
pub fn assess(name: &str, path: Option<&str>, windows_dir: &str, ports: &[u16]) -> Assessment {
    let lname = name.to_ascii_lowercase();
    let lpath = path.map(|p| p.to_ascii_lowercase().replace('/', "\\"));
    let wdir = windows_dir.to_ascii_lowercase().trim_end_matches('\\').to_string() + "\\";
    let mut reasons = Vec::new();

    let (mut category, kind) = match runtime(&lname) {
        Some((c, k)) => (c, Some(k)),
        None => (ProcessCategory::Other, None),
    };
    if category == ProcessCategory::Other && lpath.as_deref().is_some_and(|p| p.starts_with(&wdir)) {
        category = ProcessCategory::System;
    }
    if let Some(k) = kind {
        reasons.push(format!("Executable is recognized as {k}"));
    }

    let mut build_marker = false;
    if let Some(p) = lpath.as_deref() {
        for (marker, why) in BUILD_PATH_MARKERS {
            if p.contains(marker) {
                reasons.push(format!("Executable {why}"));
                build_marker = true;
                break;
            }
        }
    }
    let dev_ports: Vec<u16> = ports.iter().copied().filter(|p| is_common_dev_port(*p)).collect();
    if !dev_ports.is_empty() {
        let list = dev_ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", ");
        reasons.push(format!("Listens on conventional development port(s): {list}"));
    }

    let listening = !ports.is_empty();
    let likely = listening
        && match category {
            ProcessCategory::DevRuntime | ProcessCategory::WebServer => true,
            ProcessCategory::Other => build_marker || !dev_ports.is_empty(),
            _ => false,
        };
    if build_marker && category == ProcessCategory::Other {
        category = ProcessCategory::DevRuntime;
    }
    Assessment { category, kind, likely_dev_server: likely, reasons }
}

#[cfg(test)]
mod tests {
    use super::*;
    const W: &str = "C:\\Windows";

    #[test]
    fn node_on_vite_port_is_dev_server() {
        let a = assess("node.exe", Some("C:\\Program Files\\nodejs\\node.exe"), W, &[5173]);
        assert!(a.likely_dev_server);
        assert_eq!(a.kind, Some("Node.js"));
        assert_eq!(a.reasons.len(), 2);
    }

    #[test]
    fn runtime_without_listener_is_not_a_server() {
        let a = assess("python.exe", None, W, &[]);
        assert!(!a.likely_dev_server);
        assert_eq!(a.category, ProcessCategory::DevRuntime);
    }

    #[test]
    fn databases_are_categorized_not_flagged() {
        let a = assess("postgres.exe", None, W, &[5432]);
        assert_eq!(a.category, ProcessCategory::Database);
        assert!(!a.likely_dev_server);
    }

    #[test]
    fn rust_debug_binary_is_dev() {
        let a = assess("my-api.exe", Some("D:\\code\\api\\target\\debug\\my-api.exe"), W, &[7777]);
        assert!(a.likely_dev_server);
        assert_eq!(a.category, ProcessCategory::DevRuntime);
    }

    #[test]
    fn unknown_on_random_port_is_not_dev() {
        let a = assess("app.exe", Some("C:\\Apps\\app.exe"), W, &[40000]);
        assert!(!a.likely_dev_server);
        assert_eq!(a.category, ProcessCategory::Other);
    }

    #[test]
    fn windows_dir_is_system() {
        let a = assess("svchost.exe", Some("C:\\Windows\\System32\\svchost.exe"), W, &[135]);
        assert_eq!(a.category, ProcessCategory::System);
        assert!(!a.likely_dev_server);
    }
}
