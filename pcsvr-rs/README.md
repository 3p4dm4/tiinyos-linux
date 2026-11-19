# pcsvr-rs — the Linux PC service, in Rust

Drop-in replacement for the Python `pcsvr` shim that TiinyOS starts on Linux
(`resources/pcsvr/linux/pcsvr.py`). Same wire contract, no interpreter, and
**bounded by design**: that Python shim leaks one thread per connection and
one per websocket reconnect (~50/min under the app's reconnect pattern, 13k
threads and an EMFILE death after ~1.5 days — `docs/vendor-thread-leak.md`),
so every resource here has an explicit cap and every thread has an exit
condition. The leak is in our compat shim, not in Tiiny's own code.

Zero runtime dependencies (`std` only), `#![forbid(unsafe_code)]`, one static-ish
binary (~640 KB, links libc + libgcc only).

## Build

```bash
tools/build_pcsvr.sh --test          # test + build, stages in dist/pcsvr/
tools/build_pcsvr.sh --dest /tmp/x   # build only, stage elsewhere
```

or directly:

```bash
cd pcsvr-rs && cargo build --release && ./target/release/pcsvr --help
```

## Run

```bash
./pcsvr -f pcsvr-api.yaml            # exactly how TiinyOS starts the shim
PCSVR_DEVICE_IP=172.20.31.109 ./pcsvr --port 60000
```

The device identity is **never hardcoded**: at startup and every
`ProbeIntervalMs` the service reads
`http://<DeviceIp>:<DeviceDiscovery.HTTPPort>/device.json` and builds its
device snapshot from the answer (serial, uuid, name, ip). The `Shim.*` identity
keys in the config are only fallbacks for a device that does not answer —
leave them empty and the values come from the device itself.
`pcsvr-api.yaml.example` shows the file; the real one is per machine and is
not committed.

## Contract (what the TiinyOS app sees)

JSON shape matches the Python shim byte-for-byte in ordering and spacing
(`{"ok": true, ...}`), because the app parses it.

| method | path | response |
|---|---|---|
| `GET` | `/status` | `{"ok":true,"status":"running","service_status":"running","running":true,"installed":true,"enabled":true,"platform":"linux","version":"0.1.36-shim","device_count":N}` |
| `GET` | `/devices`, `/api/v1/devices` | `{"ok":true,"device_count":N,"devices":[snap],"local_devices":[snap],"selected_device":null}` |
| `POST` | `/devices`, `/api/v1/devices` | same, but a reachable device is reported as selected (shim behaviour) |
| `POST` | `/select_device` | `{"ok":true,"selected_device":"<serial>","auto_selected":false,"devices":[...]}` |
| `GET` | `/devices_list/ws` | WebSocket upgrade (see below) |
| anything else | any | `404 {"ok":false,"error":"not implemented","path":"<path>"}` |

The version string stays `0.1.36-shim` on `/status` because the app may gate on
it; the Rust build identifies itself with `pcsvr --version`.

A device that is not answering is simply absent from the snapshots
(`device_count: 0`) — no crash, no retry storm; the probe loop keeps trying on
its own interval.

### WebSocket `/devices_list/ws`

Standard RFC 6455 server (masked client frames required, ping/pong, close
handshake). The first frame and every `WsIntervalMs` after it:

```json
{"event":"connection","data":{"devices":[snap],"local_devices":[snap],"selected_device":null}}
```

`selected_device` is the snapshot object once a device has been selected, `null`
before. Outgoing frames are never masked (server → client). A frame larger than
4 MB or more than 16 live sessions → oldest session evicted.

## Bounds (the leak-proof part)

| resource | cap | what happens at the cap |
|---|---|---|
| websocket sessions | 16 (`MaxWebSockets`) | oldest is closed and evicted |
| connection threads | 256 (`MaxConnections`) | new connection is closed immediately (fail fast, no queue) |
| requests per keep-alive connection | 1000 | connection closed after the response |
| connection lifetime | 600 s | closed after the response |
| websocket lifetime | 3600 s | session ends (the app reconnects) |
| idle HTTP connection | 15 s | closed |
| websocket read | 500 ms per turn | loop re-checks timers, interval and liveness |
| log file | 2 MB | rotated to `<log>.old` |

Every thread is either the accept thread, the probe thread, or a connection
thread that exits on socket close, read/write error, idle timeout, request cap
or lifetime cap. Nothing is retried forever and nothing is spawned per timer tick.

`tests/leak.rs` proves it: 500 sequential websockets and 500 HTTP connections
against a live server, then thread count and fd count must return to baseline.

## Config

Precedence: **env > file > default**. Keys read from `pcsvr-api.yaml`:

