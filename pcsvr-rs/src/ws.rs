//! RFC 6455 WebSocket: handshake accept key, frame codec, session registry
//! and the session loop.
//!
//! The session loop is the leak fix. The Python shim looped forever per
//! connection and swallowed `recv` timeouts, so a client that reconnected
//! without closing its socket kept the old thread (and fd) alive forever:
//! 13,312 threads in 1.5 days, then EMFILE death. Here every session is
//! bounded three ways:
//!
//! 1. read timeout — a client that stops talking is dropped;
//! 2. write timeout — a client that stops reading (full kernel buffer) costs
//!    one failed write instead of blocking in `sendall` forever;
//! 3. an absolute maximum lifetime.
//!
//! Plus a global cap on concurrent sessions: when the cap is reached the
//! oldest session is force-closed (`shutdown()` wakes its thread).

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::base64;
use crate::log;
use crate::sha1;

pub const WS_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP_CONT: u8 = 0x0;
const OP_TEXT: u8 = 0x1;
const OP_BINARY: u8 = 0x2;
const OP_CLOSE: u8 = 0x8;
const OP_PING: u8 = 0x9;
const OP_PONG: u8 = 0xA;

const MAX_FRAME_PAYLOAD: usize = 64 * 1024;
const MAX_PENDING: usize = 256 * 1024;
const MAX_CONTROL: usize = 125;

pub fn accept_key(key: &str) -> String {
    let digest = sha1::sha1(format!("{key}{WS_GUID}").as_bytes());
    base64::encode(&digest)
}

/// The 101 upgrade response. Same header set as the Python shim (it does not
/// send `Server`/`Date`, and the app does not look for them).
pub fn handshake_response(accept: &str) -> String {
    format!(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"
    )
}

/// Encode one server->client frame (never masked, per RFC 6455 5.1).
pub fn frame(opcode: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 10);
    out.push(0x80 | opcode); // FIN + opcode
    let n = payload.len();
    if n < 126 {
        out.push(n as u8);
    } else if n <= u16::MAX as usize {
        out.push(126);
        out.extend_from_slice(&(n as u16).to_be_bytes());
    } else {
        out.push(127);
        out.extend_from_slice(&(n as u64).to_be_bytes());
    }
    out.extend_from_slice(payload);
    out
}

#[derive(Debug)]
pub enum ClientFrame {
    Text(String),
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Pong,
    Close,
}

/// Take one inbound (masked) frame from the buffer. `Ok(None)` = need more
/// bytes; `Err` = protocol violation, the caller must drop the connection.
pub fn take_frame(buf: &mut Vec<u8>) -> Result<Option<ClientFrame>, String> {
    if buf.len() < 2 {
        return Ok(None);
    }
    let fin = buf[0] & 0x80 != 0;
    let opcode = buf[0] & 0x0f;
    let masked = buf[1] & 0x80 != 0;
    let len7 = buf[1] & 0x7f;
    let mut pos = 2usize;
    let len = match len7 {
        0..=125 => len7 as usize,
        126 => {
            if buf.len() < 4 {
                return Ok(None);
            }
            let v = u16::from_be_bytes([buf[2], buf[3]]) as usize;
            pos = 4;
            v
        }
        _ => {
            if buf.len() < 10 {
                return Ok(None);
            }
            let mut b = [0u8; 8];
            b.copy_from_slice(&buf[2..10]);
            let v = u64::from_be_bytes(b);
            pos = 10;
            v as usize
        }
    };
    if len > MAX_FRAME_PAYLOAD {
        return Err("frame too large".into());
    }
    if !masked {
        return Err("client frame must be masked".into());
    }
    if buf.len() < pos + 4 + len {
        return Ok(None);
    }
    let mut mask = [0u8; 4];
    mask.copy_from_slice(&buf[pos..pos + 4]);
    let start = pos + 4;
    let mut payload = Vec::with_capacity(len);
    payload.extend_from_slice(&buf[start..start + len]);
    for (i, p) in payload.iter_mut().enumerate() {
        *p ^= mask[i & 3];
    }
    buf.drain(..start + len);

    let is_control = opcode >= 0x8;
    if is_control && !fin {
        return Err("fragmented control frame".into());
    }
    if is_control && len > MAX_CONTROL {
        return Err("oversized control frame".into());
    }
    let frame = match opcode {
        OP_TEXT => ClientFrame::Text(String::from_utf8_lossy(&payload).into_owned()),
        OP_BINARY | OP_CONT => ClientFrame::Binary(payload),
        OP_PING => ClientFrame::Ping(payload),
        OP_PONG => ClientFrame::Pong,
        OP_CLOSE => ClientFrame::Close,
        other => return Err(format!("unknown opcode {other}")),
    };
    Ok(Some(frame))
}

// ---------------------------------------------------------------------------
// Registry of live sessions (bounded, oldest-first eviction)

