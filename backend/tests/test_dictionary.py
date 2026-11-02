"""Dictionary: the two sources are flattened into one shape, and only real words are looked up (api/dictionary.py).
Run:  cd backend && python -m unittest discover -s tests -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.api import dictionary  # noqa: E402


class CleanWord(unittest.TestCase):
    def test_punctuation_and_case_are_dropped(self):
        self.assertEqual(dictionary.clean_word("  “Walked,” "), "walked")

    def test_a_curly_apostrophe_is_a_plain_one(self):
        self.assertEqual(dictionary.clean_word("don’t"), "don't")

    def test_a_hyphenated_word_and_a_short_phrase_pass(self):
        self.assertEqual(dictionary.clean_word("well-known"), "well-known")
        self.assertEqual(dictionary.clean_word("ad hoc"), "ad hoc")

    def test_things_that_are_not_words_are_refused(self):
        for bad in ("", "   ", "1234", "a1b", "$$$", "x" * 80, "<script>"):
            self.assertEqual(dictionary.clean_word(bad), "", bad)

    def test_accented_letters_are_words(self):
        self.assertEqual(dictionary.clean_word("Særlig"), "særlig")


class FromDictionaryApi(unittest.TestCase):
    DATA = [
        {
            "word": "run",
            "phonetic": "/ɹʌn/",
            "phonetics": [{"text": "/ɹʌn/", "audio": ""}, {"audio": "https://x/run.mp3"}],
            "meanings": [
                {"partOfSpeech": "verb", "definitions": [{"definition": "To move fast.", "example": "I run daily.", "synonyms": ["sprint"]}], "synonyms": ["race"]},
                {"partOfSpeech": "noun", "definitions": [{"definition": "An act of running."}], "synonyms": []},
            ],
        },
        {"word": "run", "meanings": [{"partOfSpeech": "verb", "definitions": [{"definition": "To operate."}]}]},
    ]

    def test_entries_are_merged_by_part_of_speech(self):
        out = dictionary.from_dictionaryapi(self.DATA)
        self.assertEqual([m["partOfSpeech"] for m in out["meanings"]], ["verb", "noun"])
        self.assertEqual([d["definition"] for d in out["meanings"][0]["definitions"]], ["To move fast.", "To operate."])
        self.assertEqual(out["meanings"][0]["definitions"][0]["example"], "I run daily.")
        self.assertEqual(out["meanings"][0]["synonyms"], ["race", "sprint"])

    def test_the_first_phonetic_and_audio_are_kept(self):
        out = dictionary.from_dictionaryapi(self.DATA)
        self.assertEqual(out["phonetic"], "/ɹʌn/")
        self.assertEqual(out["audio"], "https://x/run.mp3")

    def test_a_not_found_reply_is_none(self):
        self.assertIsNone(dictionary.from_dictionaryapi({"title": "No Definitions Found"}))
        self.assertIsNone(dictionary.from_dictionaryapi([]))

    def test_a_long_entry_is_cut_down(self):
        many = [{"partOfSpeech": "noun", "definitions": [{"definition": f"d{i}"} for i in range(20)]}]
        out = dictionary.from_dictionaryapi([{"meanings": many}])
        self.assertEqual(len(out["meanings"][0]["definitions"]), dictionary.MAX_DEFINITIONS)


class FromWiktionary(unittest.TestCase):
    DATA = {
        "en": [
            {
                "partOfSpeech": "Verb",
                "language": "English",
                "definitions": [
                    {
                        "definition": '<span class="x">simple <a href="/wiki/past">past</a></span> of <i>walk</i> &amp; more',
                        "parsedExamples": [{"example": "He <b>walked</b> home."}],
                    }
                ],
            }
        ]
    }

    def test_html_is_flattened(self):
        out = dictionary.from_wiktionary(self.DATA)
        self.assertEqual(out["meanings"][0]["partOfSpeech"], "verb")
        self.assertEqual(out["meanings"][0]["definitions"][0]["definition"], "simple past of walk & more")
        self.assertEqual(out["meanings"][0]["definitions"][0]["example"], "He walked home.")
        self.assertEqual(out["source"], "Wiktionary")

    def test_another_language_is_used_when_english_has_nothing(self):
        data = {"no": [{"partOfSpeech": "Noun", "language": "Norwegian Bokmål", "definitions": [{"definition": "a book"}]}]}
        out = dictionary.from_wiktionary(data)
        self.assertEqual(out["language"], "Norwegian Bokmål")

    def test_nothing_usable_is_none(self):
        self.assertIsNone(dictionary.from_wiktionary({}))
        self.assertIsNone(dictionary.from_wiktionary({"en": [{"partOfSpeech": "Noun", "definitions": []}]}))


if __name__ == "__main__":
    unittest.main()
