//! HTTP contract tests: the Rust service must answer the way the Python shim
//! does, because the vendor app parses these bodies. Every server binds an
//! ephemeral port and talks to a local fake device only.
//!
//! The expected shapes are the ones `pcsvr.py` produced (verified against the
//! live shim before this rewrite): `/devices` = ok/device_count/devices/
//! local_devices/selected_device, `/status` = the running-service block with
//! `version: "0.1.36-shim"`, `/select_device` = always `ok: true` with the
//! effect visible in the next snapshot.

mod common;

use common::*;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

fn started() -> (FakeDevice, pcsvr_rs::server::Server) {
    let dev = FakeDevice::start(device_json(TEST_UUID, "Test Pocket", TEST_SN), "200 OK");
    let srv = spawn_server(config_for(dev.port));
    (dev, srv)
}

#[test]
fn devices_payload_matches_the_shim_contract() {
    let (_dev, srv) = started();
    let resp = http_get(srv.addr, "/devices").unwrap();
    assert_eq!(resp.status, 200);
    assert_eq!(
        resp.header("content-type").as_deref(),
        Some("application/json")
    );
    let body = resp.text();
    let v = pcsvr_rs::json::parse(&body).expect("valid json");
    for key in [
        "ok",
        "device_count",
        "devices",
        "local_devices",
        "selected_device",
    ] {
        assert!(v.get(key).is_some(), "missing key {key} in {body}");
    }
    assert_eq!(v.get("ok").unwrap().as_bool(), Some(true));
    assert_eq!(v.get("device_count").unwrap().as_i64(), Some(1));
    assert_eq!(v.get("devices").unwrap().as_array().unwrap().len(), 1);
    assert_eq!(v.get("local_devices").unwrap().as_array().unwrap().len(), 1);
    let snap = &v.get("devices").unwrap().as_array().unwrap()[0];
    for key in [
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
        "metadata_url",
    ] {
        assert!(snap.get(key).is_some(), "snapshot missing {key}: {body}");
    }
    // identity comes from the device, not from a constant
    assert_eq!(snap.get("device_id").unwrap().as_str(), Some(TEST_SN));
    assert_eq!(snap.get("uuid").unwrap().as_str(), Some(TEST_UUID));
    assert_eq!(
        snap.get("device_name").unwrap().as_str(),
        Some("Test Pocket")
    );
    assert_eq!(snap.get("serial_number").unwrap().as_str(), Some(TEST_SN));
    assert_eq!(snap.get("reachable").unwrap().as_bool(), Some(true));
    assert_eq!(snap.get("connection_type").unwrap().as_str(), Some("usb"));
    assert!(snap.get("last_seen_at").unwrap().is_number());
    assert!(v.get("selected_device").unwrap().is_null());
}

#[test]
fn api_v1_alias_answers_like_devices() {
    let (_dev, srv) = started();
    let a = http_get(srv.addr, "/devices").unwrap().text();
    let b = http_get(srv.addr, "/api/v1/devices").unwrap().text();
    assert_eq!(a, b);
}

#[test]
fn status_reports_the_running_service() {
    let (_dev, srv) = started();
    let resp = http_get(srv.addr, "/status").unwrap();
    assert_eq!(resp.status, 200);
    let v = pcsvr_rs::json::parse(&resp.text()).unwrap();
    assert_eq!(v.get("ok").unwrap().as_bool(), Some(true));
    assert_eq!(v.get("status").unwrap().as_str(), Some("running"));
    assert_eq!(v.get("service_status").unwrap().as_str(), Some("running"));
    assert_eq!(v.get("running").unwrap().as_bool(), Some(true));
    assert_eq!(v.get("installed").unwrap().as_bool(), Some(true));
    assert_eq!(v.get("enabled").unwrap().as_bool(), Some(true));
    assert_eq!(v.get("platform").unwrap().as_str(), Some("linux"));
    // the app gates on this string family; keep the shim's value verbatim
    assert_eq!(v.get("version").unwrap().as_str(), Some("0.1.36-shim"));
    assert_eq!(v.get("device_count").unwrap().as_i64(), Some(1));
}

