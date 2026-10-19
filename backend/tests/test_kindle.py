"""Kindle (AZW3 / KF8) reading: the decoder's primitives, a real small book, and the way each kind of
unreadable book is reported.
Run:  cd backend && python -m unittest discover -s tests -v
Set KINDLE_SAMPLE_DIR=/folder/of/books to also convert every .azw3/.azw/.mobi/.prc in it."""
import io
import os
import struct
import sys
import unittest
import zipfile
from xml.etree import ElementTree as ET

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.core import kindle  # noqa: E402
from app.core.epub import EpubError, build_manifest, parse_ebook  # noqa: E402

BOOK = os.path.join(os.path.dirname(__file__), "fixtures", "gift_of_the_magi.azw3")


def book_bytes() -> bytes:
    with open(BOOK, "rb") as f:
        return f.read()


class Primitives(unittest.TestCase):
    def test_base32_round_trip(self):
        for n in (0, 1, 31, 32, 1023, 123456789):
            self.assertEqual(kindle.from_base32(kindle.to_base32(n)), n)
        self.assertEqual(kindle.to_base32(35), "0013")
        self.assertEqual(kindle.from_base32("0000000010"), 32)

    def test_palmdoc_literals_pairs_and_back_references(self):
        # "abc", then copy 6 bytes from 3 back (an overlapping copy), then a space+'h' pair.
        data = b"\x03abc" + b"\x80\x1b" + b"\xe8"
        self.assertEqual(kindle.palmdoc_unpack(data), b"abcabcabc h")

    def test_palmdoc_ignores_a_reference_before_the_start(self):
        self.assertEqual(kindle.palmdoc_unpack(b"\x80\x1b" + b"\x01a"), b"a")

    def test_variable_width_numbers(self):
        self.assertEqual(kindle._variable_width(b"\x85", 0), (1, 5))
        self.assertEqual(kindle._variable_width(b"\x01\x80", 0), (2, 128))
        with self.assertRaises(kindle.KindleError):
            kindle._variable_width(b"\x01\x02", 0)

    def test_sniffing(self):
        self.assertTrue(kindle.is_kindle(book_bytes()[:68]))
        self.assertFalse(kindle.is_kindle(b"PK\x03\x04" + bytes(100)))
        self.assertFalse(kindle.is_kindle(b""))


def synthetic_huff_cdic() -> kindle.HuffCdic:
    """Every byte is an 8-bit code: byte b is dictionary phrase 255 - b. Phrase 3 is itself Huffman-packed
    (it spells phrases 0, 1, 2), which is how real books nest their dictionary."""
    entries = 256
    huff = bytearray(b"HUFF" + struct.pack(">III", 0x18, 24, 24 + 4 * entries))
    huff += bytes(24 - len(huff))
    for _ in range(entries):  # code length 8, terminal; the max code is 255 (so index = 255 - code)
        huff += struct.pack(">I", (255 << 8) | 0x80 | 8)
    huff += bytes(4 * 64)  # the table for longer codes: unused here
    phrases = [
        (b"Hello", True), (b", ", True), (b"world", True),
        (bytes([255, 254, 253]), False),  # = phrases 0, 1, 2, still packed
        (b"!", True),
    ]
    cdic = bytearray(b"CDIC" + struct.pack(">III", 0x10, len(phrases), 8))
    offsets, body = [], bytearray()
    for text, expanded in phrases:
        offsets.append(2 * len(phrases) + len(body))
        body += struct.pack(">H", len(text) | (0x8000 if expanded else 0)) + text
    for o in offsets:
        cdic += struct.pack(">H", o)
    cdic += body
    reader = kindle.HuffCdic()
    reader.load_huff(bytes(huff))
    reader.load_cdic(bytes(cdic))
    return reader


class Huffman(unittest.TestCase):
    def test_nested_phrases_are_expanded(self):
        reader = synthetic_huff_cdic()
        # phrase 3, phrase 4, phrase 4  ->  codes 252, 251, 251
        self.assertEqual(reader.unpack(bytes([252, 251, 251])), b"Hello, world!!")
        # a second run reuses the already-expanded phrase
        self.assertEqual(reader.unpack(bytes([252])), b"Hello, world")

    def test_damaged_dictionaries_are_reported(self):
        with self.assertRaises(kindle.KindleError):
            kindle.HuffCdic().load_huff(b"NOPE" + bytes(40))
        with self.assertRaises(kindle.KindleError):
            kindle.HuffCdic().load_cdic(b"NOPE" + bytes(40))


