"""Tool manifests (src/<id>.tool.json) agree with the schema and with the repo.

The manifest is not read inside TiinyOS; it is the contract between a tool and
the repo tooling (standalone launcher, install.sh, patch_main.py). These checks
catch the drift a contributor would not see locally: a file not shipped by
install.sh, an IPC channel outside the tool's prefix, a tray label that the
patch does not write. Format: docs/framework/MANIFEST.md.
"""
import glob
import json
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
SCHEMA = os.path.join(ROOT, "docs", "framework", "tool.schema.json")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def load_manifests():
    out = {}
    for path in sorted(glob.glob(os.path.join(SRC, "*.tool.json"))):
        out[os.path.basename(path)] = json.loads(read(path))
    return out


def semver(v):
    return tuple(int(x) for x in v.split("-")[0].split("."))


# handlers are registered either directly or through a re-wiring helper
# (m3_care.js: once('<ch>')(...)), on ipcMain or an injected stub (bus.handle);
# only m3:* literals count as channels
HANDLER = re.compile(r"""(?:\.handle|\bonce)\(\s*['"](m3:[^'"]+)['"]""")


class ManifestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifests = load_manifests()
        cls.install = read(os.path.join(ROOT, "install.sh"))
        # PATCH is split over adjacent Python string literals: join them
        cls.patch_main = re.sub(r"'\s*\n\s*'", "", read(os.path.join(ROOT, "tools", "patch_main.py")))
        cls.version = read(os.path.join(ROOT, "VERSION")).strip()
        cls.schema = json.loads(read(SCHEMA))

    def test_there_is_at_least_one_manifest(self):
        self.assertIn("device.tool.json", self.manifests)

    def test_schema(self):
        try:
            import jsonschema
        except ImportError:
            jsonschema = None
        for name, m in self.manifests.items():
            with self.subTest(manifest=name):
                if jsonschema:
                    jsonschema.Draft202012Validator(self.schema).validate(m)
                else:  # minimal fallback: required fields and the id pattern
                    for key in self.schema["required"]:
                        self.assertIn(key, m)
                    self.assertRegex(m["id"], self.schema["properties"]["id"]["pattern"])

    def test_file_name_matches_id(self):
        for name, m in self.manifests.items():
            self.assertEqual(name, m["id"] + ".tool.json")

    def test_ids_and_prefixes_are_unique(self):
        ids = [m["id"] for m in self.manifests.values()]
        prefixes = [m["ipc"]["prefix"] for m in self.manifests.values()]
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(len(prefixes), len(set(prefixes)))

    def test_files_exist_and_are_shipped(self):
        for name, m in self.manifests.items():
            files = m["main"]["files"] + m["renderer"]["files"]
            for f in files:
                with self.subTest(manifest=name, file=f):
                    self.assertTrue(os.path.isfile(os.path.join(SRC, f)), f"src/{f} missing")
                    self.assertIn(f'"$HERE"/src/{f}', self.install, f"install.sh does not copy {f}")
            for d in m["renderer"].get("dirs", []):
                with self.subTest(manifest=name, dir=d):
                    self.assertTrue(os.path.isdir(os.path.join(SRC, d)), f"src/{d}/ missing")
                    self.assertIn(f'"$HERE/src/{d}"', self.install, f"install.sh does not copy {d}/")

    def test_main_files_are_in_the_header_check(self):
        verify = re.search(r'for f in \(([^)]*)\):\n\s+assert f in h', self.install)
        self.assertIsNotNone(verify, "install.sh header-verify list not found")
        listed = re.findall(r'"([^"]+)"', verify.group(1))
        for name, m in self.manifests.items():
            for f in m["main"]["files"]:
                with self.subTest(manifest=name, file=f):
                    self.assertIn(f, listed)

    def test_min_framework_is_this_version_or_older(self):
        for name, m in self.manifests.items():
            with self.subTest(manifest=name):
                self.assertLessEqual(semver(m["minFramework"]), semver(self.version))

    def test_tray_label_is_written_by_patch_main(self):
        for name, m in self.manifests.items():
            tray = m.get("hooks", {}).get("tray")
            if not tray:
                continue
            module = m["main"]["module"][:-3]
            with self.subTest(manifest=name):
                self.assertIn(
                    f'{{label:"{tray["label"]}",click:()=>{{try{{require("./{module}").open()',
                    self.patch_main)

    def test_registry_ids_have_standalone_manifests(self):
        reg = json.loads(read(os.path.join(ROOT, "standalone", "tools.json")))
        by_id = {m["id"]: m for m in self.manifests.values()}
        for tool in reg["tools"]:
            with self.subTest(tool=tool):
                self.assertIn(tool, by_id, f"standalone/tools.json lists '{tool}' without src/{tool}.tool.json")
                self.assertTrue(by_id[tool]["standalone"]["enabled"])

    def test_ipc_handlers_are_under_the_prefix(self):
        for name, m in self.manifests.items():
            prefix = m["ipc"]["prefix"] + ":"
            legacy = set(m["ipc"].get("legacy", []))
            seen = set()
            for f in m["main"]["files"]:
                seen.update(HANDLER.findall(read(os.path.join(SRC, f))))
            with self.subTest(manifest=name):
                self.assertTrue(seen, "no IPC handler found: is the pattern still right?")
                stray = sorted(c for c in seen if not c.startswith(prefix) and c not in legacy)
                self.assertEqual(stray, [], f"channels outside {prefix}* and ipc.legacy")


    def test_examples_follow_the_same_rules(self):
        """examples/<id>/ is the copy-me reference: schema, file names, its own
        files present and its handlers under its prefix (not installed, so the
        install.sh / registry checks do not apply)."""
        try:
            import jsonschema
        except ImportError:
            jsonschema = None
        found = sorted(glob.glob(os.path.join(ROOT, "examples", "*", "*.tool.json")))
        self.assertTrue(found, "no example manifest")
        for path in found:
            m = json.loads(read(path))
            base = os.path.dirname(path)
            with self.subTest(example=os.path.relpath(path, ROOT)):
                if jsonschema:
                    jsonschema.Draft202012Validator(self.schema).validate(m)
                self.assertEqual(os.path.basename(path), m["id"] + ".tool.json")
                for f in m["main"]["files"] + m["renderer"]["files"]:
                    self.assertTrue(os.path.isfile(os.path.join(base, f)), f)
                for d in m["renderer"].get("dirs", []):
                    self.assertTrue(os.path.isdir(os.path.join(base, d)), d)
                seen = set()
                for f in m["main"]["files"]:
                    seen.update(HANDLER.findall(read(os.path.join(base, f))))
                prefix = m["ipc"]["prefix"] + ":"
                self.assertTrue(seen)
                self.assertEqual(sorted(c for c in seen if not c.startswith(prefix)), [])

if __name__ == "__main__":
    unittest.main()
