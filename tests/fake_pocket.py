#!/usr/bin/env python3
"""Fake Tiiny Pocket device for tests (stdlib only: http.server/threading/json).

Serves the HTTP surface of the device against a real client so the JS side
(`src/m3_device.js`) and the future care engine can be tested offline with no
real hardware and no network.

Run standalone:
    python3 tests/fake_pocket.py --port 0 [--scenario NAME] [--speed 50]
prints ``LISTENING <port>`` on stdout and serves until killed.

Importable:
    fp = FakePocket(scenario="normal", speed=50.0)
    port = fp.start()          # -> int port on 127.0.0.1 (0 = ephemeral)
    ...                         # drive the scenario via fp.control
    fp.stop()

Endpoints (field names copied from docs/design/device-contract.md "Device
facts"; untested-on-device shapes are marked with ``# assumed``):

    GET    /v1/models                                  -> {data:[...]} in-memory ids
    GET    /api/v1/models/?including_downloading=true  -> {data:[...]} installed list
    GET    /api/v1/models/running                      -> {instances:{running:[],pending:[]}}
    GET    /api/v1/models/{id}/get_progress            -> {progress,status}
    GET    /api/v1/models/{id}/unload_candidate        -> {id,required_npu,available_npu,
                                                          fits,unload_candidates}
    POST   /api/v1/models/{id}/start                   -> load into NPU (budget 100%)
    POST   /api/v1/models/{id}/stop                    -> unload from memory
    POST   /api/v1/models/{id}/download                -> download (progress over N s)
    DELETE /api/v1/models/{id}                         -> remove installed copy
    GET    /api/v1/npu/status                          -> {status,devices:[{util_percent,...}]}
    GET    /api/v1/sys/status                          -> small realistic object (# assumed)
    GET    /api/v1/sys/ac_power/                       -> {status:"ok",ac_power:bool}
    POST   /api/v1/sys/ac_power/                       body {"switch":0|1}
    GET    /api/v1/statistics/week_usage?start_date=   -> {start_date,days:{date:{id:{...}}}}
    GET    /api/v1/statistics/app_week_usage?start_date= -> {start_date,apps:{name:{...}}}

Auth mirrors the device: every endpoint requires ``Authorization: Bearer <non-
empty>`` or it answers 401 ``{"detail":"Authorization header is missing"}``.

Model ids contain a ``/`` (``owner/name``); both the raw and the percent-
encoded forms are accepted in every path.

Time is simulated: a load takes ``load_seconds`` *simulated* seconds and a
download ``download_seconds`` simulated seconds; the wall clock is scaled by
``speed`` so tests run fast (``--speed 50`` = 50x). Status transitions are
computed lazily on each request, so a single client that polls is enough to
drive the whole lifecycle.

Scenarios (also switchable at runtime via ``fp.control.set_scenario``):
    normal           a few models, some in memory, normal load times
    slow_load        loads take 20 simulated seconds
    npu_full         NPU budget nearly full -> a new load does not fit
    power_cut        normal state; use control.cut() / control.restore_power()
    update_available two models with need_update and realistic update_desc

``power_cut`` behaviour (available in every scenario, driven by ``control``):
    control.cut()                  server socket closes -> connection refused
    control.restore_power(boot_models=[...])
        answers again; only ``boot_models`` are in memory and every in-progress
        download is lost (a model that was downloading returns to not-installed).
"""
import argparse
import json
import re
import threading
import time
from datetime import date, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote

NPU_BUDGET = 100.0

