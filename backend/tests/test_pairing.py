"""Pairing an ebook with its audiobook (core/catalog_match.py) — including the cases that went wrong in real
libraries, and the person's own joins/separations that must stick."""
import os
import sys
import tempfile
import unittest

os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{tempfile.mkdtemp()}/t.db")
os.environ.setdefault("SECRET_KEY", "x" * 40)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core.catalog_match import pair_dual_format  # noqa: E402
from app.core.codex_overlay import overlay_item  # noqa: E402


def mk(id, title, authors, *, ebook=False, audio=False, asin=None, series=None, subtitle=None):
    book = {"id": id, "title": title, "subtitle": subtitle, "numAudioFiles": 3 if audio else 0,
            "hasEbook": ebook, "pairedItemId": None}
    meta = {"authors": [{"name": a} for a in authors], "asin": asin}
    if series:
        meta["series"] = [{"name": series[0], "sequence": series[1]}]
    return {"book": book, "meta": meta}


def paired(entries, **kw):
    pair_dual_format(entries, **kw)
    return entries[0]["book"]["pairedItemId"]


class AutomaticMatching(unittest.TestCase):
    def test_same_work_listed_differently(self):
        e = mk("e", "He Who Fights with Monsters 13: A LitRPG Adventure", ["Deverell, Travis", "Shirtaloon"], ebook=True)
        a = mk("a", "He Who Fights with Monsters 13: A LitRPG Adventure: He Who Fights with Monsters, Book 13",
               ["Shirtaloon", "Travis Deverell"], audio=True, series=("He Who Fights with Monsters", "13"))
        self.assertEqual(paired([e, a]), "a")

    def test_kindle_and_audible_asin_may_differ(self):
        self.assertEqual(paired([mk("e", "Dune", ["Frank Herbert"], ebook=True, asin="B000KINDLE"),
                                 mk("a", "Dune", ["Frank Herbert"], audio=True, asin="B000AUDIBL")]), "a")

    def test_different_books_are_not_paired(self):
        for e, a in (
            (mk("e", "Dune", ["Frank Herbert"], ebook=True), mk("a", "Dune Messiah", ["Frank Herbert"], audio=True)),
            (mk("e", "Mistborn: The Final Empire", ["Brandon Sanderson"], ebook=True),
             mk("a", "Mistborn: The Well of Ascension", ["Brandon Sanderson"], audio=True)),
            (mk("e", "He Who Fights with Monsters 12", ["Shirtaloon"], ebook=True),
             mk("a", "He Who Fights with Monsters 13", ["Shirtaloon"], audio=True)),
        ):
            self.assertIsNone(paired([e, a]), e["book"]["title"])

    def test_codex_corrected_author_on_one_edition_does_not_split_the_pair(self):
        # Codex renames the ebook's author to the pen name only; Audiobookshelf still lists the real names on the audio.
        ebook_item = {"id": "e", "media": {"metadata": {"title": "Wizard Tale", "authors": [{"name": "Jane Doe"}], "authorName": "Jane Doe"}}}
        overlay_item(ebook_item, {"fields": {"author": "J. D. Pen"}})
        e = {"book": {"id": "e", "title": "Wizard Tale", "subtitle": None, "numAudioFiles": 0, "hasEbook": True, "pairedItemId": None},
             "meta": ebook_item["media"]["metadata"]}
        a = mk("a", "Wizard Tale", ["Jane Doe"], audio=True)
        self.assertEqual(paired([e, a]), "a")


class YourOwnDecisionsStick(unittest.TestCase):
    def test_a_join_pairs_books_the_metadata_cannot(self):
        e = mk("e", "Wizard's Tale", ["J. Doe"], ebook=True)
        a = mk("a", "Das Zauberbuch", ["Someone Else"], audio=True)
        self.assertIsNone(paired([e, a]))
        e, a = mk("e", "Wizard's Tale", ["J. Doe"], ebook=True), mk("a", "Das Zauberbuch", ["Someone Else"], audio=True)
        self.assertEqual(paired([e, a], joins=frozenset({frozenset(("e", "a"))})), "a")
        self.assertEqual(a["book"]["pairedItemId"], "e")

    def test_a_join_wins_over_a_better_automatic_match(self):
        e = mk("e", "Dune", ["Frank Herbert"], ebook=True)
        auto = mk("auto", "Dune", ["Frank Herbert"], audio=True)
        chosen = mk("chosen", "Anything Else", ["Other Person"], audio=True)
        self.assertEqual(paired([e, auto, chosen], joins=frozenset({frozenset(("e", "chosen"))})), "chosen")

    def test_a_split_is_never_paired_automatically(self):
        e = mk("e", "Dune", ["Frank Herbert"], ebook=True)
        a = mk("a", "Dune", ["Frank Herbert"], audio=True)
        self.assertIsNone(paired([e, a], splits=frozenset({frozenset(("e", "a"))})))


if __name__ == "__main__":
    unittest.main()
