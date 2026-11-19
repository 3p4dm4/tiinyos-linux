//! Device state: reachability probe, identity read from `device.json`, and
//! the snapshot object the client expects.
//!
//! Identity is never compiled in. Every probe fetches
//! `http://<device_ip>:<device_port>/device.json` (no auth, per the device
//! API docs) and refreshes the cached identity from it; config keys are the
//! documented fallback for whatever the document does not carry. See
//! `README.md` ("Verified vs assumed").

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::config::Config;
use crate::json::{self, Value};

const MAX_DEVICE_JSON: usize = 512 * 1024;

/// The version string the Python shim reported on `/status`. Kept verbatim:
/// the vendor app may gate on it, and the Rust build identifies itself with
/// `pcsvr --version` instead.
pub const SHIM_VERSION: &str = "0.1.36-shim";

/// Identity as presented to the client.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Identity {
    pub device_id: String,
    pub uuid: String,
    pub device_name: String,
    pub serial_number: String,
    /// "device.json" | "config" | "" (nothing known yet)
    pub source: String,
}

#[derive(Clone, Debug, Default)]
pub struct DeviceState {
    pub reachable: bool,
    pub selected: bool,
    pub identity: Identity,
}

pub struct Device {
    cfg: Config,
    state: RwLock<DeviceState>,
    /// Serialize the probe HTTP call: at most one request in flight.
    probe_lock: Mutex<()>,
    selected: AtomicBool,
}