# Full catalog: the set of models the device knows about. ``installed`` state is
# layered on top per model by the scenario. ``new_*`` is what a download brings.
_CATALOG = [
    {"id": "tiiny/cogito-mini", "display_name": "Cogito Mini", "type": "chat",
     "npu_usage": 60.0, "total_size": 2_400_000_000, "version": "1.3.0",
     "version_label": "v1.3.0", "capabilities": ["main"], "supports_chat": True,
     "supports_vision": False, "context_window": 8192,
     "aliases": ["cogito-mini"],
     "new_version": "1.4.0", "new_version_label": "v1.4.0",
     "update_title": "Cogito Mini 1.4",
     "update_desc": "Improved instruction following and ~12% faster decode; "
                    "fixes truncated answers on long prompts."},
    {"id": "tiiny/general-7b", "display_name": "General 7B", "type": "chat",
     "npu_usage": 80.0, "total_size": 4_600_000_000, "version": "2.0.0",
     "version_label": "v2.0.0", "capabilities": ["main"], "supports_chat": True,
     "supports_vision": False, "context_window": 16384,
     "aliases": ["general-7b", "g7b"],
     "new_version": "2.1.0", "new_version_label": "v2.1.0",
     "update_title": "General 7B 2.1",
     "update_desc": "Requantized to Q4_K_M: ~30% smaller at equal quality and adds "
                    "function-calling support."},
    {"id": "tiiny/embed-small", "display_name": "Embed Small", "type": "embedding",
     "npu_usage": 15.0, "total_size": 420_000_000, "version": "0.9.0",
     "version_label": "v0.9.0", "capabilities": ["embedding"], "supports_chat": False,
     "supports_vision": False, "context_window": 2048,
     "aliases": ["embed-small"],
     "new_version": "0.9.0", "new_version_label": "v0.9.0",
     "update_title": "", "update_desc": ""},
    {"id": "tiiny/classifier-x", "display_name": "Classifier X", "type": "classification",
     "npu_usage": 20.0, "total_size": 560_000_000, "version": "1.1.0",
     "version_label": "v1.1.0", "capabilities": ["systemone"], "supports_chat": False,
     "supports_vision": False, "context_window": 4096,
     "aliases": ["classifier-x"],
     "new_version": "1.1.0", "new_version_label": "v1.1.0",
     "update_title": "", "update_desc": ""},
    {"id": "tiiny/vision-lite", "display_name": "Vision Lite", "type": "vision",
     "npu_usage": 45.0, "total_size": 2_900_000_000, "version": "1.0.0",
     "version_label": "v1.0.0", "capabilities": ["main"], "supports_chat": True,
     "supports_vision": True, "context_window": 8192,
     "aliases": ["vision-lite"],
     "new_version": "1.0.0", "new_version_label": "v1.0.0",
     "update_title": "", "update_desc": ""},
]


def _model(spec):
    """Fresh per-model state built from a catalog spec plus a scenario preset."""
    m = dict(spec)
    m.update({"installed": True, "in_memory": False, "status": "stopped",
              "progress": 0.0, "need_update": False, "update_title": "",
              "update_desc": "", "load_started": None, "load_deadline": None,
              "download_started": None, "download_deadline": None,
              "download_target_version": None, "pre_installed": True,
              "created_at": 0, "use_time": 0, "last_inference_time": 0,
              "active_request_count": 0})
    return m


def _state_for(scenario):
    """Return (models, load_seconds, download_seconds) for a scenario."""
    models = {c["id"]: _model(c) for c in _CATALOG}
    if scenario == "normal":
        models["tiiny/cogito-mini"]["in_memory"] = True
        models["tiiny/cogito-mini"]["status"] = "loaded"
        models["tiiny/cogito-mini"]["progress"] = 100.0
        return models, 3.0, 6.0
    if scenario == "slow_load":
        models["tiiny/cogito-mini"]["in_memory"] = True
        models["tiiny/cogito-mini"]["status"] = "loaded"
        models["tiiny/cogito-mini"]["progress"] = 100.0
        return models, 20.0, 6.0
    if scenario == "npu_full":
        # 95% used -> 5% headroom, so nothing but the smallest new model fits.
        for mid in ("tiiny/cogito-mini", "tiiny/classifier-x", "tiiny/embed-small"):
            models[mid]["in_memory"] = True
            models[mid]["status"] = "loaded"
            models[mid]["progress"] = 100.0
        return models, 3.0, 6.0
    if scenario == "update_available":
        models["tiiny/cogito-mini"]["in_memory"] = True
        models["tiiny/cogito-mini"]["status"] = "loaded"
        models["tiiny/cogito-mini"]["progress"] = 100.0
        for mid in ("tiiny/cogito-mini", "tiiny/general-7b"):
            spec = next(c for c in _CATALOG if c["id"] == mid)
            models[mid]["need_update"] = True
            models[mid]["update_title"] = spec["update_title"]
            models[mid]["update_desc"] = spec["update_desc"]
        return models, 3.0, 6.0
    if scenario == "power_cut":
        models["tiiny/cogito-mini"]["in_memory"] = True
        models["tiiny/cogito-mini"]["status"] = "loaded"
        models["tiiny/cogito-mini"]["progress"] = 100.0
        return models, 3.0, 6.0
    raise ValueError("unknown scenario: %r" % (scenario,))


