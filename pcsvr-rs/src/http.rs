//! Minimal HTTP/1.1 server support: buffered request parsing and response
//! writing over a `TcpStream`.
//!
//! Only what the TiinyOS client uses of HTTP is implemented: request-line +
//! headers + Content-Length body, one request at a time, keep-alive handled
//! by the connection loop in `server.rs`. Response framing mirrors the
//! CPython `BaseHTTPRequestHandler` output the app already sees (status
//! line, `Server` and `Date` headers, then the body headers).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::{SystemTime, UNIX_EPOCH};

pub const MAX_HEADERS: usize = 32 * 1024;
pub const MAX_BODY: usize = 1024 * 1024;
pub const MAX_PATH: usize = 2048;

const WD: [&str; 7] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MON: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Request {
    pub method: String,
    pub path: String, // without query string
    pub query: String,
    pub version: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Request {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    /// Parsed JSON body, `Ok(None)` when there was no body.
    pub fn as_json_object(&self) -> Result<Option<crate::json::Value>, String> {
        if self.body.is_empty() {
            return Ok(None);
        }
        match std::str::from_utf8(&self.body) {
            Ok(text) => crate::json::parse(text)
                .map(Some)
                .map_err(|e| format!("bad json: {e}")),
            Err(_) => Ok(None),
        }
    }
}

/// Incremental reader: keeps the bytes after the current message so the
/// same connection can carry the next request (keep-alive).
pub struct Conn {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl Conn {
    pub fn new(
        stream: TcpStream,
        read_timeout_ms: u64,
        write_timeout_ms: u64,
    ) -> std::io::Result<Self> {
        stream
            .set_read_timeout(Some(std::time::Duration::from_millis(read_timeout_ms)))
            .map_err(|e| std::io::Error::new(e.kind(), "set_read_timeout"))?;
        stream
            .set_write_timeout(Some(std::time::Duration::from_millis(write_timeout_ms)))
            .map_err(|e| std::io::Error::new(e.kind(), "set_write_timeout"))?;
        Ok(Self {
            stream,
            buf: Vec::with_capacity(4096),
        })
    }

    pub fn into_stream(self) -> TcpStream {
        self.stream
    }

    /// Read until the CRLF-CRLF header terminator. On timeout (no complete
    /// message yet) returns `Ok(None)`.
    pub fn read_headers(&mut self) -> std::io::Result<Option<Vec<u8>>> {
        loop {
            if let Some(pos) = self.find_pos(b"\r\n\r\n") {
                let end = pos + 4;
                return Ok(Some(self.take(end)));
            }
            if self.buf.len() > MAX_HEADERS {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "header block too large",
                ));
            }
            match self.read_blocking_or_timeout(8192)? {
                Some(0) => {
                    // closed while waiting for a complete header block
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "connection closed mid-headers",
                    ));
                }
                Some(_) => {}
                None => return Ok(None),
            }
        }
    }

    fn find_pos(&self, needle: &[u8]) -> Option<usize> {
        if self.buf.len() < needle.len() {
            return None;
        }
        self.buf.windows(needle.len()).position(|w| w == needle)
    }

    fn take(&mut self, end: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(end);
        out.extend_from_slice(&self.buf[..end]);
        self.buf.drain(..end);
        out
    }

    pub fn take_body(&mut self, len: usize) -> std::io::Result<Vec<u8>> {
        self.fill(len)?;
        Ok(self.take(len))
    }

    /// Read until at least `min` bytes are buffered, without consuming them.
    /// Times out (never blocks forever) and refuses oversized bodies.
    pub fn fill(&mut self, min: usize) -> std::io::Result<()> {
        if min > MAX_BODY {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "body too large",
            ));
        }
        while self.buf.len() < min {
            match self.read_blocking_or_timeout(8192)? {
                Some(0) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "connection closed mid-body",
                    ));
                }
                Some(_) => {}
                None => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "body read timeout",
                    ));
                }
            }
        }
        Ok(())
    }

    /// Read one chunk: `Ok(None)` = timeout, `Ok(Some(0))` = clean EOF,
    /// `Ok(Some(n))` = n bytes appended to the internal buffer.
    fn read_blocking_or_timeout(&mut self, n: usize) -> std::io::Result<Option<usize>> {
        let mut tmp = vec![0u8; n];
        match self.stream.read(&mut tmp) {
            Ok(0) => Ok(Some(0)),
            Ok(k) => {
                self.buf.extend_from_slice(&tmp[..k]);
                Ok(Some(k))
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.stream.write_all(data)
    }

    /// Peek the next bytes without consuming them.
    pub fn peek(&self) -> &[u8] {
        &self.buf
    }

    /// Consume and return the first `n` buffered bytes.
    pub fn take_prefix(&mut self, n: usize) -> Vec<u8> {
        let n = n.min(self.buf.len());
        let mut out = Vec::with_capacity(n);
        out.extend_from_slice(&self.buf[..n]);
        self.buf.drain(..n);
        out
    }

    pub fn drain(&mut self) {
        self.buf.clear();
    }
}

pub fn parse_request(raw: &[u8]) -> Result<Request, String> {
    let head = std::str::from_utf8(raw).map_err(|_| "non-utf8 headers".to_string())?;
    let mut lines = head.trim_end_matches("\r\n").split("\r\n");
    let request_line = lines.next().ok_or("empty request")?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().ok_or("no method")?.to_string();
    let target = parts.next().ok_or("no target")?.to_string();
    let version = parts.next().unwrap_or("HTTP/1.1").to_string();
    if method.is_empty() || target.is_empty() || target.len() > MAX_PATH {
        return Err("bad request line".into());
    }
    let (path, query) = match target.split_once('?') {
        Some((p, q)) => (p.to_string(), q.to_string()),
        None => (target, String::new()),
    };
    let mut headers = Vec::new();
    for line in lines {
        if line.is_empty() {
            continue;
        }
        match line.split_once(':') {
            Some((k, v)) => headers.push((k.trim().to_string(), v.trim().to_string())),
            None => return Err("bad header line".into()),
        }
    }
    Ok(Request {
        method,
        path,
        query,
        version,
        headers,
        body: Vec::new(),
    })
}
/// Parse the request header block and read its Content-Length body from the
/// connection, leaving the next request (if any) in the buffer for
/// keep-alive.
pub fn read_request(conn: &mut Conn) -> std::io::Result<Option<Request>> {
    let raw = match conn.read_headers()? {
        Some(r) => r,
        None => return Ok(None),
    };
    let mut req =
        parse_request(&raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let content_length = req
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse::<usize>().ok())
        .unwrap_or(0);
    if content_length > MAX_BODY {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "body too large",
        ));
    }
    // bytes already buffered after the header terminator count towards the
    // body; the rest is pulled from the socket (it may arrive in pieces)
    let need = content_length.saturating_sub(conn.peek().len());
    if need > 0 {
        conn.fill(need)?;
    }
    req.body = conn.take_prefix(content_length);
    Ok(Some(req))
}