impl Device {
    pub fn new(cfg: Config) -> Self {
        let identity = fallback_identity(&cfg);
        Self {
            cfg,
            state: RwLock::new(DeviceState {
                reachable: false,
                selected: false,
                identity,
            }),
            probe_lock: Mutex::new(()),
            selected: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn state(&self) -> DeviceState {
        let mut st = self.state.read().unwrap().clone();
        st.selected = self.selected.load(Ordering::SeqCst);
        st
    }

    pub fn reachable(&self) -> bool {
        self.state.read().unwrap().reachable
    }

    /// Whether a client has completed `/select_device` for this device.
    pub fn is_selected(&self) -> bool {
        self.selected.load(Ordering::SeqCst)
    }

    pub fn set_selected(&self, on: bool) {
        self.selected.store(on, Ordering::SeqCst);
    }

    /// The URL probed for reachability (also reported in the snapshot).
    pub fn metadata_url(&self) -> String {
        format!(
            "http://{}:{}/device.json",
            self.cfg.device_ip, self.cfg.device_port
        )
    }

    /// One probe: GET device.json, refresh reachability and identity.
    /// Returns the new reachability.
    pub fn probe(&self) -> bool {
        let _guard = self.probe_lock.lock().unwrap_or_else(|e| e.into_inner());
        let timeout = Duration::from_millis(self.cfg.probe_timeout_ms.max(50));
        match fetch_device_json(&self.cfg.device_ip, self.cfg.device_port, timeout) {
            Ok(doc) => {
                let identity = identity_from(&doc, &self.cfg);
                let mut st = self.state.write().unwrap();
                st.reachable = true;
                if identity != st.identity {
                    st.identity = identity;
                }
                true
            }
            Err(_) => {
                // Keep the last known identity (the client tolerates a
                // snapshot whose fields were learned while the device was
                // up); only reachability flips.
                self.state.write().unwrap().reachable = false;
                false
            }
        }
    }

    /// `devices` / `local_devices`: empty when unreachable, exactly as the
    /// Python shim behaved.
    pub fn device_list(&self) -> Vec<Value> {
        let st = self.state();
        if st.reachable {
            vec![self.snapshot_with(&st)]
        } else {
            Vec::new()
        }
    }

    pub fn snapshot(&self) -> Value {
        let st = self.state();
        self.snapshot_with(&st)
    }

    fn snapshot_with(&self, st: &DeviceState) -> Value {
        let ip = self.cfg.device_ip.as_str();
        let url = self.metadata_url();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        json::obj(vec![
            ("device_id", json::s(st.identity.device_id.clone())),
            ("uuid", json::s(st.identity.uuid.clone())),
            ("device_name", json::s(st.identity.device_name.clone())),
            ("serial_number", json::s(st.identity.serial_number.clone())),
            ("device_ip", json::s(ip)),
            ("local", json::b(false)),
            ("usb", json::b(true)),
            ("reachable", json::b(st.reachable)),
            ("connection_type", json::s("usb")),
            ("is_activated", json::b(true)),
            (
                "addresses",
                json::arr(vec![json::obj(vec![
                    ("ipv4", json::s(ip)),
                    ("interface", json::s("usb")),
                ])]),
            ),
            ("preferred_endpoints", json::arr(vec![json::s(url.clone())])),
            ("last_seen_at", json::i(now)),
            ("metadata_url", json::s(url)),
        ])
    }

    /// The `{"event":"connection", ...}` payload pushed over the websocket.
    pub fn connection_payload(&self) -> String {
        let st = self.state();
        let list: Vec<Value> = if st.reachable {
            vec![self.snapshot_with(&st)]
        } else {
            Vec::new()
        };
        // selected_device must be an OBJECT or null: with a string the client
        // falls into pc_service_selected_device_unavailable.
        let selected: Value = if st.reachable && st.selected {
            self.snapshot_with(&st)
        } else {
            json::n()
        };
        json::to_json(&json::obj(vec![
            ("event", json::s("connection")),
            (
                "data",
                json::obj(vec![
                    ("devices", json::arr(list.clone())),
                    ("local_devices", json::arr(list)),
                    ("selected_device", selected),
                ]),
            ),
        ]))
    }

    /// The `/devices` payload. `selected_regardless` mirrors the Python
    /// shim's asymmetry: `POST /devices` reports the device as selected
    /// whenever it is reachable, `GET /devices` only after a matching
    /// `/select_device`.
    pub fn devices_payload(&self, selected_regardless: bool) -> String {
        let st = self.state();
        let list: Vec<Value> = if st.reachable {
            vec![self.snapshot_with(&st)]
        } else {
            Vec::new()
        };
        let selected: Value = if st.reachable && (selected_regardless || st.selected) {
            self.snapshot_with(&st)
        } else {
            json::n()
        };
        json::to_json(&json::obj(vec![
            ("ok", json::b(true)),
            ("device_count", json::i(list.len() as i64)),
            ("devices", json::arr(list.clone())),
            ("local_devices", json::arr(list)),
            ("selected_device", selected),
        ]))
    }

    /// `POST /select_device` reply. Byte-for-byte the Python shape: `ok` is
    /// always true and `selected_device` always carries the presented id —
    /// the accept/reject result is visible in the *next* snapshot, not here.
    pub fn select_payload(&self) -> String {
        let st = self.state();
        let presented = st.identity.device_id.clone();
        json::to_json(&json::obj(vec![
            ("ok", json::b(true)),
            ("selected_device", json::s(presented)),
            ("auto_selected", json::b(false)),
            ("devices", json::arr(vec![self.snapshot_with(&st)])),
        ]))
    }

    pub fn status_payload(&self) -> String {
        // `version` stays the shim's string: the app may gate on it, and the
        // Rust build identifies itself with `pcsvr --version`.
        json::to_json(&json::obj(vec![
            ("ok", json::b(true)),
            ("status", json::s("running")),
            ("service_status", json::s("running")),
            ("running", json::b(true)),
            ("installed", json::b(true)),
            ("enabled", json::b(true)),
            ("platform", json::s("linux")),
            ("version", json::s(SHIM_VERSION)),
            ("device_count", json::i(self.device_list().len() as i64)),
        ]))
    }
}

fn fallback_identity(cfg: &Config) -> Identity {
    let name = if cfg.device_name_fallback.is_empty() {
        "Tiiny".to_string()
    } else {
        cfg.device_name_fallback.clone()
    };
    let id = first_non_empty(&[cfg.device_id_fallback.as_str(), cfg.uuid_fallback.as_str()]);
    Identity {
        device_id: id.clone(),
        uuid: cfg.uuid_fallback.clone(),
        device_name: name,
        serial_number: id,
        source: "config".into(),
    }
}

/// Pull the identity out of a device.json document, falling back to config
/// for whatever the document does not carry.
///
/// Field-name evidence (see README): the device docs list a device name,
/// IPv4/IPv6, `device_ip`, `host_ip`, `usb.network` and metadata URLs for
/// `:39218/device.json`; `device_id` and `serial_number` are the names the
/// same discovery subsystem uses in the UDP reply. We try aliases and never
/// invent a value.
pub fn identity_from(doc: &Value, cfg: &Config) -> Identity {
    let serial = doc
        .first_str(&["serial_number", "serial", "device_serial", "sn"])
        .map(|s| s.to_string());
    let device_id = doc
        .first_str(&["device_id", "id", "deviceid"])
        .map(|s| s.to_string());
    let uuid = doc
        .first_str(&["uuid", "device_uuid", "guid"])
        .map(|s| s.to_string());
    let name = doc
        .first_str(&["device_name", "name", "friendly_name"])
        .map(|s| s.to_string());

    // The client compares our presented device_id with what /api/v1/connect
    // returns, and that is the serial. Priority: operator config (the only
    // way to present a serial device.json does not carry) > serial in
    // device.json > device_id > uuid > config uuid.
    let presented = first_non_empty(&[
        cfg.device_id_fallback.as_str(),
        serial.as_deref().unwrap_or(""),
        device_id.as_deref().unwrap_or(""),
        uuid.as_deref().unwrap_or(""),
        cfg.uuid_fallback.as_str(),
    ]);
    let serial_number = first_non_empty(&[serial.as_deref().unwrap_or(""), presented.as_str()]);
    let uuid_out = first_non_empty(&[
        uuid.as_deref().unwrap_or(""),
        device_id.as_deref().unwrap_or(""),
        cfg.uuid_fallback.as_str(),
    ]);
    let name_out = first_non_empty(&[
        name.as_deref().unwrap_or(""),
        cfg.device_name_fallback.as_str(),
        "Tiiny",
    ]);
    Identity {
        device_id: presented,
        uuid: uuid_out,
        device_name: name_out,
        serial_number,
        source: "device.json".into(),
    }
}

fn first_non_empty(candidates: &[&str]) -> String {
    for c in candidates {
        let t = c.trim();
        if !t.is_empty() {
            return t.to_string();
        }
    }
    String::new()
}

// ---------------------------------------------------------------------------
// The probe HTTP GET (no dependencies)

fn fetch_device_json(host: &str, port: u16, timeout: Duration) -> Result<Value, String> {
    let addr = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("resolve: {e}"))?
        .next()
        .ok_or("no address")?;
    let mut stream =
        TcpStream::connect_timeout(&addr, timeout).map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(timeout))
        .map_err(|e| format!("read timeout: {e}"))?;
    stream
        .set_write_timeout(Some(timeout))
        .map_err(|e| format!("write timeout: {e}"))?;
    let req = format!(
        "GET /device.json HTTP/1.1\r\nHost: {host}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(req.as_bytes())
        .map_err(|e| e.to_string())?;

    // Absolute deadline: a per-call read timeout alone would let a slow drip
    // hold the probe thread forever.
    let deadline = Instant::now() + timeout;
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut tmp = [0u8; 4096];
    loop {
        if Instant::now() > deadline {
            return Err("deadline".into());
        }
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > MAX_DEVICE_JSON {
                    return Err("response too large".into());
                }
                if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    break;
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => return Err(format!("read: {e}")),
        }
    }
    let head_pos = buf
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or("no header terminator")?;
    let head = String::from_utf8_lossy(&buf[..head_pos]).to_lowercase();
    let status_line = head.lines().next().unwrap_or("");
    if !status_line.contains(" 200") {
        return Err(format!("status {status_line}"));
    }
    let chunked = head
        .lines()
        .any(|l| l.starts_with("transfer-encoding:") && l.contains("chunked"));
    let body_start = head_pos + 4;
    let raw_body = if chunked {
        read_to_deadline(&mut stream, &mut buf, deadline)?;
        decode_chunked(&buf[body_start..])?
    } else {
        read_to_deadline(&mut stream, &mut buf, deadline)?;
        buf[body_start..].to_vec()
    };
    let text = String::from_utf8_lossy(&raw_body).into_owned();
    json::parse(text.trim()).map_err(|e| format!("bad json: {e}"))
}

