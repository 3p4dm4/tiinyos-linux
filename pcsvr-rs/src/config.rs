//! Config loading.
//!
//! The app starts us as `pcsvr -f pcsvr-api.yaml` (cwd = its directory). The
//! config file is the same one the Python shim shipped (`pcsvr-api.yaml`).
//! It is a flat YAML document with one level of sections, so instead of a
//! YAML dependency we parse exactly the subset that occurs in that file:
//!
//!   TopKey: value
//!   Section:
//!     InnerKey: value
//!
//! Lookups are by dotted key ("Shim.DeviceIp"). Values are plain scalars;
//! quoted values have their quotes stripped; `#` after whitespace starts a
//! comment.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::Path;

/// Parsed flat key -> value map of the config file (dotted keys).
#[derive(Debug, Default, Clone)]
pub struct FileConfig {
    map: HashMap<String, String>,
}

impl FileConfig {
    pub fn get(&self, key: &str) -> Option<&str> {
        self.map.get(key).map(|s| s.as_str())
    }

    /// Case-insensitive lookup: the Windows installer writes `Shim:`, some
    /// copies `shim:`; treat the same.
    pub fn get_ci(&self, key: &str) -> Option<&str> {
        for (k, v) in &self.map {
            if k.eq_ignore_ascii_case(key) {
                return Some(v.as_str());
            }
        }
        None
    }

    pub fn insert(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.map.insert(key.into(), value.into());
    }
}

/// Parse the YAML subset used by pcsvr-api.yaml.
pub fn parse_yaml_subset(text: &str) -> FileConfig {
    let mut cfg = FileConfig::default();
    let mut section: Option<String> = None;
    for raw in text.lines() {
        let line = strip_comment(raw);
        if line.trim().is_empty() {
            continue;
        }
        let trimmed = line.trim();
        let indented = raw.starts_with(char::is_whitespace);
        let (key, value) = match trimmed.split_once(':') {
            Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
            None => continue, // not a key: value line; skip (not in our files)
        };
        if key.is_empty() {
            continue;
        }
        let full_key = if indented {
            match &section {
                Some(sec) => format!("{sec}.{key}"),
                None => continue, // indented line before any section: skip
            }
        } else if value.is_empty() {
            // "Section:" — opens a section
            section = Some(key.clone());
            continue;
        } else {
            section = None;
            key
        };
        cfg.insert(full_key, strip_quotes(&value));
    }
    cfg
}

fn strip_comment(line: &str) -> &str {
    let bytes = line.as_bytes();
    for (i, c) in bytes.iter().enumerate() {
        if *c == b'#' && (i == 0 || bytes[i - 1] == b' ' || bytes[i - 1] == b'\t') {
            return &line[..i];
        }
    }
    line
}

fn strip_quotes(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')))
    {
        return t[1..t.len() - 1].to_string();
    }
    t.to_string()
}

// ---------------------------------------------------------------------------
// Resolved configuration

/// Documented default USB-link address: the /30 example in the project's
/// docs (CONNECTING.md, "Option B"). It is a *placeholder example*, not a
/// real device address: users must override it (env `TIINY_DEVICE_IP`,
/// config `Shim.DeviceIp`, or `--device-ip`).
pub const DEFAULT_DEVICE_IP: &str = "172.20.31.109";
pub const DEFAULT_DEVICE_PORT: u16 = 39218;
pub const DEFAULT_WS_INTERVAL_MS: u64 = 3000;
pub const DEFAULT_PROBE_INTERVAL_MS: u64 = 5000;
pub const DEFAULT_PROBE_TIMEOUT_MS: u64 = 3000;
pub const DEFAULT_MAX_WEBSOCKETS: usize = 16;
pub const DEFAULT_WS_READ_TIMEOUT_MS: u64 = 500;
pub const DEFAULT_MAX_CONNECTIONS: usize = 256;
pub const DEFAULT_LOG_MAX_BYTES: u64 = 2_000_000;

#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub host: String,
    pub port: u16,
    pub device_ip: String,
    pub device_port: u16,
    /// Fallback identity, used only when device.json lacks the field.
    pub device_id_fallback: String,
    pub uuid_fallback: String,
    pub device_name_fallback: String,
    pub ws_interval_ms: u64,
    /// How long a websocket session waits for inbound bytes per loop turn. A
    /// client that vanishes without closing is caught by this.
    pub ws_read_timeout_ms: u64,
    pub probe_interval_ms: u64,
    pub probe_timeout_ms: u64,
    pub max_websockets: usize,
    pub max_connections: usize,
    pub log_path: String,
    pub log_max_bytes: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 60000,
            device_ip: DEFAULT_DEVICE_IP.into(),
            device_port: DEFAULT_DEVICE_PORT,
            device_id_fallback: String::new(),
            uuid_fallback: String::new(),
            device_name_fallback: String::new(),
            ws_interval_ms: DEFAULT_WS_INTERVAL_MS,
            ws_read_timeout_ms: DEFAULT_WS_READ_TIMEOUT_MS,
            probe_interval_ms: DEFAULT_PROBE_INTERVAL_MS,
            probe_timeout_ms: DEFAULT_PROBE_TIMEOUT_MS,
            max_websockets: DEFAULT_MAX_WEBSOCKETS,
            max_connections: DEFAULT_MAX_CONNECTIONS,
            log_path: "pcsvr-rs.log".into(),
            log_max_bytes: DEFAULT_LOG_MAX_BYTES,
        }
    }
}

