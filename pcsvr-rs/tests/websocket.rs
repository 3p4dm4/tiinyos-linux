//! WebSocket contract tests for `/devices_list/ws`.
//!
//! The vendor client opens this socket and expects: a 101 handshake with the
//! RFC 6455 `Sec-WebSocket-Accept`, an immediate `{"event":"connection"}`
//! text frame, that frame repeated on an interval, pong replies to pings and
//! a clean close. It also expects the *rest* of the service to keep answering
//! while the socket stays open — the Python shim's biggest weakness.

mod common;

use common::*;
use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

fn started() -> (FakeDevice, pcsvr_rs::server::Server) {
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let srv = spawn_server(config_for(dev.port));
    (dev, srv)
}

#[test]
fn handshake_and_connection_frame() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    let text = ws.next_text().unwrap();
    let v = pcsvr_rs::json::parse(&text).unwrap();
    assert_eq!(v.get("event").unwrap().as_str(), Some("connection"));
    let data = v.get("data").unwrap();
    assert_eq!(data.get("devices").unwrap().as_array().unwrap().len(), 1);
    assert_eq!(
        data.get("local_devices").unwrap().as_array().unwrap().len(),
        1
    );
    assert!(data.get("selected_device").unwrap().is_null());
    let snap = &data.get("devices").unwrap().as_array().unwrap()[0];
    assert_eq!(snap.get("device_id").unwrap().as_str(), Some(TEST_SN));
}

#[test]
fn handshake_uses_the_rfc6455_accept_value() {
    let (_dev, srv) = started();
    // The sample key from RFC 6455 §1.3 must produce the sample accept.
    let mut s = TcpStream::connect(srv.addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(
        b"GET /devices_list/ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n",
    )
    .unwrap();
    let mut buf = Vec::new();
    let mut tmp = [0u8; 1024];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = std::io::Read::read(&mut s, &mut tmp).unwrap();
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    let head = String::from_utf8_lossy(&buf).to_string();
    assert!(head.starts_with("HTTP/1.1 101"), "got {head}");
    let accept = head
        .lines()
        .find(|l| l.to_ascii_lowercase().starts_with("sec-websocket-accept:"))
        .map(|l| l.split_once(':').unwrap().1.trim().to_string())
        .unwrap_or_default();
    assert_eq!(accept, "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    assert!(head.to_ascii_lowercase().contains("upgrade: websocket"));
    assert!(head.to_ascii_lowercase().contains("connection: upgrade"));
}

#[test]
fn connection_frame_is_repeated_on_the_interval() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    // config_for() sets ws_interval_ms = 50, so three frames are < 200 ms
    for _ in 0..3 {
        let t = ws.next_text().unwrap();
        assert!(t.contains("\"connection\""));
    }
}

#[test]
fn ping_gets_a_pong_with_the_same_payload() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    ws.next_text().unwrap(); // drain the first event frame
    ws.send_ping(b"probe").unwrap();
    // read until a pong shows up (event frames interleave, that is fine)
    for _ in 0..40 {
        let (opcode, payload) = ws.next_frame().unwrap();
        if opcode == 0xa {
            assert_eq!(payload, b"probe".to_vec());
            return;
        }
    }
    panic!("no pong received");
}

#[test]
fn ping_split_across_two_writes_is_reassembled() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    ws.next_text().unwrap();
    // build a masked ping by hand and split it mid-payload
    let mask = [9u8, 8, 7, 6];
    let payload = b"split";
    let mut frame = vec![0x89, 0x80 | payload.len() as u8];
    frame.extend_from_slice(&mask);
    for (i, b) in payload.iter().enumerate() {
        frame.push(b ^ mask[i & 3]);
    }
    let (head, tail) = frame.split_at(5);
    ws.sock.write_all(head).unwrap();
    std::io::Write::flush(&mut ws.sock).unwrap();
    std::thread::sleep(Duration::from_millis(80));
    ws.sock.write_all(tail).unwrap();
    std::io::Write::flush(&mut ws.sock).unwrap();
    for _ in 0..40 {
        let (opcode, payload) = ws.next_frame().unwrap();
        if opcode == 0xa {
            assert_eq!(payload, b"split".to_vec());
            return;
        }
    }
    panic!("no pong for the split ping");
}