fn read_to_deadline(
    stream: &mut TcpStream,
    buf: &mut Vec<u8>,
    deadline: Instant,
) -> Result<(), String> {
    let mut tmp = [0u8; 4096];
    loop {
        if Instant::now() > deadline {
            return Ok(());
        }
        match stream.read(&mut tmp) {
            Ok(0) => return Ok(()),
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > MAX_DEVICE_JSON {
                    return Err("response too large".into());
                }
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(_) => return Ok(()),
        }
    }
}

/// Decode an HTTP/1.1 chunked body (device.json is small, one or two chunks).
fn decode_chunked(src: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(src.len());
    let mut pos = 0;
    loop {
        let crlf = src[pos..]
            .windows(2)
            .position(|w| w == b"\r\n")
            .map(|p| pos + p)
            .ok_or("chunk size line missing")?;
        let line = String::from_utf8_lossy(&src[pos..crlf])
            .trim()
            .to_lowercase();
        let size = usize::from_str_radix(line.split(';').next().unwrap_or(""), 16)
            .map_err(|_| "bad chunk size".to_string())?;
        if size == 0 {
            return Ok(out);
        }
        let start = crlf + 2;
        if src.len() < start + size + 2 {
            return Err("truncated chunk".into());
        }
        out.extend_from_slice(&src[start..start + size]);
        pos = start + size + 2;
    }
}

