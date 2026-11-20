"""Tests for the fake device (tests/fake_pocket.py).

Every check goes through real HTTP on an ephemeral 127.0.0.1 port, so this is
also the proof that the fake speaks the device contract well enough to stand in
for the hardware. `speed` scales simulated time so loads/downloads finish in
milliseconds of wall clock.

Run: python3 -m unittest discover -s tests   (or just this file)
"""
import json
import os
import sys
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_pocket import FakePocket  # noqa: E402

AUTH = "Bearer test-key-not-a-real-token"


def _req(base, path, method="GET", body=None, auth=True, timeout=4):
    """Return (status, decoded-json). Raises urllib.error.URLError on refusal."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if auth:
        req.add_header("Authorization", auth if isinstance(auth, str) else AUTH)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def _wait(fn, timeout=5.0, interval=0.01):
    """Poll fn() until it returns a truthy value, or None if it never does."""
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = fn()
        if last:
            return last
        time.sleep(interval)
    return last


class Base(unittest.TestCase):
    """Common harness: one fake device on an ephemeral port per test."""

    scenario = "normal"
    speed = 200.0

    def setUp(self):
        self.fp = FakePocket(scenario=self.scenario, speed=self.speed)
        self.addCleanup(self.fp.stop)
        self.port = self.fp.start()
        self.base = "http://127.0.0.1:%d" % self.port

    def get(self, path, **kw):
        return _req(self.base, path, "GET", **kw)

    def post(self, path, body=None, **kw):
        return _req(self.base, path, "POST", body=body, **kw)

    def delete(self, path, **kw):
        return _req(self.base, path, "DELETE", **kw)


class TestAuth(Base):
    def test_missing_header_is_401(self):
        code, body = self.get("/v1/models", auth=False)
        self.assertEqual(code, 401)
        self.assertEqual(body, {"detail": "Authorization header is missing"})

    def test_empty_token_is_401(self):
        code, body = self.get("/v1/models", auth="Bearer ")
        self.assertEqual(code, 401)
        self.assertEqual(body["detail"], "Authorization header is missing")

    def test_every_endpoint_requires_auth(self):
        for m, path in [("GET", "/v1/models"), ("GET", "/api/v1/models/"),
                        ("GET", "/api/v1/models/running"), ("GET", "/api/v1/npu/status"),
                        ("GET", "/api/v1/sys/status"), ("GET", "/api/v1/sys/ac_power/"),
                        ("GET", "/api/v1/statistics/week_usage?start_date=2026-11-16"),
                        ("POST", "/api/v1/models/tiiny/embed-small/start"),
                        ("DELETE", "/api/v1/models/tiiny/embed-small")]:
            code, _ = _req(self.base, path, m, auth=False)
            self.assertEqual(code, 401, "%s %s" % (m, path))


class TestEndpoints(Base):
    def test_in_memory_models_shape(self):
        code, body = self.get("/v1/models")
        self.assertEqual(code, 200)
        self.assertTrue(body["data"])
        for m in body["data"]:
            for k in ("id", "object", "created", "owned_by", "capabilities",
                      "type", "supports_chat", "supports_vision", "context_window"):
                self.assertIn(k, m)
        # only the pre-loaded model is in memory in the normal scenario
        self.assertEqual([m["id"] for m in body["data"]], ["tiiny/cogito-mini"])

    def test_store_list_fields(self):
        code, body = self.get("/api/v1/models/?including_downloading=true")
        self.assertEqual(code, 200)
        want = {"id", "display_name", "type", "status", "progress", "total_size",
                "npu_usage", "version", "version_label", "need_update",
                "update_title", "update_desc"}
        for m in body["data"]:
            self.assertTrue(want.issubset(m.keys()), want - set(m.keys()))
        self.assertEqual(len(body["data"]), 5)

    def test_running_payload(self):
        code, body = self.get("/api/v1/models/running")
        self.assertEqual(code, 200)
        inst = body["instances"]
        self.assertIn("running", inst)
        self.assertIn("pending", inst)
        for r in inst["running"]:
            for k in ("model_id", "status", "progress", "active_request_count",
                      "use_time", "last_inference_time", "created_at", "npu_usage"):
                self.assertIn(k, r)
        self.assertEqual(inst["running"][0]["model_id"], "tiiny/cogito-mini")

    def test_npu_status_shape(self):
        code, body = self.get("/api/v1/npu/status")
        self.assertEqual(code, 200)
        self.assertEqual(body["status"], "ok")
        self.assertIn("util_percent", body["devices"][0])

    def test_sys_status_shape(self):
        code, body = self.get("/api/v1/sys/status")
        self.assertEqual(code, 200)
        self.assertEqual(body["status"], "ok")
        for k in ("cpu_percent", "mem_used_mb", "mem_total_mb",
                  "disk_used_mb", "disk_total_mb", "temperature_c"):
            self.assertIn(k, body)

    def test_ac_power_get_and_post(self):
        self.assertEqual(self.get("/api/v1/sys/ac_power/")[1]["ac_power"], False)  # off out of the box
        self.post("/api/v1/sys/ac_power/", {"switch": 1})
        self.assertEqual(self.get("/api/v1/sys/ac_power/")[1]["ac_power"], True)
        self.post("/api/v1/sys/ac_power/", {"switch": 0})
        self.assertEqual(self.get("/api/v1/sys/ac_power/")[1]["ac_power"], False)
        self.post("/api/v1/sys/ac_power/", {"switch": 1})
        self.assertEqual(self.get("/api/v1/sys/ac_power/")[1]["ac_power"], True)

    def test_week_usage_has_seven_days(self):
        code, body = self.get("/api/v1/statistics/week_usage?start_date=2026-11-16")
        self.assertEqual(code, 200)
        self.assertEqual(len(body), 7)
        first = sorted(body)[0]
        self.assertEqual(first, "2026-11-16")
        for model, t in body[first].items():
            for k in ("prompt_tokens", "completion_tokens", "total_tokens", "request_count"):  # device names
                self.assertIn(k, t)

    def test_app_week_usage(self):
        code, body = self.get("/api/v1/statistics/app_week_usage?start_date=2026-11-16")
        self.assertEqual(code, 200)
        for app in body.values():
            self.assertIn("total_tokens", app)
            self.assertIn("models", app)


class TestLoadLifecycle(Base):
    def test_start_fits_loads_and_appears(self):
        code, _ = self.post("/api/v1/models/tiiny/embed-small/start")
        self.assertEqual(code, 200)
        _wait(lambda: self.get("/api/v1/models/tiiny/embed-small/get_progress")[1].get("status") == "loaded")
        code, body = self.get("/api/v1/models/tiiny/embed-small/get_progress")
        self.assertEqual(body["progress"], 100.0)
        ids = [m["id"] for m in self.get("/v1/models")[1]["data"]]
        self.assertIn("tiiny/embed-small", ids)

    def test_progress_monotonic_while_loading(self):
        # slow_load (20 sim-s) at speed 2 => ~40 wall-s load: plenty of room.
        # cogito-mini is loaded (60); embed-small (15) still fits -> 75%.
        fp = FakePocket(scenario="slow_load", speed=2.0)
        fp.start()
        self.addCleanup(fp.stop)
        base = "http://127.0.0.1:%d" % fp.port
        self.assertEqual(_req(base, "/api/v1/models/tiiny/embed-small/start", "POST")[0], 200)
        seen = []
        for _ in range(8):
            code, body = _req(base, "/api/v1/models/tiiny/embed-small/get_progress")
            if body["status"] == "loading":
                seen.append(body["progress"])
            time.sleep(0.02)
        self.assertTrue(seen, "never observed a loading state")
        self.assertTrue(all(0 <= p < 100 for p in seen))
        self.assertTrue(all(a <= b for a, b in zip(seen, seen[1:])), seen)

    def test_unload_candidate_fits_in_normal(self):
        body = self.get("/api/v1/models/tiiny/embed-small/unload_candidate")[1]
        self.assertTrue(body["fits"])
        self.assertEqual(body["unload_candidates"], [])

    def test_unload_candidate_needs_unload_in_normal(self):
        # cogito-mini loaded (60), 40% free; vision-lite needs 45 -> must unload
        body = self.get("/api/v1/models/tiiny/vision-lite/unload_candidate")[1]
        self.assertFalse(body["fits"])
        self.assertIn("tiiny/cogito-mini", body["unload_candidates"])

    def test_stop_unloads(self):
        self.post("/api/v1/models/tiiny/embed-small/start")
        _wait(lambda: self.get("/api/v1/models/tiiny/embed-small/get_progress")[1]["status"] == "loaded")
        self.post("/api/v1/models/tiiny/embed-small/stop")
        self.assertNotIn("tiiny/embed-small",
                         [m["id"] for m in self.get("/v1/models")[1]["data"]])

    def test_start_already_loaded_is_ok(self):
        code, _ = self.post("/api/v1/models/tiiny/cogito-mini/start")
        self.assertEqual(code, 200)


class TestNpuBudget(Base):
    scenario = "npu_full"

    def test_start_without_room_is_409(self):
        code, body = self.post("/api/v1/models/tiiny/general-7b/start")
        self.assertEqual(code, 409)
        self.assertIn("unload_candidates", body)
        self.assertTrue(body["unload_candidates"])

    def test_start_vision_refused(self):
        code, body = self.post("/api/v1/models/tiiny/vision-lite/start")
        self.assertEqual(code, 409)
        self.assertLess(body["available_npu"], body["required_npu"])

    def test_unload_candidate_needs_unload(self):
        body = self.get("/api/v1/models/tiiny/general-7b/unload_candidate")[1]
        self.assertFalse(body["fits"])
        self.assertTrue(body["unload_candidates"])


class TestUpdate(Base):
    scenario = "update_available"

    def test_two_models_need_update(self):
        data = self.get("/api/v1/models/?including_downloading=true")[1]["data"]
        need = [m for m in data if m["need_update"]]
        self.assertEqual(len(need), 2)
        for m in need:
            self.assertTrue(m["update_desc"])
            self.assertTrue(m["update_title"])

    def test_delete_then_download_installs_new_version(self):
        self.delete("/api/v1/models/tiiny/general-7b")
        code, _ = self.post("/api/v1/models/tiiny/general-7b/download")
        self.assertEqual(code, 200)
        # during download it must show up only when including_downloading=true
        incl = [m["id"] for m in self.get("/api/v1/models/?including_downloading=true")[1]["data"]]
        self.assertIn("tiiny/general-7b", incl)
        excl = [m["id"] for m in self.get("/api/v1/models/?including_downloading=false")[1]["data"]]
        self.assertNotIn("tiiny/general-7b", excl)
        self._wait_downloaded("tiiny/general-7b")
        g = next(m for m in self.get("/api/v1/models/?including_downloading=true")[1]["data"]
                 if m["id"] == "tiiny/general-7b")
        self.assertEqual(g["status"], "stopped")
        self.assertEqual(g["version"], "2.1.0")
        self.assertFalse(g["need_update"])

    def _wait_downloaded(self, mid):
        _wait(lambda: next((m["status"] for m in
                            self.get("/api/v1/models/?including_downloading=true")[1]["data"]
                            if m["id"] == mid), None) != "downloading")


class TestPowerCut(Base):
    scenario = "power_cut"

    def test_cut_refuses_then_restore_keeps_boot_models_and_drops_download(self):
        # delete then start a download, then pull the plug while it is in flight
        self.delete("/api/v1/models/tiiny/cogito-mini")
        self.post("/api/v1/models/tiiny/cogito-mini/download")
        self.fp.cut()
        with self.assertRaises(urllib.error.URLError):
            self.get("/v1/models")
        self.fp.restore_power(boot_models=["tiiny/embed-small", "tiiny/classifier-x"])
        ids = [m["id"] for m in self.get("/v1/models")[1]["data"]]
        self.assertEqual(sorted(ids), ["tiiny/classifier-x", "tiiny/embed-small"])
        # the in-flight download is lost: cogito-mini is not re-installed
        data = self.get("/api/v1/models/?including_downloading=true")[1]["data"]
        self.assertNotIn("tiiny/cogito-mini", [m["id"] for m in data])

    def test_restore_keeps_existing_boot_models_loaded(self):
        self.fp.cut()
        self.fp.restore_power(boot_models=["tiiny/cogito-mini"])
        self.assertEqual([m["id"] for m in self.get("/v1/models")[1]["data"]],
                         ["tiiny/cogito-mini"])


class TestControlAndEncoded(Base):
    def test_set_scenario_at_runtime(self):
        self.fp.control.set_scenario("npu_full")
        body = self.get("/api/v1/models/tiiny/general-7b/unload_candidate")[1]
        self.assertFalse(body["fits"])

    def test_encoded_and_raw_id_both_accepted(self):
        encoded = "tiiny%2Fcogito-mini"
        raw = "tiiny/cogito-mini"
        for suffix in ("get_progress", "unload_candidate"):
            c1, b1 = self.get("/api/v1/models/%s/%s" % (encoded, suffix))
            c2, b2 = self.get("/api/v1/models/%s/%s" % (raw, suffix))
            self.assertEqual(c1, 200)
            self.assertEqual(c2, 200)
            self.assertEqual(b1.get("id"), b2.get("id"))
            self.assertEqual(b1, b2)

    def test_unknown_model_is_404(self):
        self.assertEqual(self.get("/api/v1/models/tiiny/nope/get_progress")[0], 404)


class TestImportableApi(Base):
    def test_start_stop_and_scenario_api(self):
        self.assertEqual(self.fp.control.scenario(), self.scenario)
        self.assertIsInstance(self.fp.port, int)
        self.assertGreaterEqual(self.fp.port, 1)


if __name__ == "__main__":
    unittest.main()
