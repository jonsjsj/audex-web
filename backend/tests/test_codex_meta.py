"""Codex checked-metadata integration: overlay rule, caching/chunking, failure tolerance, edit translation.
Run:  cd backend && python -m unittest discover -s tests -v"""
import asyncio
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core import codex_client as cc  # noqa: E402
from app.core.codex_overlay import overlay_item  # noqa: E402


def abs_item(**meta):
    return {"id": "a1", "media": {"metadata": dict(meta)}}


class OverlayRule(unittest.TestCase):
    def test_missing_key_keeps_abs(self):
        it = abs_item(title="ABS title", authors=[{"id": "au1", "name": "Wrong Author"}], publishedYear="1999")
        overlay_item(it, {"fields": {"series_name": "Saga"}, "edited": []})
        m = it["media"]["metadata"]
        self.assertEqual(m["title"], "ABS title")
        self.assertEqual(m["authors"], [{"id": "au1", "name": "Wrong Author"}])
        self.assertEqual(m["publishedYear"], "1999")
        self.assertEqual(m["series"], [{"name": "Saga", "sequence": ""}])

    def test_present_key_wins_and_keeps_author_id(self):
        it = abs_item(authors=[{"id": "au1", "name": "Fonda Lee"}], authorName="Fonda Lee")
        overlay_item(it, {"fields": {"author": "Fonda Lee, Co Author", "year": 2017, "series_name": "Green Bone",
                                     "series_position": 1.0, "narrator": "A B, C D"}, "edited": ["author"]})
        m = it["media"]["metadata"]
        self.assertEqual(m["authors"], [{"id": "au1", "name": "Fonda Lee"}, {"name": "Co Author"}])
        self.assertEqual(m["authorName"], "Fonda Lee, Co Author")
        self.assertEqual(m["publishedYear"], "2017")
        self.assertEqual(m["series"], [{"name": "Green Bone", "sequence": "1"}])
        self.assertEqual(m["seriesName"], "Green Bone #1")
        self.assertEqual(m["narrators"], ["A B", "C D"])

    def test_edited_does_not_change_precedence_and_empty_entry_is_noop(self):
        a, b = abs_item(title="x"), abs_item(title="x")
        overlay_item(a, {"fields": {"title": "T"}, "edited": ["title"]})
        overlay_item(b, {"fields": {"title": "T"}, "edited": []})
        self.assertEqual(a["media"]["metadata"]["title"], b["media"]["metadata"]["title"], "T")
        self.assertFalse(overlay_item(abs_item(title="x"), None))
        self.assertFalse(overlay_item(abs_item(title="x"), {"fields": {}, "edited": []}))


class FakeResp:
    def __init__(self, status=200, data=None):
        self.status_code, self._d = status, data or {}

    def json(self):
        return self._d

    def raise_for_status(self):
        if self.status_code >= 400:
            raise cc.httpx.HTTPStatusError("x", request=None, response=None)


class FakeClient:
    posts: list = []
    fail = False
    meta_flag = True

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        pass

    async def get(self, url, **k):
        if FakeClient.fail:
            raise cc.httpx.ConnectError("down")
        return FakeResp(200, {"meta_via_codex": FakeClient.meta_flag})

    async def post(self, url, json=None, **k):
        if FakeClient.fail:
            raise cc.httpx.ConnectError("down")
        FakeClient.posts.append(list(json["ids"]))
        return FakeResp(200, {"items": {i: {"fields": {"title": f"T-{i}"}, "edited": [], "codex_id": 1}
                                        for i in json["ids"] if i != "unknown"}})


class Fetch(unittest.TestCase):
    def setUp(self):
        cc._reset_caches()
        FakeClient.posts, FakeClient.fail, FakeClient.meta_flag = [], False, True
        self._orig = cc.httpx.AsyncClient
        cc.httpx.AsyncClient = FakeClient

    def tearDown(self):
        cc.httpx.AsyncClient = self._orig

    def run_(self, coro):
        return asyncio.run(coro)

    def test_chunks_of_200_and_caches(self):
        ids = [f"i{n}" for n in range(450)]
        got = self.run_(cc.fetch_meta("http://codex", ids))
        self.assertEqual([len(p) for p in FakeClient.posts], [200, 200, 50])
        self.assertEqual(len(got), 450)
        self.run_(cc.fetch_meta("http://codex", ids))
        self.assertEqual(len(FakeClient.posts), 3, "second call is served from the cache")

    def test_unknown_ids_absent_and_negative_cached(self):
        got = self.run_(cc.fetch_meta("http://codex", ["a", "unknown"]))
        self.assertEqual(set(got), {"a"})
        self.run_(cc.fetch_meta("http://codex", ["unknown"]))
        self.assertEqual(len(FakeClient.posts), 1)

    def test_codex_down_or_old_or_unset_is_silent(self):
        FakeClient.fail = True
        self.assertEqual(self.run_(cc.fetch_meta("http://codex", ["a"])), {})
        cc._reset_caches(); FakeClient.fail, FakeClient.meta_flag = False, False   # older Codex: no flag
        self.assertEqual(self.run_(cc.fetch_meta("http://codex", ["a"])), {})
        self.assertEqual(self.run_(cc.fetch_meta("", ["a"])), {})

    def test_failure_returns_stale_cache(self):
        self.run_(cc.fetch_meta("http://codex", ["a"]))
        cc._meta_cache["a"] = (0, cc._meta_cache["a"][1])      # expire it
        FakeClient.fail = True
        self.assertEqual(set(self.run_(cc.fetch_meta("http://codex", ["a"]))), {"a"})


class EditTranslation(unittest.TestCase):
    def test_abs_payload_to_codex_fields(self):
        f = cc.codex_fields_from_abs_metadata({
            "title": "T", "authors": [{"name": "A"}, {"name": "B"}], "narrators": ["N1", "N2"],
            "series": [{"name": "S", "sequence": "2.5"}], "asin": "x", "subtitle": "y"})
        self.assertEqual(f, {"title": "T", "author": "A, B", "narrator": "N1, N2",
                             "series_name": "S", "series_position": 2.5})
        self.assertEqual(cc.codex_fields_from_abs_metadata({"asin": "x", "isbn": "y"}), {})
        self.assertEqual(cc.codex_fields_from_abs_metadata({"series": []}), {"series_name": "", "series_position": ""})

    def test_publisher_and_year_reach_codex(self):
        self.assertEqual(cc.codex_fields_from_abs_metadata({"publisher": "P", "publishedYear": "2020"}),
                         {"studio": "P", "year": "2020"})
        # what Codex doesn't track stays Audiobookshelf-only
        self.assertEqual(cc.codex_fields_from_abs_metadata({"description": "d", "genres": ["g"], "language": "en"}), {})


class SyncNowClearsCache(unittest.TestCase):
    def test_forget_all_meta_empties_every_cache(self):
        cc._meta_cache["a"] = (0.0, {"x": 1})
        cc._config_cache["http://codex"] = (0.0, True)
        cc._down_until["http://codex"] = 9e12
        cc.forget_all_meta()
        self.assertFalse(cc._meta_cache or cc._config_cache or cc._down_until)


if __name__ == "__main__":
    unittest.main()
