"""A device that has been asleep must not overwrite a place another device saved (core/progress_guard.py).
Run:  cd backend && python -m unittest discover -s tests -v"""
import asyncio
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.api import play, read  # noqa: E402
from app.core import progress_guard as pg  # noqa: E402


class Rule(unittest.TestCase):
    def test_no_known_position_always_writes(self):
        self.assertFalse(pg.moved_elsewhere(None, 5000.0, 30))
        self.assertFalse(pg.moved_elsewhere(100.0, None, 30))

    def test_our_own_saves_are_not_someone_else(self):
        self.assertFalse(pg.moved_elsewhere(1000.0, 1000.0, 30))
        self.assertFalse(pg.moved_elsewhere(1000.0, 1025.0, 30))

    def test_another_device_ahead_or_behind(self):
        self.assertTrue(pg.moved_elsewhere(1000.0, 8000.0, 30))  # the phone listened on
        self.assertTrue(pg.moved_elsewhere(8000.0, 1000.0, 30))  # the phone went back


CONN = types.SimpleNamespace(base_url="http://abs", token="t", is_primary=True, key="")
IDENTITY = types.SimpleNamespace(id=1)


def run(coro):
    return asyncio.run(coro)


class Handlers(unittest.TestCase):
    def setUp(self):
        self.saved = []
        self.closed = []
        patches = [
            mock.patch.object(play, "resolve", mock.AsyncMock(return_value=(CONN, "abs1"))),
            mock.patch.object(read, "resolve", mock.AsyncMock(return_value=(CONN, "abs1"))),
            mock.patch.object(play.activity, "record", mock.AsyncMock()),
            mock.patch.object(read.activity, "record", mock.AsyncMock()),
            mock.patch.object(play.abs_client, "sync_session", mock.AsyncMock(side_effect=lambda *a, **k: self.saved.append(k["current_time"]))),
            mock.patch.object(play.abs_client, "close_session", mock.AsyncMock(side_effect=lambda *a, **k: self.closed.append(k["current_time"]))),
            mock.patch.object(read.abs_client, "save_ebook_progress", mock.AsyncMock(side_effect=lambda *a, **k: self.saved.append(k["ebook_progress"]))),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def stored(self, **prog):
        for mod in (play, read):
            p = mock.patch.object(mod.abs_client, "get_progress", mock.AsyncMock(return_value=prog or None))
            p.start()
            self.addCleanup(p.stop)

    def sync(self, pos, known):
        body = play.SyncBody(sessionId="s", currentTimeS=pos, timeListenedS=15, durationS=36000, knownServerS=known)
        return run(play.sync("i", body, IDENTITY, mock.Mock(), None))

    def test_a_stale_tab_does_not_overwrite_the_phone(self):
        self.stored(currentTime=18000.0)  # the phone has listened on to 5 h
        out = self.sync(pos=3600.0, known=3590.0)  # this tab loaded the book at 1 h
        self.assertTrue(out["skipped"])
        self.assertEqual(out["serverTimeS"], 18000.0)
        self.assertEqual(self.saved, [])

    def test_our_own_position_is_saved(self):
        self.stored(currentTime=3600.0)
        out = self.sync(pos=3615.0, known=3600.0)
        self.assertNotIn("skipped", out)
        self.assertEqual(self.saved, [3615.0])

    def test_a_client_that_sends_nothing_known_behaves_as_before(self):
        self.stored(currentTime=18000.0)
        self.sync(pos=3600.0, known=None)
        self.assertEqual(self.saved, [3600.0])

    def test_an_unreadable_server_still_saves(self):
        with mock.patch.object(play.abs_client, "get_progress", mock.AsyncMock(side_effect=play.AbsError("down"))):
            self.sync(pos=3600.0, known=100.0)
        self.assertEqual(self.saved, [3600.0])

    def test_closing_a_stale_tab_closes_the_session_at_the_newer_place(self):
        self.stored(currentTime=18000.0)
        body = play.SyncBody(sessionId="s", currentTimeS=3600.0, timeListenedS=0, durationS=36000, knownServerS=3600.0)
        out = run(play.close("i", body, IDENTITY, mock.Mock(), None))
        self.assertTrue(out["skipped"])
        self.assertEqual(self.closed, [18000.0])

    def test_the_position_endpoint(self):
        self.stored(currentTime=1234.5, lastUpdate=99)
        self.assertEqual(run(play.audio_position("i", IDENTITY, mock.Mock())), {"currentTimeS": 1234.5, "updatedAt": 99})
        self.stored()
        self.assertEqual(run(play.audio_position("i", IDENTITY, mock.Mock()))["currentTimeS"], None)

    def read(self, progress, known):
        body = read.SavePositionBody(locator={"href": "x"}, progress=progress, knownProgress=known)
        return run(read.save_position("i", body, IDENTITY, mock.Mock()))

    def test_a_stale_reader_does_not_overwrite_the_other_device(self):
        self.stored(ebookProgress=0.62)
        out = self.read(progress=0.20, known=0.19)
        self.assertEqual(out, {"ok": True, "skipped": True, "progress": 0.62})
        self.assertEqual(self.saved, [])

    def test_page_turns_are_saved(self):
        self.stored(ebookProgress=0.200)
        self.read(progress=0.204, known=0.200)
        self.assertEqual(self.saved, [0.204])


if __name__ == "__main__":
    unittest.main()