| key | env | default |
|---|---|---|
| `Host` | `PCSVR_HOST` | `127.0.0.1` |
| `Port` | `PCSVR_PORT` | `60000` |
| `Shim.DeviceIp` | `TIINY_DEVICE_IP` | `172.20.31.109` (USB /30 example from the device docs) |
| `DeviceDiscovery.HTTPPort` | `TIINY_DEVICE_PORT` | `39218` |
| `Shim.DeviceId` / `Shim.SerialNumber` | — | empty (identity comes from `device.json`) |
| `Shim.Uuid` | — | empty |
| `Shim.DeviceName` | — | empty |
| `Shim.WsIntervalMs` | `PCSVR_WS_INTERVAL_MS` | `3000` |
| `Shim.WsReadTimeoutMs` | `PCSVR_WS_READ_TIMEOUT_MS` | `500` |
| `Shim.ProbeIntervalMs` | `PCSVR_PROBE_INTERVAL_MS` | `5000` |
| `Shim.ProbeTimeoutMs` | `PCSVR_PROBE_TIMEOUT_MS` | `3000` |
| `Shim.MaxWebSockets` | `PCSVR_MAX_WS` | `16` |
| `Shim.MaxConnections` | `PCSVR_MAX_CONNECTIONS` | `256` |
| `Shim.LogPath` | `PCSVR_LOG` | `pcsvr-rs.log` (empty = no file) |
| `Shim.LogMaxBytes` | `PCSVR_LOG_MAX_BYTES` | `2000000` |

Unknown keys and the vendor file's other blocks (WireGuard, DNS, SSHProxy,
WebUI, …) are ignored, so the vendor `pcsvr-api.yaml` can be reused as-is.
Log timestamps are **UTC** (same clock as the HTTP `Date` header).

## Tests

```bash
cargo test --offline                      # 72 tests
cargo test --offline -- --test-threads=1  # required for tests/leak.rs
```

* unit: SHA-1 (FIPS vectors), base64 (RFC 4648), JSON round-trip + CPython
  shape, YAML-subset config, log rotation, websocket framing, arg parsing.
* `tests/http_contract.rs`: payload shapes, keep-alive, split bodies, malformed
  requests, offline device, identity fallback, no device at all.
* `tests/websocket.rs`: handshake (RFC accept value), connection frame, repeat
  interval, ping/pong (incl. split across TCP writes), close handshake, cap
  eviction, unmasked frame rejection, HTTP while a WS is open.
* `tests/leak.rs`: thread/fd reclamation after 500 websockets, 500 HTTP
  connections, stalled clients, and connection-cap recovery.

Tests bind `127.0.0.1` on an **ephemeral** port (port 0) against a fake device
in-process: they never touch port 60000, a real Pocket, or `~/.config/TiinyOS`.
Tests that read process-wide counters take a lock so they never overlap.

## Replacing the Python shim

The app starts the shim from `<clone>/electron/resources/pcsvr/linux/` as
`python3 ./pcsvr -f pcsvr-api.yaml`. To run the Rust build there instead:

```bash
systemctl --user disable --now pcsvr-watchdog.timer   # it restarts the python shim
# stop the running shim, then:
cd <clone>/electron/resources/pcsvr/linux && ./pcsvr -f pcsvr-api.yaml
curl -s localhost:60000/status
```

Until that swap is done, keep the watchdog enabled — it is what keeps the
Python shim alive.

## Device fields: verified vs assumed

No Pocket was touched while writing this (evaluation in progress), so the
device-side facts come from the device docs, not from a live capture:

| fact | status |
|---|---|
| `GET http://<ip>:39218/device.json`, no auth, is the reachability probe | **verified** in the device docs (`DEVICE-API.md`) and in what the Python shim did |
| device.json carries name, IPv4/IPv6, `usb.network`, `device_ip`, `host_ip`, metadata URLs | **verified** in the device docs |
| device.json carries a serial and a uuid usable as `device_id` | **assumed** — not documented. The code tries `serial_number`/`serial`/`device_serial`/`sn` and `uuid`/`device_uuid`/`guid`; if none is present it falls back to `Shim.DeviceId` / `Shim.Uuid` from the config, so a serial-less device.json still produces the identity the app expects |
| the `device_id` the app compares is the **serial** (`TNYM…`), not the uuid | **verified** from the shim's own comment and the app's connect flow |
| the snapshot field names (`device_ip`, `local`, `usb`, `reachable`, `connection_type`, `is_activated`, `addresses`, `preferred_endpoints`, `last_seen_at`, `metadata_url`) | copied from the Python shim, which is what the app was seen to accept |

If a real device turns out to answer device.json with different key names, the
only file to touch is `src/device.rs` (`identity_from`).

## Known limits

* No signal handler (std cannot install one without a libc dependency):
  SIGTERM/SIGINT use the default disposition, the process dies and the kernel
  closes its sockets. That is what the app and the watchdog expect.
* Only what the app actually calls is implemented; the Windows pcsvr's extra
  subsystems (WireGuard, DNS, SSH proxy, Web UI) are not reproduced and their
  config keys are ignored on purpose.
* `device.json` is read over HTTP with no TLS, same as the shim.