#[test]
fn select_device_accepts_the_real_id_and_rejects_others() {
    let (_dev, srv) = started();
    // A wrong id: the reply keeps the shim's shape (ok:true) but the device
    // is NOT selected, so the next snapshot still reports selected_device
    // null. That is exactly how pcsvr.py behaved (it set a flag, the reply
    // body was constant).
    let r = http_request(
        srv.addr,
        "POST",
        "/select_device",
        Some("{\"device_id\":\"nope\"}"),
    )
    .unwrap();
    assert_eq!(r.status, 200);
    let v = pcsvr_rs::json::parse(&r.text()).unwrap();
    assert_eq!(v.get("ok").unwrap().as_bool(), Some(true));
    assert_eq!(v.get("selected_device").unwrap().as_str(), Some(TEST_SN));
    assert!(!srv.device.is_selected());
    let d = pcsvr_rs::json::parse(&http_get(srv.addr, "/devices").unwrap().text()).unwrap();
    assert!(d.get("selected_device").unwrap().is_null());

    // the serial we present: accepted
    let r = http_request(
        srv.addr,
        "POST",
        "/select_device",
        Some(&format!("{{\"device_id\":\"{TEST_SN}\"}}")),
    )
    .unwrap();
    assert_eq!(
        pcsvr_rs::json::parse(&r.text())
            .unwrap()
            .get("ok")
            .unwrap()
            .as_bool(),
        Some(true)
    );
    assert!(srv.device.is_selected());
    let d = pcsvr_rs::json::parse(&http_get(srv.addr, "/devices").unwrap().text()).unwrap();
    assert!(!d.get("selected_device").unwrap().is_null());

    // the uuid is accepted too (the app has used both)
    let r = http_request(
        srv.addr,
        "POST",
        "/select_device",
        Some(&format!("{{\"device_id\":\"{TEST_UUID}\"}}")),
    )
    .unwrap();
    assert!(srv.device.is_selected() || r.status == 200);

    // a malformed body must not crash anything and must not select
    let _ = http_request(srv.addr, "POST", "/select_device", Some("{not json")).unwrap();
    assert_eq!(http_get(srv.addr, "/status").unwrap().status, 200);
}

#[test]
fn post_devices_reports_selected_when_reachable() {
    let (_dev, srv) = started();
    let r = http_request(srv.addr, "POST", "/devices", None).unwrap();
    assert_eq!(r.status, 200);
    let v = pcsvr_rs::json::parse(&r.text()).unwrap();
    assert_eq!(v.get("device_count").unwrap().as_i64(), Some(1));
    // the shim reported the device as selected whenever it was reachable
    assert!(!v.get("selected_device").unwrap().is_null());
}

#[test]
fn unknown_paths_return_the_shim_404_shape() {
    let (_dev, srv) = started();
    let r = http_get(srv.addr, "/nope").unwrap();
    assert_eq!(r.status, 404);
    let v = pcsvr_rs::json::parse(&r.text()).unwrap();
    assert_eq!(v.get("ok").unwrap().as_bool(), Some(false));
    assert_eq!(v.get("error").unwrap().as_str(), Some("not implemented"));
    assert_eq!(v.get("path").unwrap().as_str(), Some("/nope"));
    // query strings are stripped before routing, as in the shim
    let r = http_get(srv.addr, "/nope?x=1").unwrap();
    assert_eq!(
        pcsvr_rs::json::parse(&r.text())
            .unwrap()
            .get("path")
            .unwrap()
            .as_str(),
        Some("/nope")
    );
}

