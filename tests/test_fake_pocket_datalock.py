"""Tests for the fake device's data lock (contract: "Data lock and unlock").

The real Pocket boots with /data locked: only the auth service answers
(/v1/data/state, account/auth, unlock_with_auth_key, no Bearer needed) and
everything else is a 502 from nginx until the unlock finishes. These tests pin
that behaviour on the fake, including the 2026-11-20 fault where the unlock
answers "locked" at once and nothing changes.

Run: python3 -m unittest discover -s tests
"""
import json
import os
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_pocket import FAKE_PASSWORD  # noqa: E402
from test_fake_pocket import Base, _wait  # noqa: E402


def _status_and_type(base, path):
    """(HTTP status, Content-Type) of a GET with a Bearer, whatever the body is."""
    req = urllib.request.Request(base + path)
    req.add_header("Authorization", "Bearer test-key-not-a-real-token")
    try:
        with urllib.request.urlopen(req, timeout=4) as r:
            return r.status, r.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        with e:
            return e.code, e.headers.get("Content-Type", "")


class LockedBase(Base):
    scenario = "locked"

    def data_state(self):
        return self.get("/v1/data/state", auth=False)[1]["data_state"]

    def auth_key(self, password=FAKE_PASSWORD):
        code, body = self.post("/api/v1/account/auth", {"password": password}, auth=False)
        return code, body

    def unlock(self, key):
        return self.post("/api/v1/account/unlock_with_auth_key", {"auth_key": key}, auth=False)


class TestUnlockedByDefault(Base):
    def test_existing_scenarios_stay_unlocked(self):
        code, body = self.get("/v1/data/state", auth=False)
        self.assertEqual(code, 200)
        self.assertEqual(body["data_state"], "unlocked")
        self.assertEqual(body["serivice_status"], "ok")
        self.assertEqual(self.get("/v1/models")[0], 200)

    def test_data_state_needs_no_bearer_but_data_endpoints_still_do(self):
        self.assertEqual(self.get("/v1/data/state", auth=False)[0], 200)
        self.assertEqual(self.get("/api/v1/sys/device_info", auth=False)[0], 401)

    def test_device_info_reports_os_version(self):
        code, body = self.get("/api/v1/sys/device_info")
        self.assertEqual(code, 200)
        self.assertEqual(body["tiiny_os"], "0.1.39")


class TestLockedBoot(LockedBase):
    def test_locked_state_shape_matches_the_device(self):
        code, body = self.get("/v1/data/state", auth=False)
        self.assertEqual(code, 200)
        self.assertEqual(body["data_state"], "locked")
        self.assertTrue(body["requires_unlock"])
        self.assertEqual(body["serivice_status"], "pending")

    def test_data_endpoints_are_502_html_even_with_a_bearer(self):
        for path in ("/v1/models", "/api/v1/models/running", "/api/v1/sys/device_info"):
            code, ctype = _status_and_type(self.base, path)
            self.assertEqual(code, 502, path)
            self.assertIn("text/html", ctype, path)

    def test_wrong_password_gets_no_key_and_stays_locked(self):
        code, body = self.auth_key("not-the-password")
        self.assertNotEqual(code, 200)
        self.assertNotIn("auth_key", body)
        self.assertEqual(self.data_state(), "locked")

    def test_unknown_key_is_refused_and_stays_locked(self):
        code, _ = self.unlock("never-issued")
        self.assertNotEqual(code, 200)
        self.assertEqual(self.data_state(), "locked")

    def test_right_password_unlocks_through_unlocking(self):
        code, body = self.auth_key()
        self.assertEqual(code, 200)
        code, body = self.unlock(body["auth_key"])
        self.assertEqual(code, 200)
        self.assertEqual(body["data_state"], "unlocking")
        self.assertEqual(_wait(lambda: self.data_state() == "unlocked"), True)
        self.assertEqual(self.get("/v1/models")[0], 200)