class RealBook(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.epub = kindle.to_epub_bytes(book_bytes())
        cls.zip = zipfile.ZipFile(io.BytesIO(cls.epub))

    def test_is_an_epub_package(self):
        names = self.zip.namelist()
        self.assertEqual(names[0], "mimetype")
        self.assertEqual(self.zip.read("mimetype"), b"application/epub+zip")
        self.assertIn("META-INF/container.xml", names)
        self.assertIn("OEBPS/content.opf", names)

    def test_every_page_and_package_file_is_well_formed(self):
        pages = 0
        for name in self.zip.namelist():
            if name.endswith((".xhtml", ".opf", ".ncx")):
                ET.fromstring(self.zip.read(name))
                pages += name.startswith("OEBPS/Text/part")
        self.assertGreaterEqual(pages, 5)

    def test_everything_in_the_manifest_exists(self):
        opf = ET.fromstring(self.zip.read("OEBPS/content.opf"))
        ns = {"o": "http://www.idpf.org/2007/opf"}
        for item in opf.findall(".//o:item", ns):
            self.assertIn("OEBPS/" + item.get("href"), self.zip.namelist())

    def test_reads_like_any_epub(self):
        pub = parse_ebook(book_bytes())
        self.assertEqual(pub.title, "The Gift of the Magi")
        self.assertEqual(pub.authors, ["O. Henry"])
        self.assertGreaterEqual(len(pub.spine_order), 5)
        self.assertEqual(pub.toc[0].title, "The Gift of the Magi")
        manifest = build_manifest(pub, self_url="http://x/api/read/i/res/manifest")
        self.assertEqual(len(manifest["readingOrder"]), len(pub.spine_order))
        first = manifest["readingOrder"][0]["href"]
        self.assertEqual(pub.media_type_for(first), "application/xhtml+xml")
        self.assertGreater(manifest["readingOrder"][1]["properties"]["audexChars"], 0)

    def test_the_story_text_survives(self):
        text = b" ".join(self.zip.read(n) for n in self.zip.namelist() if n.startswith("OEBPS/Text/part"))
        self.assertIn(b"One dollar and eighty-seven cents", text)

    def test_links_are_ordinary_files(self):
        everything = b"".join(self.zip.read(n) for n in self.zip.namelist() if n.startswith("OEBPS/Text/part"))
        self.assertNotIn(b"kindle:", everything)

    def test_the_cover_is_kept(self):
        opf = self.zip.read("OEBPS/content.opf").decode()
        self.assertIn('properties="cover-image"', opf)


class Unreadable(unittest.TestCase):
    def test_not_a_kindle_book(self):
        with self.assertRaises(kindle.KindleError) as cm:
            kindle.decode(b"hello" * 100)
        self.assertEqual(cm.exception.problem, "NOT_KINDLE")

    def test_drm(self):
        data = bytearray(book_bytes())
        first = kindle.PalmDb(bytes(data)).offsets[0]
        data[first + 0xC:first + 0xE] = b"\x00\x02"  # the "encrypted" field of the header
        with self.assertRaises(EpubError) as cm:
            parse_ebook(bytes(data))
        self.assertIn("DRM", str(cm.exception))

    def test_old_style_book_with_no_kf8_half(self):
        data = bytearray(book_bytes())
        first = kindle.PalmDb(bytes(data)).offsets[0]
        data[first + 0x24:first + 0x28] = struct.pack(">I", 6)  # MOBI 6, and no BOUNDARY record further on
        with self.assertRaises(kindle.KindleError) as cm:
            kindle.decode(bytes(data))
        self.assertEqual(cm.exception.problem, "UNSUPPORTED")
        self.assertIn("old-style", str(cm.exception))

    def test_truncated_book_is_reported_not_raised_as_a_crash(self):
        with self.assertRaises(EpubError) as cm:
            parse_ebook(book_bytes()[:40000])
        self.assertIn("incomplete", str(cm.exception))

    def test_epubs_still_go_through_unchanged(self):
        epub = kindle.to_epub_bytes(book_bytes())
        self.assertEqual(parse_ebook(epub).title, "The Gift of the Magi")
        with self.assertRaises(EpubError):
            parse_ebook(b"%PDF-1.7 not an epub")


@unittest.skipUnless(os.environ.get("KINDLE_SAMPLE_DIR"), "no KINDLE_SAMPLE_DIR given")
class WholeLibrary(unittest.TestCase):
    def test_every_book_converts_or_says_why(self):
        folder = os.environ["KINDLE_SAMPLE_DIR"]
        converted = refused = 0
        for name in sorted(os.listdir(folder)):
            if not name.lower().endswith((".azw3", ".azw", ".mobi", ".prc")):
                continue
            with open(os.path.join(folder, name), "rb") as f:
                data = f.read()
            try:
                z = zipfile.ZipFile(io.BytesIO(kindle.to_epub_bytes(data)))
            except kindle.KindleError:
                refused += 1
                continue
            for n in z.namelist():
                if n.endswith((".xhtml", ".opf", ".ncx")):
                    ET.fromstring(z.read(n))
            converted += 1
        print(f"converted {converted}, refused with a reason {refused}")


if __name__ == "__main__":
    unittest.main()
