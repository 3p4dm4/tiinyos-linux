//! The server: accept loop, bounded per-connection threads, routing.
//!
//! Thread model (the leak fix, part 2):
//!
//! * one accept thread (non-blocking listener + shutdown flag);
//! * one probe thread (see `device::probe_loop`);
//! * one thread per *live* connection, capped by `max_connections` (excess
//!   connections are accepted and closed immediately, so the client gets a
//!   fast failure instead of a hang);
//! * a websocket never spawns a second thread — the connection thread that
//!   served the upgrade becomes the session thread — and live sessions are
//!   additionally capped by `config.max_websockets` with oldest-first
//!   eviction.
//!
//! Every connection thread exits on: client close, read/idle timeout, write
//! error, protocol error, per-connection request/lifetime cap, or server
//! shutdown.

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::config::Config;
use crate::device::Device;
use crate::http::{self, Conn, Request};
use crate::json::{self, Value};
use crate::log;
use crate::ws;

/// Idle/read timeout for plain HTTP connections (keep-alive).
pub const HTTP_IDLE_MS: u64 = 15_000;
/// Write timeout for any response: a client that stops reading must not park
/// a thread inside `write`.
pub const WRITE_TIMEOUT_MS: u64 = 5_000;
const MAX_REQUESTS_PER_CONN: usize = 1000;
const MAX_CONN_LIFETIME: Duration = Duration::from_secs(600);
/// Absolute cap on a websocket session's life: a client that keeps the
/// socket open but never reads can therefore never hold a thread forever.
const WS_MAX_LIFETIME: Duration = Duration::from_secs(3600);

pub struct Server {
    pub addr: SocketAddr,
    pub device: Arc<Device>,
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
    probe: Option<JoinHandle<()>>,
    registry: Arc<ws::Registry>,
    pub conns: Arc<AtomicUsize>,
}

/// Bind, probe once (so early traffic sees the truth) and start serving.
pub fn start(cfg: Config) -> std::io::Result<Server> {
    let listener = TcpListener::bind((cfg.host.as_str(), cfg.port))?;
    let addr = listener.local_addr()?;
    start_on(listener, addr, cfg)
}

/// Start on an already-bound listener (tests bind port 0 themselves).
pub fn start_on(listener: TcpListener, addr: SocketAddr, cfg: Config) -> std::io::Result<Server> {
    let _ = listener.set_nonblocking(true);
    let device = Arc::new(Device::new(cfg.clone()));
    device.probe();
    let registry = Arc::new(ws::Registry::new(cfg.max_websockets));
    let stop = Arc::new(AtomicBool::new(false));
    let conns = Arc::new(AtomicUsize::new(0));

    let probe = {
        let (device, stop) = (device.clone(), stop.clone());
        std::thread::spawn(move || crate::device::probe_loop(device, stop))
    };

    let accept = {
        let (cfg, device, registry, stop, conns) = (
            cfg.clone(),
            device.clone(),
            registry.clone(),
            stop.clone(),
            conns.clone(),
        );
        std::thread::spawn(move || accept_loop(listener, cfg, device, registry, stop, conns))
    };

    Ok(Server {
        addr,
        device,
        stop,
        accept: Some(accept),
        probe: Some(probe),
        registry,
        conns,
    })
}

impl Server {
    /// Signal shutdown and wait for the accept and probe threads. Live
    /// connection threads finish on their own (their sockets are closed
    /// here, so they wake immediately).
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.accept.take() {
            let _ = h.join();
        }
        if let Some(h) = self.probe.take() {
            let _ = h.join();
        }
        self.registry.close_all();
    }

    pub fn ws_sessions(&self) -> usize {
        self.registry.len()
    }
}

