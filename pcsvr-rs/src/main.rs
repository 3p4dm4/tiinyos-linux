//! Entry point. The TiinyOS app starts us as
//! `pcsvr -f pcsvr-api.yaml` with cwd = its own directory, detached; it also
//! accepts an already-running service on the port (`isPcServerPortReady`).
//!
//! Signals: no handler is installed (std cannot install one without a libc
//! dependency). SIGTERM/SIGINT therefore take the default disposition — the
//! process terminates and the kernel closes its sockets — which is exactly
//! what the app and the watchdog expect.

use std::process::exit;

use pcsvr_rs::{config, log, server, VERSION};

const HELP: &str = "\
pcsvr — TiinyOS PC service for Linux

usage: pcsvr [-f <config.yaml>] [options]

  -f, --file <path>     config file (default: ./pcsvr-api.yaml if present)
      --device-ip <ip>  device address (overrides env TIINY_DEVICE_IP and the file)
      --device-port <p> device metadata port (default 39218)
      --port <p>        listen port (default 60000)
      --host <h>        listen host (default 127.0.0.1)
  -h, --help            this text
  -V, --version         print the version

Environment overrides (highest precedence):
  TIINY_DEVICE_IP, TIINY_DEVICE_PORT, PCSVR_HOST, PCSVR_PORT,
  PCSVR_WS_INTERVAL_MS, PCSVR_WS_READ_TIMEOUT_MS,
  PCSVR_PROBE_INTERVAL_MS, PCSVR_PROBE_TIMEOUT_MS,
  PCSVR_LOG, PCSVR_LOG_MAX_BYTES, PCSVR_MAX_WS, PCSVR_MAX_CONNECTIONS
";

/// What the command line asked for. Every field is an override: `None` means
/// "fall through to env, then config file, then default".
#[derive(Debug, Default, PartialEq)]
pub struct Cli {
    pub config_file: Option<String>,
    pub device_ip: Option<String>,
    pub device_port: Option<u16>,
    pub port: Option<u16>,
    pub host: Option<String>,
    pub help: bool,
    pub version: bool,
}

/// Parse argv (without the program name). Errors are strings so the parser is
/// testable without killing the process.
fn parse_args(args: &[String]) -> Result<Cli, String> {
    let mut out = Cli::default();
    let mut i = 0;
    while i < args.len() {
        // each consumed value advances `i` one extra step
        let consumed = match args[i].as_str() {
            "-h" | "--help" => {
                out.help = true;
                0
            }
            "-V" | "--version" => {
                out.version = true;
                0
            }
            "-f" | "--file" | "--config" => {
                let v = args
                    .get(i + 1)
                    .ok_or_else(|| format!("{} needs a value", args[i]))?;
                out.config_file = Some(v.clone());
                1
            }
            "--device-ip" => {
                let v = args.get(i + 1).ok_or("--device-ip needs a value")?;
                out.device_ip = Some(v.clone());
                1
            }
            "--device-port" => {
                let v = args.get(i + 1).ok_or("--device-port needs a value")?;
                out.device_port = Some(
                    v.trim()
                        .parse()
                        .map_err(|_| "--device-port needs a number".to_string())?,
                );
                1
            }
            "--port" => {
                let v = args.get(i + 1).ok_or("--port needs a value")?;
                out.port = Some(
                    v.trim()
                        .parse()
                        .map_err(|_| "--port needs a number".to_string())?,
                );
                1
            }
            "--host" => {
                let v = args.get(i + 1).ok_or("--host needs a value")?;
                out.host = Some(v.clone());
                1
            }
            other => return Err(format!("unknown argument {other} (try --help)")),
        };
        i += 1 + consumed;
    }
    Ok(out)
}

impl Cli {
    fn apply(&self, cfg: &mut config::Config) {
        if let Some(ip) = &self.device_ip {
            cfg.device_ip = ip.clone();
        }
        if let Some(p) = self.device_port {
            cfg.device_port = p;
        }
        if let Some(p) = self.port {
            cfg.port = p;
        }
        if let Some(h) = &self.host {
            cfg.host = h.clone();
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cli = match parse_args(&args) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("pcsvr: {e}");
            exit(2);
        }
    };
    if cli.help {
        print!("{HELP}");
        return;
    }
    if cli.version {
        println!("pcsvr {VERSION}");
        return;
    }

