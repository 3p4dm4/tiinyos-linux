//! The leak tests — the reason this rewrite exists.
//!
//! The Python shim spawned a `ThreadingHTTPServer` thread per connection and
//! a websocket session that only ended when the *client* hung up; every
//! reconnect in the vendor app left another thread and another socket behind,
//! until the process crawled. These tests open hundreds of connections and
//! assert the process returns to its baseline afterwards.
//!
//! This file holds only these tests on purpose: each integration test file is
//! its own process, so `/proc/self/status` thread counts and `/proc/self/fd`
//! are not polluted by unrelated suites.

mod common;

use common::*;
use std::io::Write;
use std::net::TcpStream;
use std::time::{Duration, Instant};

fn settle() {
    // let the OS and the runtime finish tearing down sockets and threads
    std::thread::sleep(Duration::from_millis(300));
}

/// Wait until a condition holds, up to `secs`.
fn wait_for(secs: u64, cond: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while Instant::now() < deadline {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    cond()
}

#[test]
fn five_hundred_websockets_leave_no_threads_or_fds() {
    let _serial = serial_guard();
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let mut cfg = config_for(dev.port);
    cfg.max_websockets = 16;
    cfg.max_connections = 512;
    cfg.ws_interval_ms = 50;
    cfg.ws_read_timeout_ms = 50;
    let cap = cfg.max_websockets;
    let srv = spawn_server(cfg);
    settle();

    let base_threads = thread_count();
    let base_fds = fd_count();
    assert!(base_threads > 0, "cannot read thread count");
    let (mut peak_threads, mut peak_fds) = (base_threads, base_fds);

    for i in 0..500 {
        let mut ws = WsClient::connect(srv.addr, "/devices_list/ws")
            .unwrap_or_else(|e| panic!("connect {i}: {e}"));
        // read one frame, then hang up the way the app does (close frame or
        // plain drop, alternating: both must be reclaimed)
        let _ = ws.next_text().unwrap_or_else(|e| panic!("frame {i}: {e}"));
        if i % 2 == 0 {
            let _ = ws.send_close();
            let _ = ws.next_frame();
        }
        drop(ws);
        // the registry is capped, so live sessions never exceed the limit
        assert!(
            srv.ws_sessions() <= cap,
            "websocket cap exceeded: {}",
            srv.ws_sessions()
        );
        peak_threads = peak_threads.max(thread_count());
        peak_fds = peak_fds.max(fd_count());
    }

    let ok = wait_for(20, || {
        srv.ws_sessions() == 0 && thread_count() <= base_threads + 1 && fd_count() <= base_fds + 2
    });
    let (t, f, sessions) = (thread_count(), fd_count(), srv.ws_sessions());
    eprintln!(
        "[leak:websockets] threads base={base_threads} peak={peak_threads} after={t} | fds base={base_fds} peak={peak_fds} after={f} | live_sessions={sessions}"
    );
    srv.stop();
    assert!(
        ok,
        "leaked after 500 websockets: threads {base_threads} -> {t}, fds {base_fds} -> {f}, sessions {sessions}"
    );
}

#[test]
fn five_hundred_http_connections_leave_no_threads_or_fds() {
    let _serial = serial_guard();
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let mut cfg = config_for(dev.port);
    cfg.max_connections = 512;
    let srv = spawn_server(cfg);
    settle();
    let base_threads = thread_count();
    let base_fds = fd_count();
    let (mut peak_threads, mut peak_fds) = (base_threads, base_fds);

    for i in 0..500 {
        match i % 3 {
            // keep-alive with two requests, then a clean close
            0 => {
                let mut s = TcpStream::connect(srv.addr).unwrap();
                s.write_all(b"GET /status HTTP/1.1\r\nHost: x\r\n\r\nGET /devices HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n").unwrap();
                let _ = common::read_response(&mut s);
                drop(s);
            }
            // abrupt close without reading the reply at all
            1 => {
                let mut s = TcpStream::connect(srv.addr).unwrap();
                let _ = s.write(b"GET /devices HTTP/1.1\r\nHost: x\r\n\r\n");
                drop(s);
            }
            // ordinary one-shot request
            _ => {
                let _ = http_get(srv.addr, "/status").unwrap();
            }
        }
        peak_threads = peak_threads.max(thread_count());
        peak_fds = peak_fds.max(fd_count());
    }

    let ok = wait_for(20, || {
        thread_count() <= base_threads + 1 && fd_count() <= base_fds + 2
    });
    let (t, f) = (thread_count(), fd_count());
    eprintln!(
        "[leak:http] threads base={base_threads} peak={peak_threads} after={t} | fds base={base_fds} peak={peak_fds} after={f}"
    );
    let alive = http_get(srv.addr, "/status").map(|r| r.status).unwrap_or(0);
    srv.stop();
    assert!(
        ok,
        "leaked after 500 http connections: threads {base_threads} -> {t}, fds {base_fds} -> {f}"
    );
    assert_eq!(alive, 200, "service stopped answering");
}

#[test]
fn stalled_clients_are_reclaimed_by_their_own_limits() {
    let _serial = serial_guard();
    // Clients that connect, never read and never close: the connection thread
    // must not live forever. Here the write path is what would block, so we
    // check the process is still healthy and reclaiming after many such
    // sockets are abandoned mid-session.
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let mut cfg = config_for(dev.port);
    cfg.max_websockets = 8;
    cfg.max_connections = 64;
    cfg.ws_interval_ms = 20;
    cfg.ws_read_timeout_ms = 30;
    let srv = spawn_server(cfg);
    settle();
    let base_threads = thread_count();

    // 40 sockets opened and abandoned without ever reading a byte; the cap
    // (8) forces eviction, and the abandoned ones die on their own limits
    let mut kept = Vec::new();
    for _ in 0..40 {
        if let Ok(ws) = WsClient::connect(srv.addr, "/devices_list/ws") {
            kept.push(ws);
        }
    }
    assert!(
        srv.ws_sessions() <= 8,
        "cap not held: {}",
        srv.ws_sessions()
    );
    drop(kept);

    let ok = wait_for(20, || {
        thread_count() <= base_threads + 1 && srv.ws_sessions() == 0
    });
    let t = thread_count();
    srv.stop();
    assert!(
        ok,
        "abandoned sessions did not drain: threads {base_threads} -> {t}"
    );
}

#[test]
fn connection_cap_fails_fast_and_the_service_recovers() {
    let _serial = serial_guard();
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let mut cfg = config_for(dev.port);
    cfg.max_connections = 6;
    let srv = spawn_server(cfg);
    settle();

    // occupy the service with 6 open connections
    let mut held = Vec::new();
    for _ in 0..6 {
        let s = TcpStream::connect(srv.addr).unwrap();
        held.push(s);
    }
    std::thread::sleep(Duration::from_millis(100));
    // the 7th is accepted and closed immediately (fast failure, no hang)
    let started = Instant::now();
    let mut extra = TcpStream::connect(srv.addr).unwrap();
    extra
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let _ = extra.write(b"GET /status HTTP/1.1\r\nHost: x\r\n\r\n");
    let mut buf = [0u8; 16];
    let n = std::io::Read::read(&mut extra, &mut buf).unwrap_or(0);
    let elapsed = started.elapsed();
    assert_eq!(n, 0, "over-cap connection got a response: {n} bytes");
    assert!(elapsed < Duration::from_secs(5), "over-cap connection hung");

    // release: the service answers again
    drop(held);
    drop(extra);
    let ok = wait_for(10, || {
        http_get(srv.addr, "/status").map(|r| r.status).unwrap_or(0) == 200
    });
    srv.stop();
    assert!(ok, "service did not recover after the cap was released");
}