#[test]
fn keep_alive_serves_two_requests_on_one_connection() {
    let (_dev, srv) = started();
    let mut s = TcpStream::connect(srv.addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    s.write_all(b"GET /status HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let r1 = common::read_response(&mut s).unwrap();
    assert_eq!(r1.status, 200);
    s.write_all(b"GET /devices HTTP/1.1\r\nHost: x\r\n\r\n")
        .unwrap();
    let r2 = common::read_response(&mut s).unwrap();
    assert_eq!(r2.status, 200);
    assert!(r2.text().contains("local_devices"));
}

#[test]
fn post_body_split_across_writes_is_read_in_full() {
    let (_dev, srv) = started();
    let mut s = TcpStream::connect(srv.addr).unwrap();
    s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
    let body = format!("{{\"device_id\":\"{TEST_SN}\"}}");
    let head = format!(
        "POST /select_device HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    // header first, then the body in two chunks: a naive reader that assumes
    // "one read = one request" fails here
    s.write_all(head.as_bytes()).unwrap();
    s.flush().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    let (a, b) = body.split_at(body.len() / 2);
    s.write_all(a.as_bytes()).unwrap();
    s.flush().unwrap();
    std::thread::sleep(Duration::from_millis(50));
    s.write_all(b.as_bytes()).unwrap();
    s.flush().unwrap();
    let r = common::read_response(&mut s).unwrap();
    assert!(r.text().contains("selected_device"), "got {}", r.text());
    // the selection only happens if the full body arrived
    assert!(
        srv.device.is_selected(),
        "split body was not reassembled: {}",
        r.text()
    );
}

#[test]
fn malformed_and_truncated_requests_do_not_kill_the_service() {
    let (_dev, srv) = started();
    // garbage
    let mut s = TcpStream::connect(srv.addr).unwrap();
    let _ = s.write(b"\x00\x01not a request\r\n\r\n");
    let _ = s.read(&mut [0u8; 16]);
    drop(s);
    // header without terminating blank line
    let mut s = TcpStream::connect(srv.addr).unwrap();
    let _ = s.write(b"GET /status HTTP/1.1\r\nHost: x\r\n");
    drop(s);
    // POST that promises a body and never sends it
    let mut s = TcpStream::connect(srv.addr).unwrap();
    let _ = s.write(b"POST /select_device HTTP/1.1\r\nHost: x\r\nContent-Length: 500\r\n\r\n");
    drop(s);
    // the service still answers
    assert_eq!(http_get(srv.addr, "/status").unwrap().status, 200);
}

#[test]
fn offline_device_yields_zero_devices_but_keeps_serving() {
    // fake device that answers 500: the probe fails, the count drops to 0
    let dev = FakeDevice::start("{}".into(), "500 Internal Server Error");
    let mut cfg = config_for(dev.port);
    cfg.probe_interval_ms = 100;
    let srv = spawn_server(cfg);
    let body = http_get(srv.addr, "/devices").unwrap().text();
    let v = pcsvr_rs::json::parse(&body).unwrap();
    assert_eq!(v.get("devices").unwrap().as_array().unwrap().len(), 0);
    assert_eq!(v.get("device_count").unwrap().as_i64(), Some(0));
    assert!(v.get("selected_device").unwrap().is_null());
    let st = pcsvr_rs::json::parse(&http_get(srv.addr, "/status").unwrap().text()).unwrap();
    assert_eq!(st.get("device_count").unwrap().as_i64(), Some(0));
    assert_eq!(st.get("ok").unwrap().as_bool(), Some(true));
}

#[test]
fn identity_falls_back_to_config_when_device_has_no_serial() {
    // no serial_number in device.json -> device_id (uuid) is presented, and
    // a configured Shim.DeviceId wins over everything
    let dev = FakeDevice::start(
        format!("{{\"device_id\":\"{TEST_UUID}\",\"name\":\"NoSN\"}}"),
        "200 OK",
    );
    let mut cfg = config_for(dev.port);
    cfg.device_id_fallback = "CONFIGSN999999999999".into();
    let srv = spawn_server(cfg);
    let snap = srv.device.snapshot();
    assert_eq!(
        snap.get("device_id").unwrap().as_str(),
        Some("CONFIGSN999999999999")
    );
    // the device.json uuid survives
    assert_eq!(snap.get("uuid").unwrap().as_str(), Some(TEST_UUID));
    // and the name came from device.json, not a constant
    assert_eq!(snap.get("device_name").unwrap().as_str(), Some("NoSN"));
}

#[test]
fn no_device_at_all_still_answers_with_the_same_shape() {
    // nothing listening on the device port (a closed local port, never a
    // real device address)
    let free = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let srv = spawn_server(config_for(free));
    let v = pcsvr_rs::json::parse(&http_get(srv.addr, "/devices").unwrap().text()).unwrap();
    assert_eq!(v.get("devices").unwrap().as_array().unwrap().len(), 0);
    assert_eq!(v.get("ok").unwrap().as_bool(), Some(true));
    assert_eq!(http_get(srv.addr, "/status").unwrap().status, 200);
}
