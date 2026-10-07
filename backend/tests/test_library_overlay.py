"""The library views use Codex's corrected values: groups, cards, detail, the per-person switch, and the
edit being forwarded to Codex. Run: cd backend && python -m unittest discover -s tests -v"""
import asyncio
import os
import sys
import tempfile
import unittest

_tmp = tempfile.mkdtemp()
os.environ["DATABASE_URL"] = f"sqlite+aiosqlite:///{_tmp}/t.db"
os.environ["CODEX_URL"] = "http://codex.test"
os.environ["SECRET_KEY"] = "x" * 40
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.api import library as L  # noqa: E402
from app.api.connections import AbsConn  # noqa: E402
from app.core import codex_client  # noqa: E402
from app.core.database import AsyncSessionLocal, Identity, UserSettings, init_db  # noqa: E402
from app.core.security import encrypt_value  # noqa: E402

ABS_ITEMS = [
    {"id": "a1", "mediaType": "book", "media": {"numAudioFiles": 3, "metadata": {
        "title": "Jade City", "authors": [{"id": "au9", "name": "F. Lee"}], "authorName": "F. Lee",
        "publishedYear": "1999", "narrators": ["Wrong Narrator"]}}},
    {"id": "a2", "mediaType": "book", "media": {"numAudioFiles": 5, "metadata": {
        "title": "Untouched", "authors": [{"id": "au1", "name": "Real Author"}], "authorName": "Real Author"}}},
]
CODEX = {"a1": {"fields": {"author": "Fonda Lee", "series_name": "Green Bone Saga", "series_position": 1.0,
                           "year": 2017, "narrator": "Andrew Kishino"}, "edited": ["author"], "codex_id": 42}}


class Fake:
    pushed = []

    async def libraries(self, *a):
        return [{"id": "lib1", "mediaType": "book"}]

    async def library_items(self, *a):
        import copy
        return {"results": copy.deepcopy(ABS_ITEMS)}

    async def me(self, *a):
        return {"mediaProgress": []}


class Overlay(unittest.TestCase):
    def setUp(self):
        codex_client._reset_caches()
        self.conn = AbsConn(key="", name="ABS", base_url="http://abs", token="t", username="u", is_primary=True)
        self.fake = Fake()
        self._o = (L.abs_client.libraries, L.abs_client.library_items, L.abs_client.me,
                   L.connections_for_library, codex_client.fetch_meta, codex_client.push_edit)
        L.abs_client.libraries, L.abs_client.library_items, L.abs_client.me = self.fake.libraries, self.fake.library_items, self.fake.me

        async def pairs(identity, db, sel):
            return [(self.conn, None)]

        async def fetch(url, ids):
            return {i: CODEX[i] for i in ids if i in CODEX}

        async def push(url, token, cid, fields):
            Fake.pushed.append((cid, fields, token))
            return True

        L.connections_for_library, codex_client.fetch_meta, codex_client.push_edit = pairs, fetch, push
        Fake.pushed = []

    def tearDown(self):
        (L.abs_client.libraries, L.abs_client.library_items, L.abs_client.me,
         L.connections_for_library, codex_client.fetch_meta, codex_client.push_edit) = self._o

    def _run(self, coro_fn):
        async def go():
            await init_db()
            async with AsyncSessionLocal() as db:
                ident = Identity(display_name="t", codex_token_encrypted=encrypt_value("tok"))
                db.add(ident)
                await db.flush()
                return await coro_fn(ident, db)
        return asyncio.run(go())

    def test_groups_and_cards_use_codex_values(self):
        async def go(ident, db):
            triples = await L._iter_books(ident, db, "all")
            books = {b["title"]: b for _c, _i, b in triples}
            self.assertEqual(books["Jade City"]["author"], "Fonda Lee")
            self.assertEqual(books["Jade City"]["series"], "Green Bone Saga #1")
            self.assertEqual(books["Jade City"]["publishedYear"], "2017")
            self.assertEqual(books["Untouched"]["author"], "Real Author")        # not in Codex: exactly ABS
            series = await L.get_series("all", ident, db)
            self.assertEqual([(g["name"], [b["title"] for b in g["books"]]) for g in series],
                             [("Green Bone Saga", ["Jade City"])])
            authors = await L.get_authors("all", ident, db)
            self.assertEqual(sorted(a["name"] for a in authors), ["Fonda Lee", "Real Author"])
            narrators = await L.get_narrators("all", ident, db)
            self.assertIn("Andrew Kishino", [n["name"] for n in narrators])
        self._run(go)

    def test_person_can_switch_it_off(self):
        async def go(ident, db):
            db.add(UserSettings(identity_id=ident.id, use_codex_meta=False))
            await db.flush()
            books = {b["title"]: b for _c, _i, b in await L._iter_books(ident, db, "all")}
            self.assertEqual(books["Jade City"]["author"], "F. Lee")             # raw ABS again
        self._run(go)

    def test_codex_failure_leaves_abs_untouched(self):
        async def boom(url, ids):
            raise RuntimeError("codex exploded")
        codex_client.fetch_meta = boom

        async def go(ident, db):
            books = {b["title"]: b for _c, _i, b in await L._iter_books(ident, db, "all")}
            self.assertEqual(books["Jade City"]["author"], "F. Lee")
        self._run(go)

    def test_edit_is_forwarded_to_codex(self):
        async def go(ident, db):
            state = await L._forward_to_codex(ident, db, "a1", {
                "authors": [{"name": "Fonda Lee"}], "series": [{"name": "Green Bone Saga", "sequence": "2"}], "asin": "B0"})
            self.assertEqual(state, "ok")
            self.assertEqual(Fake.pushed, [(42, {"author": "Fonda Lee", "series_name": "Green Bone Saga",
                                                 "series_position": 2.0}, "tok")])
            self.assertEqual(await L._forward_to_codex(ident, db, "a2", {"title": "x"}), "not-in-codex")
            self.assertEqual(await L._forward_to_codex(ident, db, "a1", {"asin": "B0"}), "ok")
            ident.codex_token_encrypted = None
            self.assertEqual(await L._forward_to_codex(ident, db, "a1", {"title": "x"}), "not-linked")
        self._run(go)


if __name__ == "__main__":
    unittest.main()