#[test]
fn http_keeps_answering_while_a_websocket_is_open() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    ws.next_text().unwrap();
    // the Python shim served WS and HTTP from different threads but leaked a
    // thread per socket; here we assert the HTTP path stays responsive while
    // a session is live
    for _ in 0..5 {
        let r = http_get(srv.addr, "/status").unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(srv.ws_sessions(), 1);
        std::thread::sleep(Duration::from_millis(20));
    }
    // and the socket is still streaming
    assert!(ws.next_text().unwrap().contains("connection"));
}

#[test]
fn client_close_terminates_the_session() {
    let _serial = serial_guard();
    let (_dev, srv) = started();
    let base = thread_count();
    for _ in 0..5 {
        let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
        let _ = ws.next_text();
        drop(ws); // FIN-less close: the server must notice the EOF
    }
    // wait for the session threads to notice (read timeout is 50 ms here)
    for _ in 0..100 {
        if srv.ws_sessions() == 0 && thread_count() <= base + 2 {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    panic!(
        "sessions/threads did not drain: sessions={} threads {base} -> {}",
        srv.ws_sessions(),
        thread_count()
    );
}

#[test]
fn explicit_close_frame_is_answered_and_session_ends() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    ws.next_text().unwrap();
    ws.send_close().unwrap();
    // the server echoes a close frame (opcode 8) and stops
    for _ in 0..40 {
        let (opcode, _) = ws.next_frame().unwrap();
        if opcode == 0x8 {
            for _ in 0..100 {
                if srv.ws_sessions() == 0 {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            panic!("session still registered after close");
        }
    }
    panic!("no close frame from server");
}

#[test]
fn websocket_cap_evicts_the_oldest() {
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let mut cfg = config_for(dev.port);
    cfg.max_websockets = 3;
    let srv = spawn_server(cfg);

    let mut clients = Vec::new();
    for _ in 0..3 {
        let mut c = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
        // one frame each proves the session is scheduled and streaming
        assert!(c.next_text().unwrap().contains("connection"));
        clients.push(c);
    }
    assert_eq!(srv.ws_sessions(), 3);

    let mut fourth = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    // the newcomer is admitted and the oldest is dropped (oldest-first)
    assert!(fourth.next_text().unwrap().contains("connection"));
    assert_eq!(srv.ws_sessions(), 3, "cap not held at 3");

    // clients[0] was the oldest: its socket must be closed by the server
    clients[0]
        .sock
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut evicted = false;
    for _ in 0..200 {
        match clients[0].next_frame() {
            Err(_) => {
                evicted = true;
                break;
            }
            Ok((0x8, _)) => {
                evicted = true;
                break;
            }
            Ok(_) => {}
        }
    }
    assert!(evicted, "oldest websocket was not closed");
    // the two younger ones are untouched
    assert!(clients[1].next_text().unwrap().contains("connection"));
    assert!(clients[2].next_text().unwrap().contains("connection"));
}

#[test]
fn ws_path_without_upgrade_headers_is_a_400() {
    let (_dev, srv) = started();
    let r = http_get(srv.addr, "/devices_list/ws").unwrap();
    assert_eq!(r.status, 400);
    let v = pcsvr_rs::json::parse(&r.text()).unwrap();
    assert_eq!(v.get("ok").unwrap().as_bool(), Some(false));
    assert_eq!(
        v.get("error").unwrap().as_str(),
        Some("expected websocket upgrade")
    );
}

#[test]
fn unmasked_client_frame_closes_the_connection() {
    let (_dev, srv) = started();
    let mut ws = WsClient::connect(srv.addr, "/devices_list/ws").unwrap();
    ws.next_text().unwrap();
    // RFC 6455 requires client frames to be masked; send an unmasked one
    ws.sock.write_all(&[0x81, 0x02, b'h', b'i']).unwrap();
    std::io::Write::flush(&mut ws.sock).unwrap();
    // the server stops the session: eventually EOF or a close frame
    for _ in 0..50 {
        match ws.next_frame() {
            Err(_) => return,
            Ok((0x8, _)) => return,
            Ok(_) => {}
        }
    }
    panic!("server kept an invalid (unmasked) frame session open");
}
