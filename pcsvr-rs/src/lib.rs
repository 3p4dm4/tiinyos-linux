//! pcsvr-rs — the Linux "PC service" TiinyOS expects on 127.0.0.1:60000.
//!
//! TiinyOS ships a native `pcsvr.exe` for Windows and nothing for Linux, so
//! the app finds no local PC service. This crate reimplements only the part
//! the app actually uses (see `README.md` for the endpoint contract), in Rust
//! with no runtime dependencies, and fixes the two operational problems of
//! the Python stopgap it replaces: it does not leak threads or file
//! descriptors, and it has no device identity compiled into it — identity is
//! read from the device's own `device.json` at runtime.
//!
//! No `unsafe` anywhere (`forbid` below).

#![forbid(unsafe_code)]
#![deny(rust_2018_idioms)]

pub mod base64;
pub mod config;
pub mod device;
pub mod http;
pub mod json;
pub mod log;
pub mod server;
pub mod sha1;
pub mod ws;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