struct Session {
    id: u64,
    stream: Arc<TcpStream>,
}

pub struct Registry {
    sessions: Mutex<Vec<Session>>,
    max: usize,
    next_id: AtomicU64,
}

impl Registry {
    pub fn new(max: usize) -> Self {
        Self {
            sessions: Mutex::new(Vec::new()),
            max: max.max(1),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn len(&self) -> usize {
        self.sessions.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Register a session. If the cap is reached, the oldest is force-closed
    /// and `true` is returned so the caller can log it. The evicted session's
    /// own thread notices the shutdown on its next read/write and exits.
    pub fn register(&self, stream: Arc<TcpStream>) -> (u64, bool) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut evicted = false;
        let mut guard = self.sessions.lock().unwrap();
        while guard.len() >= self.max {
            let old = guard.remove(0);
            let _ = old.stream.shutdown(std::net::Shutdown::Both);
            evicted = true;
        }
        guard.push(Session { id, stream });
        (id, evicted)
    }

    pub fn unregister(&self, id: u64) {
        let mut guard = self.sessions.lock().unwrap();
        if let Some(pos) = guard.iter().position(|s| s.id == id) {
            guard.remove(pos);
        }
    }

    /// Force-close every session (shutdown path).
    pub fn close_all(&self) {
        let mut guard = self.sessions.lock().unwrap();
        for s in guard.iter() {
            let _ = s.stream.shutdown(std::net::Shutdown::Both);
        }
        guard.clear();
    }
}

/// Run one WebSocket session on an already-upgraded connection.
///
/// `payload()` builds the JSON text sent every `interval`. The loop exits on
/// client close, protocol error, read timeout, write failure, or after
/// `max_lifetime`; in every case the thread returns and the socket is closed.
pub fn run_session(
    stream: Arc<TcpStream>,
    leftover: Vec<u8>,
    registry: &Registry,
    interval: Duration,
    max_lifetime: Duration,
    read_timeout: Duration,
    payload: impl Fn() -> String,
) {
    let (id, evicted) = registry.register(stream.clone());
    if evicted {
        log::global().log("ws: cap reached, oldest session force-closed");
    }
    let mut buf = leftover;
    let end = Instant::now() + max_lifetime;
    let mut next_send = Instant::now();
    loop {
        if Instant::now() >= end {
            log::global().log("ws: max lifetime reached, closing session");
            break;
        }
        // --- read side: drain what is available, with a short timeout ---
        let _ = stream.set_read_timeout(Some(read_timeout));
        let mut tmp = [0u8; 4096];
        let mut reader = &*stream;
        match reader.read(&mut tmp) {
            Ok(0) => break, // client closed
            Ok(n) => {
                if buf.len() + n > MAX_PENDING {
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
                loop {
                    match take_frame(&mut buf) {
                        Ok(None) => break,
                        Ok(Some(ClientFrame::Close)) => {
                            // RFC 6455 §5.5.1: echo the close frame before
                            // dropping the socket. The short wait is only on
                            // this path and keeps the frame from being lost
                            // by an immediate shutdown (which would surface
                            // at the peer as a reset, not a close).
                            let _ = write_frame(&stream, OP_CLOSE, &[]);
                            let _ = stream.shutdown(std::net::Shutdown::Write);
                            std::thread::sleep(Duration::from_millis(20));
                            finish(&stream, registry, id, "client close");
                            return;
                        }
                        Ok(Some(ClientFrame::Ping(data))) => {
                            if write_frame(&stream, OP_PONG, &data).is_err() {
                                finish(&stream, registry, id, "pong write failed");
                                return;
                            }
                        }
                        Ok(Some(ClientFrame::Pong)) => {}
                        Ok(Some(ClientFrame::Text(_))) | Ok(Some(ClientFrame::Binary(_))) => {
                            // The client does not send application data on this
                            // socket; we drain and ignore it (bounded above).
                        }
                        Err(_) => {
                            finish(&stream, registry, id, "protocol error");
                            return;
                        }
                    }
                }
            }
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
        // --- write side: the periodic connection event ---
        if Instant::now() >= next_send {
            next_send = Instant::now() + interval;
            if write_frame(&stream, OP_TEXT, payload().as_bytes()).is_err() {
                break;
            }
        }
    }
    finish(&stream, registry, id, "session ended");
}

fn finish(stream: &TcpStream, registry: &Registry, id: u64, _why: &str) {
    registry.unregister(id);
    let _ = stream.shutdown(std::net::Shutdown::Both);
}

fn write_frame(stream: &TcpStream, opcode: u8, payload: &[u8]) -> std::io::Result<()> {
    let data = frame(opcode, payload);
    // The socket carries a write timeout (set by Conn::new): a client that
    // stops reading costs one timed-out write, never a stuck thread.
    let mut cursor = 0;
    let mut writer = stream;
    while cursor < data.len() {
        match writer.write(&data[cursor..]) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "write zero",
                ))
            }
            Ok(n) => cursor += n,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

/// Connected loopback socket pair — used by the unit tests below and by the
/// integration tests in `tests/`.
pub fn loopback_pair() -> (TcpStream, TcpStream) {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let a = l.local_addr().unwrap();
    let client = TcpStream::connect(a).unwrap();
    let (server, _) = l.accept().unwrap();
    (server, client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_length_forms() {
        let f = frame(OP_TEXT, b"hi");
        assert_eq!(f, vec![0x81, 2, b'h', b'i']);

        let mid = vec![b'a'; 200];
        let f = frame(OP_TEXT, &mid);
        assert_eq!(f[0], 0x81);
        assert_eq!(f[1], 126);
        assert_eq!(&f[2..4], &200u16.to_be_bytes());
        assert_eq!(f.len(), 4 + 200);

        let big = vec![b'b'; 70_000];
        let f = frame(OP_TEXT, &big);
        assert_eq!(f[1], 127);
        assert_eq!(&f[2..10], &70_000u64.to_be_bytes());
        assert_eq!(f.len(), 10 + 70_000);
    }

    #[test]
    fn decodes_masked_frames() {
        let mask = [0x37, 0xfa, 0x21, 0x3d];
        let text = b"Hello";
        let mut buf = vec![0x81, 0x80 | text.len() as u8];
        buf.extend_from_slice(&mask);
        for (i, c) in text.iter().enumerate() {
            buf.push(c ^ mask[i & 3]);
        }
        let mut b = buf.clone();
        match take_frame(&mut b).unwrap().unwrap() {
            ClientFrame::Text(t) => assert_eq!(t, "Hello"),
            other => panic!("got {other:?}"),
        }
        assert!(b.is_empty());
    }

    #[test]
    fn decodes_126_length_and_waits_for_partial() {
        let mask = [1u8, 2, 3, 4];
        let payload = vec![b'x'; 300];
        let mut buf = vec![0x81, 0x80 | 126];
        buf.extend_from_slice(&300u16.to_be_bytes());
        buf.extend_from_slice(&mask);
        for (i, c) in payload.iter().enumerate() {
            buf.push(c ^ mask[i & 3]);
        }
        let mut part = buf[..20].to_vec();
        assert!(take_frame(&mut part).unwrap().is_none());
        let mut full = buf;
        match take_frame(&mut full).unwrap().unwrap() {
            ClientFrame::Text(t) => assert_eq!(t.len(), 300),
            other => panic!("got {other:?}"),
        }
        assert!(full.is_empty());
    }

    #[test]
    fn close_and_ping_frames() {
        let mut buf = vec![0x88, 0x80, 0, 0, 0, 0];
        assert!(matches!(
            take_frame(&mut buf).unwrap().unwrap(),
            ClientFrame::Close
        ));

        let mut buf = vec![0x89, 0x80 | 2, 0, 0, 0, 0, 7, 8];
        match take_frame(&mut buf).unwrap().unwrap() {
            ClientFrame::Ping(d) => assert_eq!(d, vec![7, 8]),
            other => panic!("got {other:?}"),
        }
    }

    #[test]
    fn rejects_unmasked_and_oversized() {
        let mut buf = vec![0x81, 0x02, b'h', b'i'];
        assert!(take_frame(&mut buf).is_err());

        let mut buf = vec![0x81, 127];
        buf.extend_from_slice(&1_000_000u64.to_be_bytes());
        assert!(take_frame(&mut buf).is_err());
    }

    #[test]
    fn registry_evicts_oldest() {
        let reg = Registry::new(2);
        let mk = || Arc::new(loopback_pair().0);
        let (id_a, ev) = reg.register(mk());
        assert!(!ev);
        let (id_b, _) = reg.register(mk());
        let (id_c, ev) = reg.register(mk());
        assert!(ev, "third registration should evict");
        assert_eq!(reg.len(), 2);
        reg.unregister(id_a);
        reg.unregister(id_b);
        reg.unregister(id_c);
        assert_eq!(reg.len(), 0);
    }

    #[test]
    fn session_thread_exits_on_client_close() {
        let (server, client) = loopback_pair();
        let reg = Arc::new(Registry::new(4));
        let reg2 = reg.clone();
        let stream = Arc::new(server);
        let s2 = stream.clone();
        let handle = std::thread::spawn(move || {
            run_session(
                s2,
                Vec::new(),
                &reg2,
                Duration::from_millis(20),
                Duration::from_secs(30),
                Duration::from_millis(50),
                || "{\"event\":\"connection\"}".into(),
            )
        });
        drop(client);
        handle.join().unwrap();
        assert_eq!(reg.len(), 0);
    }
}
