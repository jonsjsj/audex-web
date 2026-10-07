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


class SameCasesAsAudex(unittest.TestCase):
    """The behaviours in Audex's GraphBuilderTest — Webdex should merge what Audex merges."""

    def test_series_and_volume_recovered_from_a_bare_title(self):
        a = mk("a", "Dungeon Crawler Carl Book 3", ["Matt Dinniman"], audio=True)
        e = mk("e", "The Dungeon Anarchist's Cookbook", ["Matt Dinniman"], ebook=True, series=("Dungeon Crawler Carl", "3"))
        self.assertEqual(paired([e, a]), "a")

    def test_same_series_different_volumes_never_join(self):
        a = mk("a", "Unsouled", ["Will Wight"], audio=True, series=("Cradle", "1"))
        e = mk("e", "Soulsmith", ["Will Wight"], ebook=True, series=("Cradle", "2"))
        self.assertIsNone(paired([e, a]))

    def test_subtitle_variants_join(self):
        self.assertEqual(paired([mk("e", "Warbreaker", ["Brandon Sanderson"], ebook=True),
                                 mk("a", "Warbreaker: A Novel of the Cosmere", ["Brandon Sanderson"], audio=True)]), "a")

    def test_asin_on_one_and_isbn_on_the_other_fall_through_to_the_title(self):
        e = mk("e", "The Way of Kings", ["Brandon Sanderson"], ebook=True)
        e["meta"]["isbn"] = "9780765326355"
        a = mk("a", "The Way of Kings", ["Brandon Sanderson"], audio=True, asin="B003ZWFO7E")
        self.assertEqual(paired([e, a]), "a")

    def test_omnibus_never_matches_a_single_volume(self):
        a = mk("a", "Cradle: Foundation (Books 1\u20133)", ["Will Wight"], audio=True)
        e = mk("e", "Unsouled (Cradle #1)", ["Will Wight"], ebook=True, series=("Cradle", "1"))
        self.assertIsNone(paired([e, a]))

    def test_the_ebook_has_no_series_and_a_different_author_spelling(self):
        # Your He Who Fights with Monsters 13: the audiobook carries the series; the ebook only has it in its title,
        # and the two list different author names (pen name vs real name).
        e = mk("e", "He Who Fights with Monsters 13: A LitRPG Adventure", ["Travis Deverell"], ebook=True)
        a = mk("a", "He Who Fights with Monsters 13: A LitRPG Adventure: He Who Fights with Monsters, Book 13",
               ["Shirtaloon"], audio=True, series=("He Who Fights with Monsters", "13"))
        self.assertEqual(paired([e, a]), "a")

    def test_the_neighbouring_volume_is_not_picked_up(self):
        e = mk("e", "He Who Fights with Monsters 12: A LitRPG Adventure", ["Travis Deverell"], ebook=True)
        a = mk("a", "He Who Fights with Monsters 13: A LitRPG Adventure", ["Travis Deverell"], audio=True,
               series=("He Who Fights with Monsters", "13"))
        self.assertIsNone(paired([e, a]))


class CodexMergesCarryOver(unittest.TestCase):
    """Codex reports which Audiobookshelf items it merged into one work (`editions`); Webdex follows it."""

    def _triples(self):
        from app.api.connections import AbsConn
        conn = AbsConn(key="", base_url="http://abs", token="t", username="u", name="abs", is_primary=True)

        def item(id_, title, author, *, ebook, audio, editions=None):
            meta = {"title": title, "authors": [{"name": author}], "authorName": author}
            if editions:
                meta["_codexEditions"] = editions
            media = {"metadata": meta, "numAudioFiles": 3 if audio else 0, "ebookFormat": "epub" if ebook else None}
            raw = {"id": id_, "mediaType": "book", "media": media}
            book = {"id": id_, "title": title, "subtitle": None, "numAudioFiles": media["numAudioFiles"],
                    "hasEbook": ebook, "pairedItemId": None}
            return conn, raw, book

        # Nothing in the metadata says these are the same book — only Codex's merge does.
        return [item("e1", "Wizard's Tale", "J. Doe", ebook=True, audio=False, editions=["a1"]),
                item("a1", "Das Zauberbuch", "Someone Else", ebook=False, audio=True, editions=["e1"])]

    def test_a_merge_made_in_codex_pairs_the_editions(self):
        from app.api.library import _run_pairing
        triples = self._triples()
        _run_pairing(triples)
        self.assertEqual(triples[0][2]["pairedItemId"], "a1")
        self.assertEqual(triples[1][2]["pairedItemId"], "e1")

    def test_your_own_split_still_wins(self):
        from app.api.library import _run_pairing
        triples = self._triples()
        _run_pairing(triples, (frozenset(), frozenset({frozenset(("e1", "a1"))})))
        self.assertIsNone(triples[0][2]["pairedItemId"])

    def test_overlay_keeps_the_editions_even_without_fields(self):
        item = {"id": "e1", "media": {"metadata": {"title": "T"}}}
        self.assertTrue(overlay_item(item, {"fields": {}, "editions": ["a1"], "codex_id": 5}))
        self.assertEqual(item["media"]["metadata"]["_codexEditions"], ["a1"])


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

    def test_a_split_beats_a_codex_merge(self):
        e = mk("e", "Wizard's Tale", ["J. Doe"], ebook=True)
        a = mk("a", "Das Zauberbuch", ["Someone Else"], audio=True)
        pair = frozenset(("e", "a"))
        self.assertIsNone(paired([e, a], joins=frozenset({pair}), splits=frozenset({pair})))

    def test_a_split_is_never_paired_automatically(self):
        e = mk("e", "Dune", ["Frank Herbert"], ebook=True)
        a = mk("a", "Dune", ["Frank Herbert"], audio=True)
        self.assertIsNone(paired([e, a], splits=frozenset({frozenset(("e", "a"))})))


if __name__ == "__main__":
    unittest.main()