class _Control:
    """Thread-safe knobs a test drives while the server is serving."""

    def __init__(self, pocket):
        self._p = pocket

    def set_scenario(self, name):
        """Reset state to a fresh scenario's initial conditions."""
        with self._p.lock:
            self._p.scenario = name
            self._p.ac_power = True
            self._p._load_catalog()
        return name

    def cut(self):
        """Power cut: the server stops answering (connection refused)."""
        self._p.cut()

    def restore_power(self, boot_models=None):
        """Power back on with only ``boot_models`` in memory; downloads lost."""
        self._p.restore_power(boot_models)

    def scenario(self):
        return self._p.scenario


class FakePocket:
    """A fake device on 127.0.0.1; one port serves both BASE and P8800 roles."""

    def __init__(self, scenario="normal", speed=1.0, host="127.0.0.1"):
        self.host = host
        self.speed = float(speed)
        self.scenario = scenario
        self.lock = threading.RLock()
        self.port = None
        self.server = None
        self.thread = None
        self.powered = True
        self.ac_power = True
        self._t0 = time.monotonic()
        self.control = _Control(self)
        self.models = {}
        self._load_seconds = 3.0
        self._download_seconds = 6.0
        self._load_catalog()

    # -- catalog / scenario --------------------------------------------------
    def _load_catalog(self):
        models, load_s, download_s = _state_for(self.scenario)
        for m in models.values():
            m["pre_installed"] = m["installed"]
        self.models = models
        self._load_seconds = load_s
        self._download_seconds = download_s

    def sim_now(self):
        return (time.monotonic() - self._t0) * self.speed

    def _advance(self, now):
        """Move lazy state to where the simulated clock says it belongs."""
        for m in self.models.values():
            if m["status"] == "loading" and m.get("load_deadline") is not None:
                if now >= m["load_deadline"]:
                    m["status"] = "loaded"
                    m["in_memory"] = True
                    m["progress"] = 100.0
                    m["load_deadline"] = None
                    m["created_at"] = int(time.time())
                else:
                    m["progress"] = _clamp((now - m["load_started"]) / self._load_seconds * 100.0)
            elif m["status"] == "downloading" and m.get("download_deadline") is not None:
                if now >= m["download_deadline"]:
                    m["status"] = "stopped"
                    m["installed"] = True
                    m["progress"] = 0.0
                    if m.get("download_target_version"):
                        m["version"] = m["download_target_version"]
                        m["version_label"] = m.get("download_target_label") or m["version"]
                    m["need_update"] = False
                    m["download_deadline"] = None
                else:
                    m["progress"] = _clamp((now - m["download_started"]) / self._download_seconds * 100.0)

    # -- server lifecycle ----------------------------------------------------
    def start(self, port=0):
        with self.lock:
            if self.server is not None:
                return self.port
            self.port = port
            self.server = ThreadingHTTPServer((self.host, self.port), _Handler)
            self.server.daemon_threads = True
            self.server.pocket = self
            self.thread = threading.Thread(target=self.server.serve_forever,
                                           kwargs={"poll_interval": 0.02}, daemon=True)
            self.thread.start()
            self.port = self.server.server_address[1]
            return self.port

    def stop(self):
        with self.lock:
            if self.server is None:
                return
            self.server.shutdown()
            self.server.server_close()
            self.server = None
            self.thread = None

    def _stop_serving(self):
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
        self.server = None
        self.thread = None

    def _start_serving(self):
        self.server = ThreadingHTTPServer((self.host, self.port), _Handler)
        self.server.daemon_threads = True
        self.server.pocket = self
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()

    def cut(self):
        with self.lock:
            self.powered = False
            self._stop_serving()

    def restore_power(self, boot_models=None):
        boot = set(boot_models or [])
        with self.lock:
            self.powered = True
            for m in self.models.values():
                if m["status"] == "downloading":
                    # in-progress download lost: revert to the state before it began
                    m["status"] = "stopped"
                    m["installed"] = m.get("pre_installed", True)
                    m["progress"] = 0.0
                    m["download_deadline"] = None
                    m["download_target_version"] = None
                if m["status"] == "loading":
                    m["status"] = "stopped"
                    m["load_deadline"] = None
                in_mem = m["installed"] and (m["id"] in boot)
                m["in_memory"] = in_mem
                m["status"] = "loaded" if in_mem else "stopped"
                m["progress"] = 100.0 if in_mem else 0.0
            self._start_serving()

    # -- pure view builders (assume caller holds the lock) -------------------
    def _busy(self):
        return any(m["status"] in ("loading", "downloading") for m in self.models.values())

    def _store_entries(self, including_downloading):
        out = []
        for m in self.models.values():
            if not m["installed"] and m["status"] != "downloading":
                continue
            if m["status"] == "downloading" and not including_downloading:
                continue
            out.append(_store_entry(m))
        out.sort(key=lambda e: e["id"])
        return out

    def _in_memory_entries(self):
        return [_in_memory_entry(m) for m in self.models.values() if m["in_memory"]]

    def _running_payload(self):
        running, pending = [], []
        for m in self.models.values():
            if m["in_memory"]:
                running.append({
                    "model_id": m["id"], "status": m["status"], "progress": m["progress"],
                    "active_request_count": m["active_request_count"],
                    "use_time": m["use_time"], "last_inference_time": m["last_inference_time"],
                    "created_at": m["created_at"], "npu_usage": m["npu_usage"]})
            elif m["status"] == "loading":
                pending.append(m["id"])
        running.sort(key=lambda e: e["model_id"])
        pending.sort()
        return {"instances": {"running": running, "pending": pending}}

    def _npu_status(self):
        used = sum(m["npu_usage"] for m in self.models.values() if m["in_memory"])
        util = 68.0 if self._busy() else (4.0 if used > 0 else 0.0)
        return {"status": "ok", "devices": [{
            "id": 0, "name": "npu0", "util_percent": util,
            "mem_used_mb": int(used / 100.0 * 4096), "mem_total_mb": 4096}]}

    def _sys_status(self):
        return {"status": "ok", "cpu_percent": 7.0, "mem_used_mb": 1180,
                "mem_total_mb": 3960, "disk_used_mb": 18200, "disk_total_mb": 117000,
                "temperature_c": 44, "battery_percent": 100, "charging": True}

    def _week_usage(self, start_date):
        days = {}
        ids = sorted(m["id"] for m in self.models.values() if m["installed"]) or ["tiiny/cogito-mini"]
        for i in range(7):
            d = (date.fromisoformat(start_date) + timedelta(days=i)).isoformat()
            day = {}
            for j, mid in enumerate(ids):
                base = 1000 * (i + 1) * (j + 1)
                day[mid] = {"prompt": base, "completion": base // 2,
                            "total": base * 3 // 2, "requests": i * 3 + j + 1}
            days[d] = day
        return {"start_date": start_date, "days": days}

    def _app_usage(self, start_date):
        ids = sorted(m["id"] for m in self.models.values() if m["installed"]) or ["tiiny/cogito-mini"]
        apps = {}
        for k, app in enumerate(["music-lab", "tiinyos", "control-panel"]):
            per = {}
            total = 0
            for j, mid in enumerate(ids):
                t = (k + 1) * (j + 1) * 400
                per[mid] = t
                total += t
            apps[app] = {"total": total, "models": per}
        return {"start_date": start_date, "apps": apps}

    def _unload_candidate(self, mid):
        target = self.models.get(mid)
        if target is None:
            return None
        used = sum(m["npu_usage"] for m in self.models.values() if m["in_memory"])
        avail = max(0.0, NPU_BUDGET - used)
        req = target["npu_usage"]
        cands = []
        if avail < req:
            pool = sorted((m for m in self.models.values()
                           if m["in_memory"] and m["id"] != mid),
                          key=lambda m: -m["npu_usage"])
            room = avail
            for m in pool:
                if room >= req:
                    break
                room += m["npu_usage"]
                cands.append(m["id"])
        return {"id": mid, "required_npu": req, "available_npu": round(avail, 3),
                "fits": avail >= req, "unload_candidates": cands}

    # -- mutations (assume caller holds the lock) ----------------------------
    def _start(self, mid):
        m = self.models.get(mid)
        if m is None:
            return (404, {"detail": "model not found: %s" % mid})
        if not m["installed"]:
            return (409, {"detail": "model not installed: %s" % mid})
        if m["status"] == "loaded":
            return (200, {"status": "ok", "detail": "already loaded"})
        if m["status"] == "loading":
            return (200, {"status": "ok", "detail": "loading", "progress": m["progress"]})
        if m["status"] == "downloading":
            return (409, {"detail": "model is downloading: %s" % mid})
        used = sum(x["npu_usage"] for x in self.models.values() if x["in_memory"])
        if used + m["npu_usage"] > NPU_BUDGET:
            uc = self._unload_candidate(mid)
            return (409, {"detail": "insufficient NPU",
                          "required_npu": uc["required_npu"],
                          "available_npu": uc["available_npu"],
                          "unload_candidates": uc["unload_candidates"]})
        now = self.sim_now()
        m["status"] = "loading"
        m["progress"] = 0.0
        m["load_started"] = now
        m["load_deadline"] = now + self._load_seconds
        return (200, {"status": "ok", "detail": "loading"})

    def _stop(self, mid):
        m = self.models.get(mid)
        if m is None:
            return (404, {"detail": "model not found: %s" % mid})
        if m["status"] == "loading":
            return (409, {"detail": "cannot stop while loading: %s" % mid})
        m["in_memory"] = False
        m["status"] = "stopped"
        m["progress"] = 0.0
        return (200, {"status": "ok", "detail": "stopped"})

    def _download(self, mid):
        m = self.models.get(mid)
        if m is None:
            return (404, {"detail": "model not found: %s" % mid})
        if m["status"] == "downloading":
            return (200, {"status": "ok", "detail": "already downloading",
                          "progress": m["progress"]})
        if m["status"] == "loading":
            return (409, {"detail": "cannot download while loading: %s" % mid})
        m["pre_installed"] = m["installed"]
        m["status"] = "downloading"
        m["progress"] = 0.0
        now = self.sim_now()
        m["download_started"] = now
        m["download_deadline"] = now + self._download_seconds
        if m["need_update"] and m.get("download_target_version") is None:
            spec = next(c for c in _CATALOG if c["id"] == mid)
            m["download_target_version"] = spec["new_version"]
            m["download_target_label"] = spec["new_version_label"]
        return (200, {"status": "ok", "detail": "downloading"})

    def _delete(self, mid):
        m = self.models.get(mid)
        if m is None:
            return (404, {"detail": "model not found: %s" % mid})
        m["in_memory"] = False
        m["installed"] = False
        m["status"] = "stopped"
        m["progress"] = 0.0
        return (200, {"status": "ok", "detail": "deleted"})

    def _set_ac_power(self, switch):
        self.ac_power = (switch == 1)
        return (200, {"status": "ok", "ac_power": self.ac_power})


def _clamp(x):
    return max(0.0, min(100.0, float(x)))


def _store_entry(m):
    return {"id": m["id"], "display_name": m["display_name"], "type": m["type"],
            "status": m["status"], "progress": m["progress"],
            "total_size": m["total_size"], "npu_usage": m["npu_usage"],
            "version": m["version"], "version_label": m["version_label"],
            "need_update": m["need_update"], "update_title": m["update_title"],
            "update_desc": m["update_desc"],
            # extras consumed by src/m3_performance.js m3:store
            "capabilities": m["capabilities"], "supports_chat": m["supports_chat"],
            "supports_vision": m["supports_vision"],
            "context_window": m["context_window"]}


def _in_memory_entry(m):
    return {"id": m["id"], "object": "model", "created": m["created_at"] or int(time.time()),
            "owned_by": "tiiny", "capabilities": m["capabilities"], "type": m["type"],
            "supports_chat": m["supports_chat"], "supports_vision": m["supports_vision"],
            "context_window": m["context_window"], "aliases": m["aliases"]}


_ID_ACTION = {
    "get_progress": r"^/api/v1/models/(.+)/get_progress$",
    "unload_candidate": r"^/api/v1/models/(.+)/unload_candidate$",
    "start": r"^/api/v1/models/(.+)/start$",
    "stop": r"^/api/v1/models/(.+)/stop$",
    "download": r"^/api/v1/models/(.+)/download$",
}


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # silence default access log
        pass

    def _pocket(self):
        return self.server.pocket

    def _read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        if not raw:
            return {}
        try:
            return json.loads(raw)
        except ValueError:
            return {}

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _authed(self):
        h = self.headers.get("Authorization", "")
        if h.startswith("Bearer "):
            if h[7:].strip():
                return True
        return False

    def _path(self):
        return unquote(self.path.split("?", 1)[0])

    def _handle(self, method):
        p = self._pocket()
        if not self._authed():
            return self._send(401, {"detail": "Authorization header is missing"})
        path = self._path()
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        q = parse_qs(query)

        with p.lock:
            p._advance(p.sim_now())
            return self._route(method, path, q)

    def _route(self, method, path, q):
        p = self._pocket()

        if method == "GET" and path in ("/v1/models", "/v1/models/"):
            return self._send(200, {"data": p._in_memory_entries()})
        if method == "GET" and path in ("/api/v1/models/running",):
            return self._send(200, p._running_payload())
        if method == "GET" and path in ("/api/v1/models", "/api/v1/models/"):
            inc = (q.get("including_downloading") or [""])[0].lower() != "false"
            return self._send(200, {"data": p._store_entries(inc)})
        if method == "GET" and path == "/api/v1/npu/status":
            return self._send(200, p._npu_status())
        if method == "GET" and path == "/api/v1/sys/status":
            return self._send(200, p._sys_status())
        if method == "GET" and path in ("/api/v1/sys/ac_power", "/api/v1/sys/ac_power/"):
            return self._send(200, {"status": "ok", "ac_power": p.ac_power})
        if method == "GET" and path == "/api/v1/statistics/week_usage":
            sd = (q.get("start_date") or [""])[0] or _today()
            return self._send(200, p._week_usage(sd))
        if method == "GET" and path == "/api/v1/statistics/app_week_usage":
            sd = (q.get("start_date") or [""])[0] or _today()
            return self._send(200, p._app_usage(sd))

        for action, pattern in _ID_ACTION.items():
            m = re.match(pattern, path)
            if m:
                mid = m.group(1)
                if method == "GET" and action == "get_progress":
                    mm = p.models.get(mid)
                    if mm is None:
                        return self._send(404, {"detail": "model not found: %s" % mid})
                    return self._send(200, {"progress": mm["progress"], "status": mm["status"]})
                if method == "GET" and action == "unload_candidate":
                    uc = p._unload_candidate(mid)
                    if uc is None:
                        return self._send(404, {"detail": "model not found: %s" % mid})
                    return self._send(200, uc)
                if method == "POST":
                    if action == "start":
                        code, body = p._start(mid)
                    elif action == "stop":
                        code, body = p._stop(mid)
                    elif action == "download":
                        code, body = p._download(mid)
                    else:
                        code, body = (404, {"detail": "unsupported action: %s" % action})
                    return self._send(code, body)

        if method == "POST" and path in ("/api/v1/sys/ac_power", "/api/v1/sys/ac_power/"):
            body = self._read_json()
            code, resp = p._set_ac_power(body.get("switch", 0))
            return self._send(code, resp)

        if method == "DELETE":
            m = re.match(r"^/api/v1/models/(.+)$", path)
            if m:
                code, body = p._delete(m.group(1))
                return self._send(code, body)

        return self._send(404, {"detail": "not found: %s %s" % (method, path)})

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")


def _today():
    return date.today().isoformat()


def main():
    ap = argparse.ArgumentParser(description="Fake Tiiny Pocket device for tests")
    ap.add_argument("--port", type=int, default=0, help="port to bind (0 = ephemeral)")
    ap.add_argument("--scenario", default="normal",
                    help="normal|slow_load|npu_full|power_cut|update_available")
    ap.add_argument("--speed", type=float, default=1.0, help="simulated time speed factor")
    args = ap.parse_args()
    fp = FakePocket(scenario=args.scenario, speed=args.speed)
    port = fp.start(port=args.port)
    print("LISTENING %d" % port, flush=True)
    try:
        while True:
            time.sleep(0.5)
    except KeyboardInterrupt:
        fp.stop()


if __name__ == "__main__":
    main()