fn accept_loop(
    listener: TcpListener,
    cfg: Config,
    device: Arc<Device>,
    registry: Arc<ws::Registry>,
    stop: Arc<AtomicBool>,
    conns: Arc<AtomicUsize>,
) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, peer)) => {
                let live = conns.fetch_add(1, Ordering::SeqCst);
                if live >= cfg.max_connections {
                    conns.fetch_sub(1, Ordering::SeqCst);
                    log::global().log(&format!(
                        "connection cap reached ({}/{}), closing new connection from {}",
                        live, cfg.max_connections, peer
                    ));
                    drop(stream);
                    continue;
                }
                let cfg_t = cfg.clone();
                let device_t = device.clone();
                let registry_t = registry.clone();
                let conns_t = conns.clone();
                // try_clone so the accept loop still owns a handle if thread
                // creation fails (resource pressure) and can close it
                let owned = match stream.try_clone() {
                    Ok(s) => s,
                    Err(_) => {
                        conns.fetch_sub(1, Ordering::SeqCst);
                        drop(stream);
                        continue;
                    }
                };
                let spawned = std::thread::Builder::new()
                    .stack_size(256 * 1024)
                    .spawn(move || {
                        handle_connection(owned, &cfg_t, &device_t, &registry_t);
                        conns_t.fetch_sub(1, Ordering::SeqCst);
                    });
                if spawned.is_err() {
                    // do not leak the socket, and do not retry in a loop
                    conns.fetch_sub(1, Ordering::SeqCst);
                    log::global().log("cannot spawn connection thread");
                    drop(stream);
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

fn handle_connection(stream: TcpStream, cfg: &Config, device: &Device, registry: &ws::Registry) {
    let mut conn = match Conn::new(stream, HTTP_IDLE_MS, WRITE_TIMEOUT_MS) {
        Ok(c) => c,
        Err(_) => return,
    };
    let started = Instant::now();
    for _ in 0..MAX_REQUESTS_PER_CONN {
        if started.elapsed() > MAX_CONN_LIFETIME {
            break;
        }
        let req = match http::read_request(&mut conn) {
            Ok(Some(r)) => r,
            Ok(None) => break, // idle timeout: the client is gone or idle
            Err(_) => break,   // malformed request or closed connection
        };
        let wants_ws = is_ws_upgrade(&req);
        log_request(&req);
        if wants_ws {
            let (accept, err) = ws_handshake(&req);
            if let Some(accept) = accept {
                let response = ws::handshake_response(&accept);
                if conn.write_all(response.as_bytes()).is_err() {
                    return;
                }
                let leftover = conn.peek().to_vec();
                let stream = Arc::new(conn.into_stream());
                ws::run_session(
                    stream,
                    leftover,
                    registry,
                    Duration::from_millis(cfg.ws_interval_ms.max(10)),
                    WS_MAX_LIFETIME,
                    Duration::from_millis(cfg.ws_read_timeout_ms.max(10)),
                    || device.connection_payload(),
                );
                return;
            }
            let body = err.unwrap_or_default();
            let _ = conn.write_all(&response(400, "Bad Request", body));
            return;
        }
        let resp = route(&req, device);
        if conn.write_all(&resp).is_err() {
            return;
        }
        if must_close(&req) {
            break;
        }
    }
}

fn is_ws_upgrade(req: &Request) -> bool {
    req.method == "GET" && req.path == "/devices_list/ws"
}

fn ws_handshake(req: &Request) -> (Option<String>, Option<String>) {
    let key = req.header("sec-websocket-key");
    let upgrade_ok = req
        .header("upgrade")
        .map(|u| u.to_ascii_lowercase().contains("websocket"))
        .unwrap_or(false);
    match (key, upgrade_ok) {
        (Some(k), true) => (Some(ws::accept_key(k)), None),
        _ => (
            None,
            Some(json::to_json(&json::obj(vec![
                ("ok", json::b(false)),
                ("error", json::s("expected websocket upgrade")),
            ]))),
        ),
    }
}

fn must_close(req: &Request) -> bool {
    match req.header("connection") {
        Some(c) if c.eq_ignore_ascii_case("close") => true,
        Some(_) => false,
        None => req.version == "HTTP/1.0",
    }
}

fn log_request(req: &Request) {
    let body: String = String::from_utf8_lossy(&req.body)
        .chars()
        .take(200)
        .collect();
    let line = if req.method == "POST" {
        format!("POST {} body={}", req.path, body)
    } else {
        format!("{} {}", req.method, req.path)
    };
    log::global().log(&line);
}

fn route(req: &Request, device: &Device) -> Vec<u8> {
    let path = req.path.as_str();
    match (req.method.as_str(), path) {
        ("GET", "/devices") | ("GET", "/api/v1/devices") => {
            json_response(200, device.devices_payload(false))
        }
        ("GET", "/status") => json_response(200, device.status_payload()),
        ("POST", "/select_device") => select_device(req, device),
        ("POST", "/devices") | ("POST", "/api/v1/devices") => {
            json_response(200, device.devices_payload(true))
        }
        ("GET", "/devices_list/ws") => {
            // reached only when the upgrade headers were wrong
            json_response(
                400,
                json::to_json(&json::obj(vec![
                    ("ok", json::b(false)),
                    ("error", json::s("expected websocket upgrade")),
                ])),
            )
        }
        _ => {
            log::global().log(&format!("  -> 404 (not implemented) {}", req.path));
            json_response(
                404,
                json::to_json(&json::obj(vec![
                    ("ok", json::b(false)),
                    ("error", json::s("not implemented")),
                    ("path", json::s(path)),
                ])),
            )
        }
    }
}

fn select_device(req: &Request, device: &Device) -> Vec<u8> {
    let parsed = match req.as_json_object() {
        Ok(v) => v,
        Err(e) => {
            log::global().log(&format!("select_device: {e}"));
            None
        }
    };
    let state = device.state();
    let wanted = parsed
        .as_ref()
        .and_then(|v: &Value| v.get_str("device_id"))
        .unwrap_or("");
    let accepted =
        !wanted.is_empty() && (wanted == state.identity.device_id || wanted == state.identity.uuid);
    device.set_selected(accepted);
    json_response(200, device.select_payload())
}

fn json_response(code: u16, body: String) -> Vec<u8> {
    response(code, reason(code), body)
}

fn response(code: u16, reason: &str, body: String) -> Vec<u8> {
    // Header set and order mirror CPython's BaseHTTPRequestHandler, so the
    // bytes on the wire stay close to what the app already accepts.
    let head = format!(
        "HTTP/1.1 {code} {reason}\r\nServer: pcsvr-rs/{}\r\nDate: {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        crate::VERSION,
        http::rfc1123_date(),
        body.len()
    );
    let mut out = Vec::with_capacity(head.len() + body.len());
    out.extend_from_slice(head.as_bytes());
    out.extend_from_slice(body.as_bytes());
    out
}

fn reason(code: u16) -> &'static str {
    match code {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        500 => "Internal Server Error",
        _ => "OK",
    }
}
