#!/usr/bin/env python3
"""Test driver for the fake Tiiny Pocket: a control channel over stdin.

Standalone fake_pocket.py has no way to trigger scenarios at runtime; this
wrapper runs a FakePocket (same flags: --scenario, --speed) on an ephemeral
127.0.0.1 port, prints ``LISTENING <port>`` on stdout, and then answers one
JSON command per line on stdin with one JSON line on stdout:

    {"op": "cut"}                                  power cut (socket closed)
    {"op": "restore_power", "boot_models": [...], "locked": false}
                                                   back on; downloads lost;
                                                   locked=true -> /data locked
    {"op": "lock"}                                 /data locked (a reboot)
    {"op": "unlock_fault", "on": true}             unlocks answer "locked"
    {"op": "set_scenario", "name": "npu_full"}     reset to a scenario
    {"op": "scenario"}                             -> {"scenario": "..."}
    {"op": "state"}                                -> per-model ground truth
    {"op": "stop"}                                 -> exit 0

The device port and the control channel never mix; the device side is
byte-identical to fake_pocket.py (same FakePocket class, unchanged).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_pocket import FakePocket  # noqa: E402


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="normal")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    fp = FakePocket(scenario=args.scenario, speed=args.speed)
    port = fp.start()
    print("LISTENING %d" % port, flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
        except ValueError:
            print(json.dumps({"ok": False, "error": "bad json"}), flush=True)
            continue
        op = cmd.get("op")
        if op == "cut":
            fp.control.cut()
            reply = {"ok": True}
        elif op == "restore_power":
            fp.control.restore_power(cmd.get("boot_models"),
                                     locked=cmd.get("locked") is True)
            reply = {"ok": True}
        elif op == "lock":
            fp.control.lock()
            reply = {"ok": True}
        elif op == "unlock_fault":
            fp.control.set_unlock_fault(cmd.get("on", True) is True)
            reply = {"ok": True}
        elif op == "set_scenario":
            reply = {"ok": True,
                     "scenario": fp.control.set_scenario(cmd.get("name", "normal"))}
        elif op == "scenario":
            reply = {"ok": True, "scenario": fp.control.scenario()}
        elif op == "state":
            with fp.lock:
                fp._advance(fp.sim_now())
                reply = {"ok": True, "ac_power": fp.ac_power,
                         "data_state": fp.data_state,
                         "models": {m["id"]: {
                             "installed": m["installed"], "in_memory": m["in_memory"],
                             "status": m["status"], "progress": round(m["progress"], 1),
                             "need_update": m["need_update"], "version": m["version"]}
                             for m in fp.models.values()}}
        elif op in ("load", "unload"):
            # a "another client" mutation: the device changes state without the
            # engine asking (for by='device' activity-log tests)
            with fp.lock:
                fp._advance(fp.sim_now())
                code, body = (fp._start(cmd["id"]) if op == "load"
                              else fp._stop(cmd["id"]))
            reply = {"ok": code == 200, "detail": body.get("detail", "")}
        elif op == "stop":
            print(json.dumps({"ok": True}), flush=True)
            fp.stop()
            sys.exit(0)
        else:
            reply = {"ok": False, "error": "unknown op: %r" % op}
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    main()
