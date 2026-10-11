"""Read-along map versions: how Codex's /audex/align/maps answer is shaped for the frontend, and the Codex key header.
Run:  cd backend && python -m unittest discover -s tests -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app.api.readalong import _auth, _codex_detail, shape_maps, shape_version  # noqa: E402

CODEX = {
    "default": "20261007055100-aaaa",
    "mine": "20261011150000-bbbb",
    "can_manage": False,
    "versions": [
        {"id": "20261011150000-bbbb", "created_at": "2026-10-11T15:00:00+00:00", "source": "realign", "model": "medium",
         "device": "cuda", "anchors": 17591, "duration_s": 80521.0, "size": 6000000, "requested_by": "jonsj via Audex Web",
         "is_default": False, "is_mine": True},
        {"id": "20261007055100-aaaa", "created_at": "2026-10-07T05:51:00+00:00", "source": "initial", "model": "medium",
         "device": "cuda", "anchors": 17591, "duration_s": 80521.0, "size": 6000000, "requested_by": None,
         "is_default": True, "is_mine": False},
    ],
}


class Shaping(unittest.TestCase):
    def test_versions_become_camel_case_with_the_utc_date_kept(self):
        out = shape_maps(CODEX)
        self.assertEqual(out["default"], "20261007055100-aaaa")
        self.assertEqual(out["mine"], "20261011150000-bbbb")
        self.assertEqual(out["canManage"], False)
        self.assertEqual([v["id"] for v in out["versions"]], ["20261011150000-bbbb", "20261007055100-aaaa"])
        first = out["versions"][0]
        self.assertEqual(first["createdAt"], "2026-10-11T15:00:00+00:00")
        self.assertEqual(first["requestedBy"], "jonsj via Audex Web")
        self.assertTrue(first["isMine"] and not first["isDefault"])
        self.assertEqual(first["durationS"], 80521.0)

    def test_a_version_without_an_id_is_dropped(self):
        self.assertEqual(shape_maps({"versions": [{"created_at": "x"}]})["versions"], [])

    def test_an_empty_answer_is_an_empty_list(self):
        self.assertEqual(shape_maps({}), {"default": None, "mine": None, "versions": [], "canManage": False})

    def test_flags_default_to_false(self):
        v = shape_version({"id": "20261011150000-bbbb"})
        self.assertFalse(v["isDefault"] or v["isMine"])


class CodexKey(unittest.TestCase):
    def test_the_persons_key_is_sent_as_a_bearer_token(self):
        self.assertEqual(_auth("cdx_abc"), {"Authorization": "Bearer cdx_abc"})

    def test_no_key_sends_nothing(self):
        self.assertEqual(_auth(None), {})
        self.assertEqual(_auth(""), {})


class CodexWords(unittest.TestCase):
    def _resp(self, status, body, ctype="application/json"):
        return httpx.Response(status, content=body, headers={"content-type": ctype})

    def test_codexs_own_detail_is_passed_on(self):
        r = self._resp(401, b'{"detail": "Sign in to Codex to do this."}')
        self.assertEqual(_codex_detail(r, "fallback"), "Sign in to Codex to do this.")

    def test_anything_else_falls_back(self):
        self.assertEqual(_codex_detail(self._resp(500, b"oops", "text/plain"), "fallback"), "fallback")
        self.assertEqual(_codex_detail(self._resp(500, b'{"detail": ""}'), "fallback"), "fallback")
        self.assertEqual(_codex_detail(self._resp(500, b"{not json"), "fallback"), "fallback")


if __name__ == "__main__":
    unittest.main()
