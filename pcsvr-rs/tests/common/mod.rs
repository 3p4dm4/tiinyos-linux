//! Shared test scaffolding: a fake Pocket `device.json` server, a Config
//! builder, and minimal raw HTTP/WebSocket clients.
//!
//! Every listener in these tests binds `127.0.0.1` on port **0** (ephemeral).
//! Port 60000 — the real service port — is never touched, and no test ever
//! opens a socket to a device address: the fake device is a local listener.

#![allow(dead_code)]

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use pcsvr_rs::config::Config;
use pcsvr_rs::server::Server;

pub const TEST_UUID: &str = "TESTUUID00000000000000000000000f";
pub const TEST_SN: &str = "TESTSN000000000001";

/// A local HTTP server that answers `GET /device.json` like the Pocket does.
pub struct FakeDevice {
    pub port: u16,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl FakeDevice {
    /// `body` is what `/device.json` returns; `status` the HTTP status line.
    pub fn start(body: String, status: &'static str) -> FakeDevice {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind fake device");
        let port = listener.local_addr().unwrap().port();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let handle = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let _ = listener.set_nonblocking(true);
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((mut s, _)) => {
                            let mut buf = [0u8; 1024];
                            let _ = s.read(&mut buf);
                            let resp = format!(
                                "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            );
                            let _ = s.write_all(resp.as_bytes());
                        }
                        Err(_) => std::thread::sleep(Duration::from_millis(5)),
                    }
                }
            })
        };
        FakeDevice {
            port,
            stop,
            handle: Some(handle),
        }
    }
}

impl Drop for FakeDevice {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

pub fn device_json(uuid: &str, name: &str, sn: &str) -> String {
    format!(
        "{{\"device_id\":\"{uuid}\",\"name\":\"{name}\",\"device_ip\":\"10.0.0.9\",\"serial_number\":\"{sn}\"}}"
    )
}

/// Config pointing at the fake device, listening on an ephemeral port.
#[allow(clippy::field_reassign_with_default)]
pub fn config_for(device_port: u16) -> Config {
    let mut c = Config::default();
    c.host = "127.0.0.1".into();
    c.port = 0; // never a fixed port in tests
    c.device_ip = "127.0.0.1".into();
    c.device_port = device_port;
    c.device_id_fallback = String::new();
    c.uuid_fallback = String::new();
    c.device_name_fallback = String::new();
    c.probe_timeout_ms = 500;
    c.probe_interval_ms = 200;
    c.ws_interval_ms = 50;
    c.ws_read_timeout_ms = 50;
    c.log_path = String::new(); // discard: tests must not write files
    c
}

/// Start a server on port 0 and wait until it answers `/status`.
pub fn spawn_server(cfg: Config) -> Server {
    let listener = TcpListener::bind((cfg.host.as_str(), 0)).unwrap();
    let addr = listener.local_addr().unwrap();
    let srv = pcsvr_rs::server::start_on(listener, addr, cfg).unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Ok(resp) = http_get(srv.addr, "/status") {
            if resp.status == 200 {
                return srv;
            }
        }
        if Instant::now() > deadline {
            panic!("server did not come up");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).to_string()
    }
    pub fn header(&self, name: &str) -> Option<String> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.clone())
    }
}