/// RFC 1123 date, as CPython's `email.utils.formatdate` emits it.
pub fn rfc1123_date() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs / 86400;
    let rem = (secs % 86400) as u64;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let (y, mo, d) = crate::log::civil_from_days(days);
    // 1970-01-01 was a Thursday (index 3)
    let wd = ((days.rem_euclid(7)) + 3) % 7;
    let wd_name = WD[wd as usize];
    let mon = MON[mo as usize - 1];
    format!("{wd_name}, {d:02} {mon} {y} {h:02}:{:02}:{:02} GMT", m, s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_get_with_headers() {
        let raw =
            b"GET /devices_list/ws HTTP/1.1\r\nHost: localhost:60000\r\nUpgrade: websocket\r\n\r\n";
        let r = parse_request(raw).unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.path, "/devices_list/ws");
        assert_eq!(r.query, "");
        assert_eq!(r.header("upgrade"), Some("websocket"));
        assert_eq!(r.header("UPGRADE"), Some("websocket"));
    }

    #[test]
    fn splits_query() {
        let raw = b"GET /api/v1/devices?x=1&y=2 HTTP/1.1\r\n\r\n";
        let r = parse_request(raw).unwrap();
        assert_eq!(r.path, "/api/v1/devices");
        assert_eq!(r.query, "x=1&y=2");
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse_request(b"GET \r\n\r\n").is_err());
        assert!(parse_request(b"NOPE\r\n\r\n").is_err());
        assert!(parse_request(b"GET /a b c HTTP/1.1\r\nbad header\r\n\r\n").is_err());
    }

    #[test]
    fn date_shape_matches_python() {
        let d = rfc1123_date();
        // "Thu, 19 Nov 2026 00:14:48 GMT"
        let parts: Vec<&str> = d.split_whitespace().collect();
        assert_eq!(parts.len(), 6, "bad date: {d}");
        assert!(parts[0].ends_with(','), "bad weekday: {d}");
        assert!(parts[1].parse::<u32>().is_ok(), "bad day: {d}");
        assert!(MON.contains(&parts[2]), "bad month: {d}");
        assert!(parts[3].parse::<i64>().is_ok(), "bad year: {d}");
        assert_eq!(parts[4].matches(':').count(), 2, "bad time: {d}");
        assert_eq!(parts[5], "GMT");
    }

    #[test]
    fn weekday_is_consistent() {
        // 2024-01-01 was a Monday: days-since-epoch arithmetic must agree
        let days: i64 = 19_723;
        let wd = ((days.rem_euclid(7)) + 3) % 7;
        assert_eq!(WD[wd as usize], "Mon");
    }
}
