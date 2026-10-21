"""The one-click update returns at once and reports where it is; release files agree with each other.
Run:  cd backend && python -m unittest discover -s tests -v"""
import asyncio
import os
import re
import sys
import tempfile
import time
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import HTTPException  # noqa: E402

from app.api import admin  # noqa: E402
from app.core.config import settings  # noqa: E402

ROOT = os.path.join(os.path.dirname(__file__), "..", "..")
IDENTITY = types.SimpleNamespace(id=1)


class Update(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        for p in (
            mock.patch.object(settings, "DATA_DIR", self.tmp.name),
            mock.patch.object(settings, "DOCKER_SOCK", self.tmp.name),  # any existing path: "a socket is mounted"
            mock.patch.object(admin.activity, "record", mock.AsyncMock()),
        ):
            p.start()
            self.addCleanup(p.stop)

    def run_trigger(self, do_update):
        async def go():
            with mock.patch.object(admin, "_do_update", do_update):
                out = await admin.trigger_update(IDENTITY)
                started = await admin._update_status_raw()
                await asyncio.gather(*list(admin._running))
                return out, started, await admin._update_status_raw()
        return asyncio.run(go())

    def test_returns_before_the_download_finishes_and_says_so(self):
        async def slow():
            await asyncio.sleep(0.2)
        out, started, _ = self.run_trigger(slow)
        self.assertTrue(out["ok"])
        self.assertEqual((started["state"], started["step"]), ("in_progress", "pulling"))

    def test_a_failed_download_says_why(self):
        async def refused():
            raise HTTPException(502, "Docker refused to pull ghcr.io/x/y:latest (HTTP 401): denied")
        _, _, after = self.run_trigger(refused)
        self.assertEqual(after["state"], "failed")
        self.assertEqual(after["step"], "download")
        self.assertIn("denied", after["error"])

    def test_a_step_the_helper_already_recorded_is_kept(self):
        async def helper_failed():
            admin._write_status("failed", "helper_create", "latest")
            raise HTTPException(502, "Couldn't start the updater: boom")
        _, _, after = self.run_trigger(helper_failed)
        self.assertEqual(after["step"], "helper_create")
        self.assertIn("boom", after["error"])

    def test_no_docker_socket_is_a_clean_refusal(self):
        with mock.patch.object(settings, "DOCKER_SOCK", os.path.join(self.tmp.name, "missing.sock")):
            with self.assertRaises(HTTPException) as cm:
                asyncio.run(admin.trigger_update(IDENTITY))
        self.assertEqual(cm.exception.status_code, 400)

    def test_a_running_update_is_not_started_twice(self):
        admin._write_status("in_progress", "pulling", "latest")
        calls = []
        async def never():
            calls.append(1)
        out, _, _ = self.run_trigger(never)
        self.assertIn("already running", out["message"])
        self.assertEqual(calls, [])

    def test_a_dead_attempt_does_not_block_the_next(self):
        with open(admin._status_path(), "w") as f:
            f.write(f"in_progress pulling latest {int(time.time()) - 3600}")
        calls = []
        async def ok():
            calls.append(1)
        self.run_trigger(ok)
        self.assertEqual(calls, [1])


class ReleaseFiles(unittest.TestCase):
    def read(self, *p):
        with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
            return f.read()

    def test_version_matches_the_newest_changelog_entry(self):
        newest = re.search(r"^## \[([^\]]+)\]", self.read("CHANGELOG.md"), re.M).group(1)
        self.assertEqual(self.read("VERSION").strip(), newest)

    def test_the_changelog_the_app_ships_is_the_same_file(self):
        # The Docker build copies the root file over this one; keeping the repo copy equal means the dev server and a
        # plain `npm run build` agree too, and a forgotten copy shows up here instead of as a stale "what's new".
        self.assertEqual(self.read("CHANGELOG.md"), self.read("frontend", "public", "CHANGELOG.md"))


if __name__ == "__main__":
    unittest.main()