/// One request on a fresh connection, no keep-alive.
pub fn http_request(
    addr: std::net::SocketAddr,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> std::io::Result<Response> {
    let mut s = TcpStream::connect(addr)?;
    s.set_read_timeout(Some(Duration::from_secs(5)))?;
    let mut req = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(b) = body {
        req.push_str(&format!("Content-Length: {}\r\n", b.len()));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())?;
    if let Some(b) = body {
        s.write_all(b.as_bytes())?;
    }
    s.flush()?;
    read_response(&mut s)
}

pub fn http_get(addr: std::net::SocketAddr, path: &str) -> std::io::Result<Response> {
    http_request(addr, "GET", path, None)
}

/// Read one HTTP response off a stream (Content-Length framed).
pub fn read_response(s: &mut TcpStream) -> std::io::Result<Response> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(pos) = find(&buf, b"\r\n\r\n") {
            break pos + 4;
        }
        let n = s.read(&mut tmp)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "closed before headers",
            ));
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
    let status: u16 = head
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let headers: Vec<(String, String)> = head
        .lines()
        .skip(1)
        .filter_map(|l| {
            l.split_once(':')
                .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        })
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k == "content-length")
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    while buf.len() < head_end + len {
        let n = s.read(&mut tmp)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    Ok(Response {
        status,
        headers,
        body: buf[head_end..].to_vec(),
    })
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// A minimal RFC 6455 client: enough to drive the contract tests.
pub struct WsClient {
    pub sock: TcpStream,
    pub buf: Vec<u8>,
}

impl WsClient {
    pub fn connect(addr: std::net::SocketAddr, path: &str) -> std::io::Result<WsClient> {
        let mut sock = TcpStream::connect(addr)?;
        sock.set_read_timeout(Some(Duration::from_secs(5)))?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
        );
        sock.write_all(req.as_bytes())?;
        let mut buf = Vec::new();
        let mut tmp = [0u8; 4096];
        let head_end = loop {
            if let Some(pos) = find(&buf, b"\r\n\r\n") {
                break pos + 4;
            }
            let n = sock.read(&mut tmp)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "handshake closed",
                ));
            }
            buf.extend_from_slice(&tmp[..n]);
        };
        let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
        if !head.starts_with("http/1.1 101") {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("no 101: {head}"),
            ));
        }
        buf.drain(..head_end);
        Ok(WsClient { sock, buf })
    }

    /// Next server frame (text/binary/ping/close) as bytes.
    pub fn next_frame(&mut self) -> std::io::Result<(u8, Vec<u8>)> {
        loop {
            if let Some((opcode, payload, used)) = take_server_frame(&self.buf) {
                self.buf.drain(..used);
                return Ok((opcode, payload));
            }
            let mut tmp = [0u8; 8192];
            let n = self.sock.read(&mut tmp)?;
            if n == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "server closed",
                ));
            }
            self.buf.extend_from_slice(&tmp[..n]);
        }
    }

    pub fn next_text(&mut self) -> std::io::Result<String> {
        let (opcode, payload) = self.next_frame()?;
        if opcode != 0x1 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("opcode {opcode:#x}"),
            ));
        }
        Ok(String::from_utf8_lossy(&payload).to_string())
    }

    pub fn send_text(&mut self, text: &str) -> std::io::Result<()> {
        self.send_frame(0x1, text.as_bytes())
    }

    pub fn send_ping(&mut self, payload: &[u8]) -> std::io::Result<()> {
        self.send_frame(0x9, payload)
    }

    pub fn send_close(&mut self) -> std::io::Result<()> {
        self.send_frame(0x8, &[])
    }

    fn send_frame(&mut self, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
        let mask = [0x11, 0x22, 0x33, 0x44];
        let mut out = vec![0x80 | opcode];
        let n = payload.len();
        if n < 126 {
            out.push(0x80 | n as u8);
        } else if n <= u16::MAX as usize {
            out.push(0x80 | 126);
            out.extend_from_slice(&(n as u16).to_be_bytes());
        } else {
            out.push(0x80 | 127);
            out.extend_from_slice(&(n as u64).to_be_bytes());
        }
        out.extend_from_slice(&mask);
        for (i, b) in payload.iter().enumerate() {
            out.push(b ^ mask[i & 3]);
        }
        self.sock.write_all(&out)
    }
}

fn take_server_frame(buf: &[u8]) -> Option<(u8, Vec<u8>, usize)> {
    if buf.len() < 2 {
        return None;
    }
    let opcode = buf[0] & 0x0f;
    let masked = buf[1] & 0x80 != 0;
    let mut len = (buf[1] & 0x7f) as usize;
    let mut pos = 2;
    if len == 126 {
        if buf.len() < 4 {
            return None;
        }
        len = u16::from_be_bytes([buf[2], buf[3]]) as usize;
        pos = 4;
    } else if len == 127 {
        if buf.len() < 10 {
            return None;
        }
        let mut b = [0u8; 8];
        b.copy_from_slice(&buf[2..10]);
        len = u64::from_be_bytes(b) as usize;
        pos = 10;
    }
    if masked {
        pos += 4;
    }
    if buf.len() < pos + len {
        return None;
    }
    Some((opcode, buf[pos..pos + len].to_vec(), pos + len))
}

/// Tests that read process-wide counters (thread count, fd count) must not
/// overlap: another test's live connections would move the baseline. Cargo
/// runs tests in a file on parallel threads, so these take a process lock.
static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub fn serial_guard() -> std::sync::MutexGuard<'static, ()> {
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

/// Threads currently alive in this process (via /proc).
pub fn thread_count() -> usize {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find(|l| l.starts_with("Threads:"))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Open descriptors of this process (via /proc).
pub fn fd_count() -> usize {
    std::fs::read_dir("/proc/self/fd")
        .map(|it| it.count())
        .unwrap_or(0)
}