class TestUnlockRefused(LockedBase):
    scenario = "unlock_refused"

    def test_unlock_answers_ok_locked_and_nothing_changes(self):
        key = self.auth_key()[1]["auth_key"]
        code, body = self.unlock(key)
        self.assertEqual(code, 200)
        self.assertEqual(body["status"], "ok")
        self.assertEqual(body["data_state"], "locked")
        # still locked after the time a normal unlock needs
        self.assertIsNone(_wait(lambda: self.data_state() != "locked" or None, timeout=0.2))

    def test_clearing_the_fault_lets_the_unlock_through(self):
        self.fp.control.set_unlock_fault(False)
        key = self.auth_key()[1]["auth_key"]
        self.assertEqual(self.unlock(key)[1]["data_state"], "unlocking")


class TestAuthKeySurvivesReboot(LockedBase):
    def test_key_issued_before_a_reboot_still_unlocks_after_it(self):
        # the real app unlocks with its stored key after every reboot
        key = self.auth_key()[1]["auth_key"]
        self.assertEqual(self.unlock(key)[1]["data_state"], "unlocking")
        _wait(lambda: self.data_state() == "unlocked")
        self.fp.control.lock()
        self.assertEqual(self.unlock(key)[1]["data_state"], "unlocking")


class TestSlowClientDoesNotBlock(LockedBase):
    def test_stalled_account_post_does_not_hold_other_requests(self):
        import socket
        s = socket.create_connection(("127.0.0.1", self.port), timeout=4)
        self.addCleanup(s.close)
        # headers promise a body that never comes
        s.sendall(b"POST /api/v1/account/auth HTTP/1.1\r\nHost: x\r\n"
                  b"Content-Type: application/json\r\nContent-Length: 50\r\n\r\n")
        t0 = time.monotonic()
        self.assertEqual(self.data_state(), "locked")
        self.assertLess(time.monotonic() - t0, 1.0)


class TestCtlDriver(unittest.TestCase):
    def _run(self, commands):
        here = os.path.dirname(os.path.abspath(__file__))
        lines = "".join(json.dumps(c) + "\n" for c in commands + [{"op": "stop"}])
        out = subprocess.run([sys.executable, os.path.join(here, "fake_pocket_ctl.py")],
                             input=lines, capture_output=True, text=True, timeout=20).stdout
        return [json.loads(x) for x in out.splitlines()[1:]]

    def test_string_false_does_not_lock(self):
        replies = self._run([{"op": "cut"},
                             {"op": "restore_power", "boot_models": [], "locked": "false"},
                             {"op": "state"}])
        self.assertEqual(replies[2]["data_state"], "unlocked")

    def test_true_locks_and_fault_op_is_accepted(self):
        replies = self._run([{"op": "unlock_fault", "on": True}, {"op": "cut"},
                             {"op": "restore_power", "boot_models": [], "locked": True},
                             {"op": "state"}])
        self.assertTrue(all(r["ok"] for r in replies))
        self.assertEqual(replies[3]["data_state"], "locked")


class TestRebootLocks(Base):
    def test_lock_control_relocks_the_data(self):
        self.fp.control.lock()
        self.assertEqual(self.get("/v1/data/state", auth=False)[1]["data_state"], "locked")
        self.assertEqual(_status_and_type(self.base, "/v1/models")[0], 502)

    def test_restore_power_locked_comes_back_locked(self):
        self.fp.cut()
        self.fp.restore_power(boot_models=["tiiny/cogito-mini"], locked=True)
        self.assertEqual(self.get("/v1/data/state", auth=False)[1]["data_state"], "locked")

    def test_restore_power_default_stays_unlocked_for_existing_callers(self):
        self.fp.cut()
        self.fp.restore_power(boot_models=["tiiny/cogito-mini"])
        self.assertEqual(self.get("/v1/data/state", auth=False)[1]["data_state"], "unlocked")


if __name__ == "__main__":
    unittest.main()
