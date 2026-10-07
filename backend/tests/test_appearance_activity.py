import os
import sys
import tempfile
import unittest

# Same setup as the other test modules: whichever imports `app` first fixes the database URL for the run.
os.environ.setdefault("DATABASE_URL", f"sqlite+aiosqlite:///{tempfile.mkdtemp()}/t.db")
os.environ.setdefault("CODEX_URL", "http://codex.test")
os.environ.setdefault("SECRET_KEY", "x" * 40)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import httpx  # noqa: E402

from app.api.settings import clean_appearance  # noqa: E402
from app.core import activity  # noqa: E402


class AppearanceModel(unittest.TestCase):
    def test_defaults(self):
        self.assertEqual(clean_appearance(None), {
            "fontSizePt": 12, "theme": "auto", "font": "publisher", "fontName": "", "lineSpacing": None,
            "paragraphSpacing": None, "letterSpacing": None, "wordSpacing": None,
            "textColor": "#1a1a1a", "backgroundColor": "#ffffff"})

    def test_points_are_clamped_and_rounded(self):
        self.assertEqual(clean_appearance({"fontSizePt": 200})["fontSizePt"], 48)
        self.assertEqual(clean_appearance({"fontSizePt": 2})["fontSizePt"], 9)
        self.assertEqual(clean_appearance({"fontSizePt": "14.4"})["fontSizePt"], 14)

    def test_old_percent_saves_convert_to_points(self):
        self.assertEqual(clean_appearance({"fontSize": 100})["fontSizePt"], 12)   # normal stays normal
        self.assertEqual(clean_appearance({"fontSize": 150})["fontSizePt"], 18)
        self.assertEqual(clean_appearance(None, 125)["fontSizePt"], 15)           # legacy column value

    def test_junk_is_replaced(self):
        c = clean_appearance({"theme": "neon", "font": "comic", "textColor": "red", "backgroundColor": "#12345"})
        self.assertEqual((c["theme"], c["font"], c["textColor"], c["backgroundColor"]), ("auto", "publisher", "#1a1a1a", "#ffffff"))

    def test_fonts_and_spacing(self):
        c = clean_appearance({"font": "georgia", "fontName": "x", "lineSpacing": "1.8", "paragraphSpacing": 9,
                              "letterSpacing": "", "wordSpacing": None})
        self.assertEqual((c["font"], c["lineSpacing"], c["paragraphSpacing"], c["letterSpacing"], c["wordSpacing"]),
                         ("georgia", 1.8, 2.0, None, None))   # clamped to the shared ranges; empty/None = the book's own
        self.assertEqual(clean_appearance({"lineSpacing": 0.2})["lineSpacing"], 1.0)
        self.assertEqual(clean_appearance({"letterSpacing": 5})["letterSpacing"], 0.5)

    def test_custom_font_name_must_be_safe(self):
        self.assertEqual(clean_appearance({"font": "custom", "fontName": "  Comic Sans MS "})["fontName"], "Comic Sans MS")
        for bad in ("bad;name{}", "a" * 61, "", "x\ny"):
            self.assertEqual(clean_appearance({"font": "custom", "fontName": bad})["fontName"], "")

    def test_defaults_leave_spacing_and_font_alone(self):
        d = clean_appearance(None)
        self.assertEqual((d["font"], d["fontName"], d["lineSpacing"], d["paragraphSpacing"], d["letterSpacing"], d["wordSpacing"]),
                         ("publisher", "", None, None, None, None))

    def test_custom_colours_kept(self):
        c = clean_appearance({"theme": "custom", "textColor": "#ABCDEF", "backgroundColor": "#102030"})
        self.assertEqual((c["theme"], c["textColor"], c["backgroundColor"]), ("custom", "#ABCDEF", "#102030"))


class ErrorWording(unittest.TestCase):
    def test_status_hints(self):
        self.assertIn("token", activity.describe_status(401))
        self.assertIn("404", activity.describe_status(404))
        self.assertIn("server had an error", activity.describe_status(502))

    def test_network_errors_name_the_cause(self):
        self.assertIn("timed out", activity.describe_error(httpx.ConnectTimeout("x")))
        self.assertIn("DNS", activity.describe_error(httpx.ConnectError("[Errno -2] Name or service not known")))
        self.assertIn("refused", activity.describe_error(httpx.ConnectError("All connection attempts failed: Connection refused")))
        self.assertIn("certificate", activity.describe_error(httpx.ConnectError("SSL: CERTIFICATE_VERIFY_FAILED")))


if __name__ == "__main__":
    unittest.main()