fn env_u16(key: &str, fallback: u16) -> u16 {
    env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(fallback)
}

fn env_u64(key: &str, fallback: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(fallback)
}

fn env_usize(key: &str, fallback: usize) -> usize {
    env::var(key)
        .ok()
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(fallback)
}

fn cfg_u16(file: &FileConfig, dotted: &str, fallback: u16) -> u16 {
    file.get_ci(dotted)
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn cfg_u64(file: &FileConfig, dotted: &str, fallback: u64) -> u64 {
    file.get_ci(dotted)
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn cfg_usize(file: &FileConfig, dotted: &str, fallback: usize) -> usize {
    file.get_ci(dotted)
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn cfg_str(file: &FileConfig, dotted: &str) -> Option<String> {
    file.get_ci(dotted).map(|s| s.to_string())
}

/// Build the resolved config: env wins over file, file wins over defaults.
///
/// One field at a time on purpose: each key's precedence chain stays readable
/// and adding a key is one block, not a 20-field struct literal.
#[allow(clippy::field_reassign_with_default)]
pub fn resolve(file: &FileConfig) -> Config {
    let mut c = Config::default();

    // listen address
    c.host = env::var("PCSVR_HOST")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| cfg_str(file, "Host"))
        .unwrap_or_else(|| "127.0.0.1".into());
    c.port = env_u16("PCSVR_PORT", cfg_u16(file, "Port", 60000));

    // device address: env > Shim.* > DeviceDiscovery.* > default
    c.device_ip = env::var("TIINY_DEVICE_IP")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| cfg_str(file, "Shim.DeviceIp"))
        .or_else(|| cfg_str(file, "DeviceIp"))
        .unwrap_or_else(|| DEFAULT_DEVICE_IP.into());
    c.device_port = env_u16(
        "TIINY_DEVICE_PORT",
        cfg_u16(
            file,
            "Shim.DevicePort",
            cfg_u16(file, "DeviceDiscovery.HTTPPort", DEFAULT_DEVICE_PORT),
        ),
    );

    // fallback identity (only used when device.json lacks the field)
    c.device_id_fallback = cfg_str(file, "Shim.DeviceId")
        .or_else(|| cfg_str(file, "Shim.SerialNumber"))
        .unwrap_or_default();
    c.uuid_fallback = cfg_str(file, "Shim.Uuid").unwrap_or_default();
    c.device_name_fallback = cfg_str(file, "Shim.DeviceName").unwrap_or_default();

    // behaviour
    c.ws_interval_ms = env_u64(
        "PCSVR_WS_INTERVAL_MS",
        cfg_u64(file, "Shim.WsIntervalMs", DEFAULT_WS_INTERVAL_MS),
    );
    c.ws_read_timeout_ms = env_u64(
        "PCSVR_WS_READ_TIMEOUT_MS",
        cfg_u64(file, "Shim.WsReadTimeoutMs", DEFAULT_WS_READ_TIMEOUT_MS),
    );
    c.probe_interval_ms = env_u64(
        "PCSVR_PROBE_INTERVAL_MS",
        cfg_u64(file, "Shim.ProbeIntervalMs", DEFAULT_PROBE_INTERVAL_MS),
    );
    c.probe_timeout_ms = env_u64(
        "PCSVR_PROBE_TIMEOUT_MS",
        cfg_u64(file, "Shim.ProbeTimeoutMs", DEFAULT_PROBE_TIMEOUT_MS),
    );
    c.max_websockets = env_usize(
        "PCSVR_MAX_WS",
        cfg_usize(file, "Shim.MaxWebSockets", DEFAULT_MAX_WEBSOCKETS),
    )
    .max(1);
    c.max_connections = env_usize("PCSVR_MAX_CONNECTIONS", DEFAULT_MAX_CONNECTIONS).max(1);

    // logging
    c.log_path = env::var("PCSVR_LOG")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| cfg_str(file, "Shim.LogPath"))
        .unwrap_or_else(|| "pcsvr-rs.log".into());
    c.log_max_bytes = env_u64(
        "PCSVR_LOG_MAX_BYTES",
        cfg_u64(file, "Shim.LogMaxBytes", DEFAULT_LOG_MAX_BYTES),
    );

    c
}