/// Background probe loop: one thread for the process lifetime, one HTTP call
/// per interval, no per-connection threads.
pub fn probe_loop(device: Arc<Device>, stop: Arc<AtomicBool>) {
    let interval = Duration::from_millis(device.config().probe_interval_ms.max(50));
    while !stop.load(Ordering::SeqCst) {
        device.probe();
        let mut slept = 0u64;
        while slept < interval.as_millis() as u64 && !stop.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(25));
            slept += 25;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    fn cfg_with(ip: &str, port: u16) -> Config {
        Config {
            device_ip: ip.into(),
            device_port: port,
            probe_timeout_ms: 500,
            probe_interval_ms: 100,
            ..Default::default()
        }
    }

    /// A throwaway device.json server on an ephemeral port.
    fn fake_device(body: String, status: String) -> (u16, std::thread::JoinHandle<()>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            for stream in l.incoming() {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
            }
        });
        (port, h)
    }

    fn closed_port() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    #[test]
    fn probe_reads_identity_and_snapshot_shape() {
        let doc = r#"{"device_id":"TESTUUID00000000000000000000000f","name":"Test Pocket","device_ip":"10.0.0.9","serial_number":"TESTSN000000000001"}"#.to_string();
        let (port, _h) = fake_device(doc, "200 OK".to_string());
        let dev = Device::new(cfg_with("127.0.0.1", port));
        assert!(dev.probe());
        let st = dev.state();
        assert!(st.reachable);
        assert_eq!(st.identity.device_id, "TESTSN000000000001"); // serial wins
        assert_eq!(st.identity.uuid, "TESTUUID00000000000000000000000f");
        assert_eq!(st.identity.device_name, "Test Pocket");

        let snap = dev.snapshot();
        let keys: Vec<&str> = snap.get("device_id").map(|_| vec!["device_id"]).unwrap();
        assert_eq!(keys, vec!["device_id"]);
        // exact field set and order of the Python snapshot
        if let Value::Obj(pairs) = &snap {
            let names: Vec<&str> = pairs.iter().map(|(k, _)| k.as_str()).collect();
            assert_eq!(
                names,
                vec![
                    "device_id",
                    "uuid",
                    "device_name",
                    "serial_number",
                    "device_ip",
                    "local",
                    "usb",
                    "reachable",
                    "connection_type",
                    "is_activated",
                    "addresses",
                    "preferred_endpoints",
                    "last_seen_at",
                    "metadata_url"
                ]
            );
        } else {
            panic!("snapshot not an object");
        }
        let payload = dev.connection_payload();
        assert!(payload.starts_with("{\"event\": \"connection\", \"data\": {\"devices\": [{"));
        assert!(payload.contains("\"selected_device\": null"));
    }

    #[test]
    fn unreachable_device_lists_nothing() {
        let dev = Device::new(cfg_with("127.0.0.1", closed_port()));
        assert!(!dev.probe());
        let st = dev.state();
        assert!(!st.reachable);
        assert!(dev.device_list().is_empty());
        let payload = dev.connection_payload();
        assert!(payload.contains("\"devices\": []"));
        assert!(payload.contains("\"selected_device\": null"));
        assert_eq!(dev.devices_payload(false), dev.devices_payload(true));
        assert!(dev.devices_payload(false).contains("\"device_count\": 0"));
    }

    #[test]
    fn select_flow_and_selected_object() {
        let doc = r#"{"device_id":"TESTUUID00000000000000000000000f","name":"P"}"#.to_string();
        let (port, _h) = fake_device(doc, "200 OK".to_string());
        let dev = Device::new(cfg_with("127.0.0.1", port));
        dev.probe();
        // before select: selected_device is null
        assert!(dev
            .connection_payload()
            .contains("\"selected_device\": null"));
        dev.set_selected(true);
        let after = dev.connection_payload();
        assert!(after
            .contains("\"selected_device\": {\"device_id\": \"TESTUUID00000000000000000000000f\""));
        // a non-matching select clears it again
        dev.set_selected(false);
        assert!(dev
            .connection_payload()
            .contains("\"selected_device\": null"));
    }

    #[test]
    fn identity_falls_back_to_config() {
        let doc = r#"{"name":"Only Name"}"#.to_string();
        let (port, _h) = fake_device(doc, "200 OK".to_string());
        let mut cfg = cfg_with("127.0.0.1", port);
        cfg.device_id_fallback = "FALLBACKSN0000000001".into();
        cfg.uuid_fallback = "fallbackuuid".into();
        let dev = Device::new(cfg);
        dev.probe();
        let st = dev.state();
        assert_eq!(st.identity.device_id, "FALLBACKSN0000000001");
        assert_eq!(st.identity.device_name, "Only Name");
        assert_eq!(st.identity.uuid, "fallbackuuid");
    }

    #[test]
    fn probe_handles_non_200_and_garbage() {
        let (port, _h) = fake_device("{}".into(), "500 Internal Server Error".to_string());
        let dev = Device::new(cfg_with("127.0.0.1", port));
        assert!(!dev.probe());

        let (port2, _h2) = fake_device("not json at all".into(), "200 OK".to_string());
        let dev2 = Device::new(cfg_with("127.0.0.1", port2));
        assert!(!dev2.probe());
    }

    #[test]
    fn chunked_body_is_decoded() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in l.incoming() {
                let mut s = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let mut buf = [0u8; 1024];
                let _ = s.read(&mut buf);
                let body =
                    b"{\"name\":\"Chunked Pocket\",\"serial_number\":\"TESTSN000000000002\"}";
                let mut resp =
                    b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
                        .to_vec();
                resp.extend_from_slice(format!("{:x}\r\n", body.len()).as_bytes());
                resp.extend_from_slice(body);
                resp.extend_from_slice(b"\r\n0\r\n\r\n");
                let _ = s.write_all(&resp);
            }
        });
        let dev = Device::new(cfg_with("127.0.0.1", port));
        assert!(dev.probe());
        assert_eq!(dev.state().identity.device_name, "Chunked Pocket");
    }

    #[test]
    fn decode_chunked_multi_chunk() {
        let src = b"3\r\nabc\r\n4\r\ndefg\r\n0\r\n\r\n";
        assert_eq!(decode_chunked(src).unwrap(), b"abcdefg".to_vec());
        assert!(decode_chunked(b"zz\r\nx\r\n").is_err());
    }
}
