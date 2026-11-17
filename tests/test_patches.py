"""Functional tests for the patch tools, run on fixtures (no vendor bundle needed).

Each patch tool must: (1) apply exactly once against a fixture containing its
anchor, (2) be idempotent, (3) fail loudly when the anchor is absent (bundle
drift). This is the CI gate that catches "the vendor bundle changed and the
patch silently stopped working".
"""
import os
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOOLS = os.path.join(ROOT, "tools")


def run_tool(name, fixture_path):
    return subprocess.run(
        [sys.executable, os.path.join(TOOLS, name), fixture_path],
        capture_output=True, text=True,
    )


class PatchToolCase(unittest.TestCase):
    tool = ""
    anchor = ""

    def setUp(self):
        if not self.tool:
            self.skipTest("base class, not a case")

    def _fixture(self, content):
        f = tempfile.NamedTemporaryFile("w", suffix=".js", delete=False)
        f.write(content)
        f.close()
        self.addCleanup(os.unlink, f.name)
        return f.name

    def test_applies_once_then_idempotent(self):
        path = self._fixture("x=1;" + self.anchor + "y=2;")
        r1 = run_tool(self.tool, path)
        self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr)
        self.assertIn("applied", r1.stdout)
        r2 = run_tool(self.tool, path)
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        self.assertIn("already patched", r2.stdout)

    def test_fails_on_drift(self):
        path = self._fixture("x=1; // anchor was renamed upstream\n")
        r = run_tool(self.tool, path)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("drift", r.stdout + r.stderr)


class TestPatchBallBlur(PatchToolCase):
    tool = "patch_ball_blur.py"
    anchor = 'shouldIgnoreTransientHide(t){if(process.platform!=="darwin")return!1;'


class TestPatchBallClick(PatchToolCase):
    tool = "patch_ball_click.py"
    anchor = 't.setIgnoreMouseEvents(!0,{forward:!0}) n.setIgnoreMouseEvents(r,{forward:i?.forward})'


class TestPatchMain(PatchToolCase):
    tool = "patch_main.py"
    anchor = ',{type:"separator"},{label:t.quit,click:()=>this.quit()}].filter(Boolean)'

    def test_applies_once_then_idempotent(self):
        path = self._fixture("x=1;" + self.anchor + "y=2;")
        r1 = run_tool(self.tool, path)
        self.assertEqual(r1.returncode, 0, r1.stdout + r1.stderr)
        self.assertIn("applied", r1.stdout)
        r2 = run_tool(self.tool, path)
        self.assertEqual(r2.returncode, 0, r2.stdout + r2.stderr)
        self.assertIn("already patched", r2.stdout)


if __name__ == "__main__":
    unittest.main()