/// Load the config file if `path` exists; a missing/empty file is not an
/// error (defaults + env still apply).
pub fn load_file(path: &Path) -> Result<FileConfig, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(parse_yaml_subset(&text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileConfig::default()),
        Err(e) => Err(format!("cannot read config {}: {e}", path.display())),
    }
}

/// The app passes `-f pcsvr-api.yaml`; without `-f`, try `pcsvr-api.yaml`
/// in the current directory (the Python shim ignored argv entirely, so
/// being lenient here only widens compatibility).
pub fn load_cli_config(config_arg: Option<&str>) -> Result<FileConfig, String> {
    match config_arg {
        Some(p) => load_file(Path::new(p)),
        None => {
            let default = Path::new("pcsvr-api.yaml");
            if default.exists() {
                load_file(default)
            } else {
                Ok(FileConfig::default())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(name: &str, content: &str) -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(name);
        let mut f = fs::File::create(&p).unwrap();
        f.write_all(content.as_bytes()).unwrap();
        p
    }

    #[test]
    fn parses_sample_file_shape() {
        let text = r#"
# comment line
Name: pcsvr-api
Host: 127.0.0.1
Port: 60000   # inline comment

Shim:
  DeviceId: "TESTSN000000000001"
  DeviceIp: 10.0.0.9
  DeviceName: 'Some Pocket'

WireGuard:
  Enabled: false
  ConfigPath: /usr/local/etc/wireguard/tiiny-wg.conf
"#;
        let c = parse_yaml_subset(text);
        assert_eq!(c.get("Name"), Some("pcsvr-api"));
        assert_eq!(c.get("Port"), Some("60000"));
        assert_eq!(c.get("Shim.DeviceId"), Some("TESTSN000000000001"));
        assert_eq!(c.get("Shim.DeviceIp"), Some("10.0.0.9"));
        assert_eq!(c.get("Shim.DeviceName"), Some("Some Pocket"));
        assert_eq!(c.get("WireGuard.Enabled"), Some("false"));
        assert_eq!(c.get_ci("shim.deviceip"), Some("10.0.0.9"));
        assert_eq!(c.get("Shim.Missing"), None);
    }

    #[test]
    fn resolve_defaults_and_file() {
        let file = parse_yaml_subset(
            "Host: 127.0.0.1\nPort: 60000\nShim:\n  DeviceIp: 10.1.2.3\n  WsIntervalMs: 500\n",
        );
        let c = resolve(&file);
        assert_eq!(c.host, "127.0.0.1");
        assert_eq!(c.port, 60000);
        assert_eq!(c.device_ip, "10.1.2.3");
        assert_eq!(c.device_port, 39218);
        assert_eq!(c.ws_interval_ms, 500);
        assert_eq!(c.max_websockets, 16);
    }

    #[test]
    fn env_overrides_file() {
        let p = write_temp("pcsvr-cfg-test.yaml", "Port: 12345\n");
        // env is read per-process; use a unique var name to avoid races
        env::set_var("PCSVR_PORT", "1234");
        let file = load_file(&p).unwrap();
        let c = resolve(&file);
        assert_eq!(c.port, 1234);
        env::remove_var("PCSVR_PORT");
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn missing_file_is_ok() {
        let c = load_file(Path::new("/nonexistent/pcsvr-api.yaml")).unwrap();
        let cfg = resolve(&c);
        assert_eq!(cfg.device_ip, DEFAULT_DEVICE_IP);
    }

    /// The shipped example must parse to exactly what its comments promise —
    /// docs and parser are checked against each other, and inline comments are
    /// proven not to leak into values.
    #[test]
    fn shipped_example_parses_as_documented() {
        let text = include_str!("../pcsvr-api.yaml.example");
        let file = parse_yaml_subset(text);
        assert_eq!(file.get("Host").unwrap(), "127.0.0.1");
        assert_eq!(file.get("Port").unwrap(), "60000");
        assert_eq!(file.get("Shim.DeviceIp").unwrap(), DEFAULT_DEVICE_IP);
        assert_eq!(file.get("DeviceDiscovery.HTTPPort").unwrap(), "39218");
        assert_eq!(file.get("Log.Level").unwrap(), "info");
        // every commented-out key stays absent (no value, no comment text)
        for k in [
            "Shim.DeviceId",
            "Shim.Uuid",
            "Shim.DeviceName",
            "Shim.WsIntervalMs",
            "Shim.MaxWebSockets",
            "Shim.LogPath",
        ] {
            assert_eq!(file.get(k), None, "{k} must stay unset in the example");
        }
        // and the values that are set carry no trailing comment
        assert!(!file.get("Port").unwrap().contains('#'));
    }
}