    let file = match config::load_cli_config(cli.config_file.as_deref()) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("pcsvr: {e}");
            exit(2);
        }
    };
    let mut cfg = config::resolve(&file);
    cli.apply(&mut cfg);

    log::init(&cfg.log_path, cfg.log_max_bytes);
    log::global().log(&format!(
        "=== pcsvr-rs {VERSION} start pid={} device={}:{} ws={}ms probe={}ms",
        std::process::id(),
        cfg.device_ip,
        cfg.device_port,
        cfg.ws_interval_ms,
        cfg.probe_interval_ms
    ));

    let srv = match server::start(cfg.clone()) {
        Ok(s) => s,
        Err(e) => {
            // The app may already have a service on the port; report and
            // exit non-zero (same practical effect as the Python shim
            // raising OSError).
            eprintln!("pcsvr: cannot listen on {}:{}: {e}", cfg.host, cfg.port);
            log::global().log(&format!("bind failed: {e}"));
            exit(1);
        }
    };
    log::global().log(&format!("listening on {}", srv.addr));

    // Park forever: no signal handler is installed (std cannot install one
    // without a libc dependency), so SIGTERM/SIGINT terminate the process and
    // the kernel closes its sockets. `srv` is kept alive on purpose: dropping
    // it would stop the accept thread.
    let _srv = srv;
    loop {
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn app_style_invocation() {
        // exactly how TiinyOS launches it
        let c = parse_args(&v(&["-f", "pcsvr-api.yaml"])).unwrap();
        assert_eq!(c.config_file.as_deref(), Some("pcsvr-api.yaml"));
        assert_eq!(c.port, None);
    }

    #[test]
    fn every_value_flag_consumes_its_value() {
        let c = parse_args(&v(&[
            "--device-ip",
            "10.0.0.9",
            "--device-port",
            "39218",
            "--port",
            "60000",
            "--host",
            "127.0.0.1",
        ]))
        .unwrap();
        assert_eq!(c.device_ip.as_deref(), Some("10.0.0.9"));
        assert_eq!(c.device_port, Some(39218));
        assert_eq!(c.port, Some(60000));
        assert_eq!(c.host.as_deref(), Some("127.0.0.1"));
    }

    #[test]
    fn flags_can_be_reordered_and_mixed_with_file() {
        let c = parse_args(&v(&[
            "--port",
            "60001",
            "-f",
            "x.yaml",
            "--device-ip",
            "1.2.3.4",
        ]))
        .unwrap();
        assert_eq!(c.port, Some(60001));
        assert_eq!(c.config_file.as_deref(), Some("x.yaml"));
        assert_eq!(c.device_ip.as_deref(), Some("1.2.3.4"));
    }

    #[test]
    fn missing_values_and_garbage_are_errors() {
        assert!(parse_args(&v(&["--port"])).is_err());
        assert!(parse_args(&v(&["--port", "abc"])).is_err());
        assert!(parse_args(&v(&["--device-port", ""])).is_err());
        assert!(parse_args(&v(&["--nope", "1"])).is_err());
        assert!(parse_args(&v(&["extra"])).is_err());
        // a port out of range is an error, not a silent wrap
        assert!(parse_args(&v(&["--port", "70000"])).is_err());
    }

    #[test]
    fn help_and_version_are_flag_only() {
        assert!(parse_args(&v(&["--help"])).unwrap().help);
        assert!(parse_args(&v(&["-V"])).unwrap().version);
        assert!(!parse_args(&v(&["--port", "1"])).unwrap().version);
    }

    #[test]
    fn apply_overrides_only_what_was_given() {
        let mut cfg = config::Config::default();
        let before = cfg.clone();
        parse_args(&v(&[])).unwrap().apply(&mut cfg);
        assert_eq!(cfg, before);

        parse_args(&v(&["--port", "60001", "--device-ip", "10.9.8.7"]))
            .unwrap()
            .apply(&mut cfg);
        assert_eq!(cfg.port, 60001);
        assert_eq!(cfg.device_ip, "10.9.8.7");
        // untouched keys keep their resolved values
        assert_eq!(cfg.host, before.host);
        assert_eq!(cfg.device_port, before.device_port);
    }
}
