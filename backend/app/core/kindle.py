"""Kindle (AZW3 / KF8) -> EPUB, in pure Python.

A port of the decoder Audex (the Android app) reads Kindle books with, so Webdex opens the
same files. A Kindle file is a Palm database: a table of records holding a header, the
compressed book text, a few index tables (skeleton / fragment / contents) and the images
and fonts. The text is stored as page "skeletons" plus "fragments" that must be inserted
back into them, with links written as kindle:pos / kindle:embed / kindle:flow references.
This puts the pages back together, turns those references into ordinary file links, and
writes the result as an EPUB 3 package, which epub.py then serves to the reader like any
other EPUB. Nothing is written to disk.

The markup is handled as text where ONE CHARACTER IS ONE BYTE (ISO-8859-1), so regex
positions are byte offsets — which is what the format's position tables use — and UTF-8
content passes through untouched. Every regex is ASCII-only for the same reason.

Not supported, and said so plainly: books protected by DRM, print-replica / fixed-layout
books, and old MOBI 6 files that have no KF8 half.
"""
from __future__ import annotations

import io
import re
import zipfile
import zlib
from dataclasses import dataclass, field

NONE = 0xFFFFFFFF  # "no value" in the many 32-bit index fields of a Kindle header


class KindleError(Exception):
    """Why a Kindle book could not be turned into something readable. The message is
    written to be shown to the reader as-is. `problem` is NOT_KINDLE, DRM, UNSUPPORTED
    or CORRUPT."""

    def __init__(self, problem: str, message: str):
        super().__init__(message)
        self.problem = problem


# ---------------------------------------------------------------------------- bytes

def u8(d: bytes, o: int) -> int:
    return d[o]


def u16(d: bytes, o: int) -> int:
    return (d[o] << 8) | d[o + 1]


def u32(d: bytes, o: int) -> int:
    return (d[o] << 24) | (d[o + 1] << 16) | (d[o + 2] << 8) | d[o + 3]


def u64(d: bytes, o: int) -> int:
    return int.from_bytes(d[o:o + 8], "big")


def latin1(d: bytes, start: int = 0, end: int | None = None) -> str:
    return d[start:end].decode("latin-1")


_BASE32 = "0123456789ABCDEFGHIJKLMNOPQRSTUV"


def from_base32(text: str) -> int:
    """Kindle's base-32 numbers (digits 0-9 then A-V), as used in
    `kindle:pos:fid:0001:off:0000000000`."""
    value = 0
    scale = 1
    for j, c in enumerate(reversed(text)):
        v = int(c) if "0" <= c <= "9" else ord(c.upper()) - ord("A") + 10
        if j < 8:  # the format only ever uses 8 digits; longer ones are zero padding
            value += v * scale
        scale *= 32
    return value


def to_base32(value: int, pad: int = 4) -> str:
    out = ""
    while value:
        out = _BASE32[value % 32] + out
        value //= 32
    return out.rjust(max(pad, 1), "0")


def _clamp(v: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, v))


def is_kindle(head: bytes) -> bool:
    """Whether [head] (the first 68+ bytes of a file) is a Kindle / Mobipocket book."""
    return len(head) >= 68 and head[60:68] == b"BOOKMOBI"


# ---------------------------------------------------------------------- decompression

def palmdoc_unpack(data: bytes) -> bytes:
    """PalmDOC LZ77: literals, space+char pairs, and (distance, length) copies from what
    was already produced."""
    out = bytearray()
    p = 0
    n = len(data)
    while p < n:
        c = data[p]
        p += 1
        if 1 <= c <= 8:  # that many literal bytes follow
            out += data[p:p + c]
            p += c
        elif c < 128:
            out.append(c)
        elif c >= 192:
            out.append(0x20)
            out.append(c ^ 128)
        else:  # a back-reference: 11 bits of distance, 3 bits of length
            if p >= n:
                break
            c = (c << 8) | data[p]
            p += 1
            distance = (c >> 3) & 0x07FF
            length = (c & 7) + 3
            if distance == 0 or distance > len(out):
                continue
            if distance >= length:
                start = len(out) - distance
                out += out[start:start + length]
            else:  # overlapping copy repeats the last `distance` bytes
                for _ in range(length):
                    out.append(out[-distance])
    return bytes(out)


class HuffCdic:
    """Huffman/CDIC compression (type 17480, used by many Amazon books): a Huffman code
    whose symbols are indexes into a phrase dictionary, which can itself refer to other
    (compressed) phrases."""

    def __init__(self) -> None:
        self.code_len = [0] * 256
        self.terminal = [False] * 256
        self.max_code1 = [0] * 256
        self.min_code = [0] * 33
        self.max_code = [0] * 33
        self.dictionary: list[list | None] = []  # [bytes, expanded]

    def load_huff(self, huff: bytes) -> None:
        if len(huff) < 16 or huff[:4] != b"HUFF" or u32(huff, 4) != 0x18:
            raise KindleError("CORRUPT", "The book's text dictionary (HUFF) is damaged.")
        off1 = u32(huff, 8)
        off2 = u32(huff, 12)
        for i in range(256):
            v = u32(huff, off1 + 4 * i)
            ln = v & 0x1F
            self.code_len[i] = ln
            self.terminal[i] = (v & 0x80) != 0
            raw = v >> 8
            self.max_code1[i] = 0 if ln == 0 else ((raw + 1) << (32 - ln)) - 1
        for ln in range(1, 33):
            mn = u32(huff, off2 + 4 * (2 * (ln - 1)))
            mx = u32(huff, off2 + 4 * (2 * (ln - 1) + 1))
            self.min_code[ln] = mn << (32 - ln)
            self.max_code[ln] = ((mx + 1) << (32 - ln)) - 1

    def load_cdic(self, cdic: bytes) -> None:
        if len(cdic) < 16 or cdic[:4] != b"CDIC" or u32(cdic, 4) != 0x10:
            raise KindleError("CORRUPT", "The book's text dictionary (CDIC) is damaged.")
        phrases = u32(cdic, 8)
        bits = u32(cdic, 12)
        n = min(1 << bits, phrases - len(self.dictionary))
        for i in range(n):
            off = u16(cdic, 16 + 2 * i)
            blen = u16(cdic, 16 + off)
            ln = blen & 0x7FFF
            self.dictionary.append([cdic[18 + off:18 + off + ln], (blen & 0x8000) != 0])

    def unpack(self, data: bytes) -> bytes:
        out = bytearray()
        bits_left = len(data) * 8
        padded = data + bytes(8)
        pos = 0
        x = u64(padded, pos)
        n = 32
        code_len, terminal, max_code1 = self.code_len, self.terminal, self.max_code1
        min_code, max_code, dictionary = self.min_code, self.max_code, self.dictionary
        while True:
            if n <= 0:
                pos += 4
                if pos + 8 > len(padded):
                    break
                x = u64(padded, pos)
                n += 32
            code = (x >> n) & 0xFFFFFFFF
            top = code >> 24
            ln = code_len[top]
            maxc = max_code1[top]
            if not terminal[top]:
                while ln < 32 and code < min_code[ln]:
                    ln += 1
                maxc = max_code[ln]
            if ln == 0:
                break
            n -= ln
            bits_left -= ln
            if bits_left < 0:
                break
            r = ((((maxc - code) & 0xFFFFFFFFFFFFFFFF) >> (32 - ln)) & 0xFFFFFFFF)
            phrase = dictionary[r] if r < len(dictionary) else None
            if phrase is None:
                break
            if not phrase[1]:
                # A phrase may be made of other phrases: expand it once, then keep the expanded form.
                dictionary[r] = None  # guards against a phrase that (corruptly) contains itself
                expanded = self.unpack(phrase[0])
                dictionary[r] = [expanded, True]
                out += expanded
            else:
                out += phrase[0]
        return bytes(out)


# ------------------------------------------------------------------------- palm db

class PalmDb:
    """The Palm database a Kindle book is stored in: a table of records (called sections)."""

    def __init__(self, data: bytes):
        if len(data) < 80:
            raise KindleError("NOT_KINDLE", "This isn't a Kindle book.")
        self.data = data
        ident = latin1(data, 60, 68)
        self.count = u16(data, 76)
        if ident != "BOOKMOBI" or self.count < 2 or 78 + 8 * self.count > len(data):
            raise KindleError("NOT_KINDLE", "This isn't a Kindle book.")
        self.offsets = [u32(data, 78 + 8 * i) for i in range(self.count)]
        if max(self.offsets) > len(data):
            raise KindleError("CORRUPT", "This Kindle book is incomplete (the file ends too early).")
        self.offsets.append(len(data))

    def section(self, i: int) -> bytes:
        if i < 0 or i >= self.count:
            raise KindleError("CORRUPT", f"The book refers to a missing part ({i}).")
        start = self.offsets[i]
        return self.data[start:max(start, self.offsets[i + 1])]

    def find_kf8_boundary(self) -> int:
        """The 8-byte "BOUNDARY" record that separates the old (MOBI 6) half of a combined
        book from its KF8 half."""
        for i in range(self.count):
            if self.offsets[i + 1] - self.offsets[i] == 8 and self.data[self.offsets[i]:self.offsets[i] + 8] == b"BOUNDARY":
                return i
        return -1


class MobiHeader:
    """The header record of one book (a combined file has two: MOBI 6 first, then KF8)."""

    def __init__(self, db: PalmDb, start: int):
        self.db = db
        self.start = start
        rec = self.record = db.section(start)
        if len(rec) < 0x80 or latin1(rec, 16, 20) != "MOBI":
            raise KindleError("UNSUPPORTED", "This Kindle book has a layout Webdex can't read yet.")
        self.compression = u16(rec, 0)
        self.records = u16(rec, 8)
        self.encrypted = u16(rec, 0xC) != 0
        self.header_length = u32(rec, 0x14)
        self.codepage = u32(rec, 0x1C)
        self.unique_id = u32(rec, 0x20)
        self.version = u32(rec, 0x24)
        self.codec = "utf-8" if self.codepage == 65001 else "cp1252"

        def optional(off: int) -> int:
            return u32(rec, off) if len(rec) >= off + 4 else NONE

        def absolute(v: int) -> int:
            return NONE if v == NONE else v + start

        first_res = u32(rec, 0x6C)
        self.first_resource = first_res + start if first_res != NONE else start + self.records + 1
        self.ncx_index = absolute(optional(0xF4))
        if start != 0 or self.version == 8:
            self.skeleton_index = absolute(optional(0xFC))
            self.fragment_index = absolute(optional(0xF8))
            self.guide_index = absolute(optional(0x104))
            flows = optional(0xC4)
            self.fdst_index = NONE if flows <= 1 else absolute(optional(0xC0))
        else:
            self.skeleton_index = self.fragment_index = self.guide_index = self.fdst_index = NONE

        # Trailing entries after each text record: one flag per kind (bit 0 = multibyte overlap bytes).
        self.multibyte = False
        self.trailers = 0
        min_version = u32(rec, 0x68)
        if self.header_length >= 0xE4 and min_version >= 5 and len(rec) >= 0xF4:
            flags = u16(rec, 0xF2)
            self.multibyte = (flags & 1) != 0
            while flags > 1:
                if flags & 2:
                    self.trailers += 1
                flags >>= 1

        if self.compression == 1:
            self._unpack = lambda d: d
        elif self.compression == 2:
            self._unpack = palmdoc_unpack
        elif self.compression == 17480:
            reader = HuffCdic()
            huff_offset = u32(rec, 0x70) + start
            huff_count = u32(rec, 0x74)
            reader.load_huff(db.section(huff_offset))
            for i in range(1, huff_count):
                reader.load_cdic(db.section(huff_offset + i))
            self._unpack = reader.unpack
        else:
            raise KindleError("UNSUPPORTED", f"This Kindle book uses a compression Webdex can't read (type {self.compression}).")

        self.exth = self._read_exth()
        offset = u32(rec, 0x54)
        length = u32(rec, 0x58)
        self.title = (
            rec[offset:offset + length].decode(self.codec, "replace")
            if length > 0 and offset + length <= len(rec) else ""
        )

    def is_kf8(self) -> bool:
        return self.start != 0 or self.version == 8

    def _read_exth(self) -> dict[int, list[bytes]]:
        rec = self.record
        if (u32(rec, 0x80) & 0x40) == 0:
            return {}
        base = self.header_length + 16
        if base + 12 > len(rec) or latin1(rec, base, base + 4) != "EXTH":
            return {}
        count = u32(rec, base + 8)
        out: dict[int, list[bytes]] = {}
        pos = base + 12
        for _ in range(count):
            if pos + 8 > len(rec):
                break
            kind = u32(rec, pos)
            size = u32(rec, pos + 4)
            if size < 8 or pos + size > len(rec):
                break
            out.setdefault(kind, []).append(rec[pos + 8:pos + size])
            pos += size
        return out

    def exth_text(self, kind: int) -> list[str]:
        vals = (v.decode(self.codec, "replace").strip() for v in self.exth.get(kind, []))
        return [v for v in vals if v]

    def exth_int(self, kind: int) -> int | None:
        vals = self.exth.get(kind)
        return _be_int(vals[0]) if vals else None

    def exth_last_int(self, kind: int) -> int | None:
        """The LAST value of a numeric EXTH record (a combined book carries the old half's
        value first)."""
        vals = self.exth.get(kind)
        return _be_int(vals[-1]) if vals else None

    def raw_markup(self) -> str:
        """The whole book's markup, decompressed and joined (a byte-per-char string)."""
        parts = [self._unpack(self._trim_trailing(self.db.section(self.start + i))) for i in range(1, self.records + 1)]
        return b"".join(parts).decode("latin-1")

    def _trim_trailing(self, data: bytes) -> bytes:
        for _ in range(self.trailers):
            if not data:
                return data
            num = 0
            for v in data[max(0, len(data) - 4):]:
                if v & 0x80:
                    num = 0
                num = (num << 7) | (v & 0x7F)
            data = data[:max(0, len(data) - num)]
        if self.multibyte and data:
            num = (data[-1] & 3) + 1
            data = data[:max(0, len(data) - num)]
        return data


def _be_int(b: bytes) -> int | None:
    return int.from_bytes(b, "big") if 1 <= len(b) <= 4 else None


# ------------------------------------------------------------------------------ index

@dataclass
class IndexEntry:
    label: str
    tags: dict[int, list[int]]

    def first(self, tag: int) -> int | None:
        v = self.tags.get(tag)
        return v[0] if v else None

    def second(self, tag: int) -> int | None:
        v = self.tags.get(tag)
        return v[1] if v and len(v) > 1 else None


@dataclass
class IndexData:
    entries: list[IndexEntry]
    ctoc: dict[int, str]


def _bad_table() -> KindleError:
    return KindleError("CORRUPT", "A table in the book is damaged.")


def _parse_index_header(data: bytes):
    """Returns (len, start, count, code, nctoc, ordt2)."""
    if len(data) < 4 or data[:4] != b"INDX":
        raise _bad_table()

    def w(i: int) -> int:
        return u32(data, 4 + 4 * i)

    ordt2 = None
    if len(data) >= 0xA4 + 20:
        ocnt = u32(data, 0xA4)
        oentries = u32(data, 0xA4 + 4)
        op2 = u32(data, 0xA4 + 12)
        if w(6) == 0xFDEA or ocnt != 0 or oentries > 0:
            if op2 + 4 + 2 * oentries <= len(data) and data[op2:op2 + 4] == b"ORDT":
                ordt2 = [u16(data, op2 + 4 + 2 * i) for i in range(oentries)]
    return w(0), w(4), w(5), w(6), w(12), ordt2


def _variable_width(data: bytes, offset: int) -> tuple[int, int]:
    """A number stored in 7-bit groups, the last group flagged by the high bit. Returns
    (bytes used, value)."""
    value = 0
    consumed = 0
    while True:
        if offset + consumed >= len(data):
            raise _bad_table()
        v = data[offset + consumed]
        consumed += 1
        value = (value << 7) | (v & 0x7F)
        if v & 0x80:
            break
    return consumed, value


def _read_tag_section(start: int, data: bytes) -> tuple[int, list[tuple[int, int, int, int]]]:
    """The TAGX table: how many control bytes each entry has, and for each tag (tag,
    values per entry, mask, end flag)."""
    control_bytes = 0
    tags: list[tuple[int, int, int, int]] = []
    if start + 12 <= len(data) and data[start:start + 4] == b"TAGX":
        first_entry_offset = u32(data, start + 4)
        control_bytes = u32(data, start + 8)
        i = 12
        while i < first_entry_offset and start + i + 4 <= len(data):
            tags.append((data[start + i], data[start + i + 1], data[start + i + 2], data[start + i + 3]))
            i += 4
    return control_bytes, tags


def _tag_map(control_bytes: int, tag_table, entry: bytes, start_pos: int) -> dict[int, list[int]]:
    """The tagged values of one entry."""
    pending: list[tuple[int, int | None, int | None, int]] = []  # tag, value count, value bytes, per entry
    control_index = 0
    data_start = start_pos + control_bytes
    for tag, per_entry, mask0, end_flag in tag_table:
        if end_flag == 0x01:
            control_index += 1
            continue
        mask = mask0
        value = entry[start_pos + control_index] & mask
        if value != 0:
            if value == mask:
                if bin(mask).count("1") > 1:
                    used, v = _variable_width(entry, data_start)
                    data_start += used
                    pending.append((tag, None, v, per_entry))
                else:
                    pending.append((tag, 1, None, per_entry))
            else:
                while (mask & 1) == 0:
                    mask >>= 1
                    value >>= 1
                pending.append((tag, value, None, per_entry))
    out: dict[int, list[int]] = {}
    for tag, count, nbytes, per_entry in pending:
        values: list[int] = []
        if count is not None:
            for _ in range(count):
                for _ in range(per_entry):
                    used, v = _variable_width(entry, data_start)
                    data_start += used
                    values.append(v)
        else:
            total = 0
            while total < nbytes:
                used, v = _variable_width(entry, data_start)
                data_start += used
                total += used
                values.append(v)
        out[tag] = values
    return out


def read_index(db: PalmDb, idx: int) -> IndexData | None:
    """Kindle's INDX tables (skeleton, fragment, NCX / table of contents). A main INDX record
    describes how entries are encoded (the TAGX table) and how many data records follow;
    each entry is a label plus a set of tagged numbers. None when the book has no such index."""
    if idx == NONE:
        return None
    main = db.section(idx)
    hlen, _, count, _, nctoc, _ = _parse_index_header(main)
    ctoc: dict[int, str] = {}
    rec_offset = 0
    ctoc_base = idx + count + 1
    for j in range(nctoc):
        text = db.section(ctoc_base + j)
        offset = 0
        while offset < len(text):
            if text[offset] == 0:
                break
            at = offset
            used, ln = _variable_width(text, offset)
            offset += used
            if offset + ln > len(text):
                break
            ctoc[at + rec_offset] = latin1(text, offset, offset + ln)
            offset += ln
        rec_offset += 0x10000
    control_bytes, tag_table = _read_tag_section(hlen, main)
    entries: list[IndexEntry] = []
    for i in range(idx + 1, idx + count + 1):
        data = db.section(i)
        _, idxt_pos, n, _, _, ordt2 = _parse_index_header(data)
        positions = [u16(data, idxt_pos + 4 + 2 * j) for j in range(n)] + [idxt_pos]
        for j in range(n):
            start_pos = positions[j]
            text_length = data[start_pos]
            label = latin1(data, start_pos + 1, start_pos + 1 + text_length)
            if ordt2 is not None:
                label = "".join(chr((ordt2[ord(c)] if ord(c) < len(ordt2) else ord(c)) & 0xFF) for c in label)
            tags = _tag_map(control_bytes, tag_table, data, start_pos + 1 + text_length)
            entries.append(IndexEntry(label, tags))
    return IndexData(entries, ctoc)


# ---------------------------------------------------------------------------- KF8 text

def _pat(p: str, ignore_case: bool = False) -> re.Pattern:
    return re.compile(p, re.ASCII | (re.IGNORECASE if ignore_case else 0))


def _split_keep(pattern: re.Pattern, text: str) -> list[str]:
    """`re.split` with ONE capture group: [text, match, text, match, ..., text]."""
    return pattern.split(text)


@dataclass
class _Skeleton:
    num: int
    name: str
    fragment_count: int
    pos: int
    length: int


@dataclass
class _Fragment:
    insert_pos: int
    id_text: str
    file_num: int
    seq_num: int
    start_pos: int
    length: int


@dataclass
class PartInfo:
    skeleton_num: int
    filename: str
    start: int
    end: int
    aid_text: str


@dataclass
class FlowInfo:
    type: str | None
    format: str | None
    dir: str | None
    name: str | None


@dataclass
class GuideRef:
    type: str
    title: str
    href: str


_KNOWN_GUIDE = {
    "cover", "title-page", "toc", "index", "glossary", "acknowledgements", "bibliography", "colophon",
    "copyright-page", "dedication", "epigraph", "foreward", "loi", "lot", "notes", "preface", "text",
}

_ID_ATTR = _pat(r"<[^>]*\sid\s*=\s*['\"]([^'\"]*)['\"]", True)
_NAME_ATTR = _pat(r"<[^>]*\sname\s*=\s*['\"]([^'\"]*)['\"]", True)
_AID_ATTR_TAG = _pat(r"<[^>]+\s(?:aid|AID)\s*=\s*['\"]([^'\"]+)['\"]")


class Kf8Book:
    """A KF8 book's text, put back together: the book stores each XHTML file as a
    "skeleton" with "fragments" stored separately and meant to be inserted at given
    positions, plus "flows" (stylesheets, SVG) and links written as kindle:pos /
    kindle:embed / kindle:flow references."""

    def __init__(self, db: PalmDb, header: MobiHeader, raw_markup: str):
        self.db = db
        self.header = header
        self.parts: list[str] = []
        self.part_info: list[PartInfo] = []
        self.flows: list[str] = []
        self.flow_info: list[FlowInfo] = []
        self.linked_aids: set[str] = set()
        self._guide_table: list[tuple[str, str, int | None]] = []
        self._skeletons: list[_Skeleton] = []
        self._fragments: list[_Fragment] = []

        starts = [0, 1 << 62]
        if header.fdst_index != NONE:
            fdst = db.section(header.fdst_index)
            if len(fdst) >= 12 and fdst[:4] == b"FDST":
                n = u32(fdst, 8)
                starts = [u32(fdst, 12 + 8 * i) for i in range(n)] + [len(raw_markup)]
        self._flow_starts = starts

        data = read_index(db, header.skeleton_index)
        if data:
            for i, e in enumerate(data.entries):
                self._skeletons.append(_Skeleton(i, e.label, e.first(1) or 0, e.first(6) or 0, e.second(6) or 0))
        data = read_index(db, header.fragment_index)
        if data:
            for e in data.entries:
                try:
                    insert_pos = int(e.label.strip())
                except ValueError:
                    insert_pos = 0
                self._fragments.append(_Fragment(
                    insert_pos, data.ctoc.get(e.first(2) or 0, ""),
                    e.first(3) or 0, e.first(4) or 0, e.first(6) or 0, e.second(6) or 0,
                ))
        data = read_index(db, header.guide_index)
        if data:
            for e in data.entries:
                title = data.ctoc.get(e.first(1) if e.first(1) is not None else -1, "")
                frag = e.first(6) if e.first(6) is not None else e.first(3)
                self._guide_table.append((e.label, title, frag))
        self._build(raw_markup)

    def _build(self, raw: str) -> None:
        starts = self._flow_starts
        for j in range(len(starts) - 1):
            lo = _clamp(starts[j], 0, len(raw))
            hi = _clamp(starts[j + 1], lo, len(raw))
            self.flows.append(raw[lo:hi])
        if not self.flows:
            self.flows.append(raw)
        text = self.flows[0]
        self.flows[0] = ""

        frag_ptr = 0
        for skel in self._skeletons:
            base_ptr = skel.pos + skel.length
            skeleton = text[_clamp(skel.pos, 0, len(text)):_clamp(base_ptr, 0, len(text))]
            aid_text = "0"
            filename = "part%04d.xhtml" % len(self.part_info)
            for i in range(skel.fragment_count):
                if frag_ptr >= len(self._fragments):
                    break
                frag = self._fragments[frag_ptr]
                aid_text = frag.id_text[12:-2] if len(frag.id_text) >= 14 else frag.id_text
                if i == 0:
                    filename = "part%04d.xhtml" % frag.file_num
                lo = _clamp(base_ptr, 0, len(text))
                piece = text[lo:_clamp(base_ptr + frag.length, 0, len(text))]
                insert_pos = _clamp(frag.insert_pos - skel.pos, 0, len(skeleton))
                head = skeleton[:insert_pos]
                tail = skeleton[insert_pos:]
                actual = insert_pos
                # A fragment table that points into the middle of a tag is corrupt: place it by the tag's id instead.
                if tail.find(">") < tail.find("<") or head.rfind(">") < head.rfind("<"):
                    bp, ep = self._locate_tag(skeleton, aid_text)
                    if bp != ep:
                        actual = ep + 1 + frag.start_pos
                if insert_pos != actual:
                    insert_pos = _clamp(actual, 0, len(skeleton))
                    frag.insert_pos = insert_pos + skel.pos
                skeleton = skeleton[:insert_pos] + piece + skeleton[insert_pos:]
                base_ptr += frag.length
                frag_ptr += 1
            self.parts.append(skeleton)
            self.part_info.append(PartInfo(skel.num, filename, skel.pos, base_ptr, aid_text))

        self.flow_info.append(FlowInfo(None, None, None, None))
        svg_tag = _pat(r"(<svg[^>]*>)", True)
        image_tag = _pat(r"(<image[^>]*>)", True)
        for j in range(1, len(self.flows)):
            flow = self.flows[j]
            n = "%04d" % j
            svg = svg_tag.search(flow)
            if svg:
                if image_tag.search(flow):
                    flow = flow[svg.start():]
                    info = FlowInfo("svg", "inline", None, None)
                else:
                    info = FlowInfo("svg", "file", "Images", f"svgimg{n}.svg")
            elif "[CDATA[" in flow:
                flow = f'<style type="text/css">\n{flow}\n</style>\n'
                info = FlowInfo("css", "inline", None, None)
            else:
                info = FlowInfo("css", "file", "Styles", f"style{n}.css")
            self.flows[j] = flow
            self.flow_info.append(info)

    @staticmethod
    def _locate_tag(markup: str, aid: str) -> tuple[int, int]:
        m = _pat(r"<[^>]*\said\s*=\s*['\"]" + re.escape(aid) + r"['\"][^>]*>", True).search(markup)
        if m:
            lt = m.start()
            return lt, markup.find(">", lt + 1)
        return 0, 0

    def part_for(self, pos: int) -> int:
        for i, p in enumerate(self.part_info):
            if p.start <= pos < p.end:
                return i
        return -1

    def id_tag_by_pos_fid(self, row: int, offset: int) -> tuple[str, str] | None:
        """Where a kindle:pos link goes: the page file and the id to use as the anchor, from
        the fragment row number and an offset inside that fragment."""
        if not 0 <= row < len(self._fragments):
            return None
        frag = self._fragments[row]
        pos = frag.insert_pos + offset
        index = self.part_for(pos)
        if index < 0:  # a link to nowhere: send it to the top of the file it was meant for
            if not 0 <= frag.file_num < len(self._skeletons):
                return None
            pos = self._skeletons[frag.file_num].pos
            index = self.part_for(pos)
            if index < 0:
                return None
        return self.part_info[index].filename, self._id_tag(pos)

    def id_tag_by_pos_fid_text(self, fid: str, off: str) -> tuple[str, str] | None:
        return self.id_tag_by_pos_fid(from_base32(fid), from_base32(off))

    def guide_references(self, start_offset: int | None, codec: str) -> list[GuideRef]:
        """The guide references, with their anchors resolved (which also marks those anchors
        as linked, so the pages keep them). When the book has no guide, the "start reading"
        position from its metadata stands in for one."""
        out: list[GuideRef] = []
        for gtype, gtitle, gfrag in self._guide_table:
            if gtype == "thumbimagestandard":
                continue
            if gtype not in _KNOWN_GUIDE and not gtype.startswith("other."):
                gtype = "text" if gtype == "start" else "other." + gtype
            if gfrag is None or not 0 <= gfrag < len(self._fragments):
                continue
            pos = self._fragments[gfrag].insert_pos
            index = self.part_for(pos)
            if index < 0:
                continue
            ident = self._id_tag(pos)
            out.append(GuideRef(gtype, gtitle.encode("latin-1").decode(codec, "replace"),
                                self.part_info[index].filename + (f"#{ident}" if ident else "")))
        if not out and start_offset is not None:
            start = 0 if start_offset == NONE else start_offset
            seq = self._fragment_seq_at(start)
            if seq is not None:
                target = self.id_tag_by_pos_fid(seq, 0)
                if target:
                    out.append(GuideRef("text", "", target[0] + (f"#{target[1]}" if target[1] else "")))
        return out

    def _fragment_seq_at(self, pos: int) -> int | None:
        """The sequence number of the fragment holding (or just after) text position [pos]."""
        for f in self._fragments:
            if f.insert_pos <= pos < f.insert_pos + f.length:
                return f.seq_num
            if pos < f.insert_pos:
                return f.seq_num
        return None

    def _id_tag(self, pos: int) -> str:
        """The id of the nearest element at or before [pos] (an `aid` attribute becomes
        `aid-…`, kept only if linked)."""
        index = self.part_for(pos)
        if index < 0:
            return ""
        block = self.parts[index]
        npos = _clamp(pos - self.part_info[index].start, 0, len(block))
        gt = block.find(">", npos)
        lt = block.find("<", npos)
        if lt == npos or gt < lt:
            npos = gt + 1
        up_to = block[:_clamp(npos, 0, len(block))]
        end = len(up_to)
        while True:
            pgt = up_to.rfind(">", 0, end)
            if pgt == -1:
                break
            plt = up_to.rfind("<", 0, pgt + 1)
            if plt == -1:
                break
            tag = up_to[plt:pgt + 1]
            if tag.startswith("<body "):
                return ""
            if not tag.startswith("<meta "):
                m = _ID_ATTR.match(tag)
                if m:
                    return m.group(1)
                m = _NAME_ATTR.match(tag)
                if m:
                    return m.group(1)
                m = _AID_ATTR_TAG.match(tag)
                if m:
                    self.linked_aids.add(m.group(1))
                    return "aid-" + m.group(1)
            end = plt
        return ""


# ---------------------------------------------------------------------- link rewriting

_A_TAG = _pat(r"(<a.*?href=.*?>)", True)
_POS_FID = _pat(r"""['"]kindle:pos:fid:([0-9|A-V]+):off:([0-9|A-V]+).*?["']""")
_TAG_WITH_AID = _pat(r"(<[^>]*\said\s*=[^>]*>)", True)
_AID_ATTR = _pat(r"""\said\s*=['"]([^'"]*)['"]""")
_TAG_WITH_PAGEBREAK = _pat(r"(<[^>]*\sdata-AmznPageBreak=[^>]*>)", True)
_PAGEBREAK_ATTR = _pat(r"""\sdata-AmznPageBreak=['"]([^'"]*)['"]""")
_IMG_OR_IMAGE = _pat(r"(<[img\s|image\s][^>]*>)", True)
_EMBED_ANY = _pat(r"""[('"]kindle:embed:([0-9|A-V]+)[^'"]*['")]""", True)
_EMBED_QUOTED = _pat(r"""['"]kindle:embed:([0-9|A-V]+)[^'"]*['"]""")
_URL_CALL = _pat(r"(url\(.*?\))", True)
_URL_EMBED_IMAGE = _pat(r"""[('"]kindle:embed:([0-9|A-V]+)\?mime=image/[^\)]*["')]""", True)
_EMBED_FONT = _pat(r"""[('"]kindle:embed:([0-9|A-V]+)["')]""", True)
_URL_FLOW_CSS = _pat(r"kindle:flow:([0-9|A-V]+)\?mime=text/css[^\)]*", True)
_URL_FLOW_SVG = _pat(r"kindle:flow:([0-9|A-V]+)\?mime=image/svg\+xml[^\)]*", True)
_ANY_TAG = _pat(r"(<[^>]*>)")
_FLOW_REF = _pat(r"""['"]kindle:flow:([0-9|A-V]+)\?mime=([^'"]+)['"]""", True)
_STYLE_TAG = _pat(r"""(<[a-zA-Z0-9]+\s[^>]*style\s*=\s*[^>]*>)""", True)
_LI_VALUE = _pat(r"""\svalue\s*=\s*['"][^'"]*['"]""", True)


def rewrite_links(book: Kf8Book, rscnames: list[str | None]) -> set[str]:
    """Turns the book's internal references into ordinary links: kindle:pos →
    "part0003.xhtml#anchor", kindle:embed → "../Images/…" or "../Fonts/…", kindle:flow → the
    stylesheet/SVG file (or inlined). Returns the names of the images, fonts and flow files
    that something refers to."""
    used: set[str] = set()

    def resource(number: int) -> str | None:
        i = number - 1
        return rscnames[i] if 0 <= i < len(rscnames) else None

    def each_tag(parts: list[str], pattern: re.Pattern, step) -> list[str]:
        """Runs [step] over every captured tag (the odd entries of a split), leaving the text between."""
        out = []
        for part in parts:
            pieces = _split_keep(pattern, part)
            for j in range(1, len(pieces), 2):
                pieces[j] = step(pieces[j])
            out.append("".join(pieces))
        return out

    # 1) links between pages
    def pos_fid(m: re.Match) -> str:
        target = book.id_tag_by_pos_fid_text(m.group(1), m.group(2))
        if target is None:
            return m.group()
        filename, idtag = target
        return f'"{filename}"' if not idtag else f'"{filename}#{idtag}"'

    new_parts = each_tag(book.parts, _A_TAG, lambda tag: _POS_FID.sub(pos_fid, tag) if tag.startswith("<") else tag)

    # 2) anchors: an element's `aid` becomes an id only when something links to it
    def aid_to_id(m: re.Match) -> str:
        return f' id="aid-{m.group(1)}"' if m.group(1) in book.linked_aids else ""

    new_parts = [
        "".join(
            _AID_ATTR.sub(aid_to_id, piece) if piece.startswith("<") else piece
            for piece in _split_keep(_TAG_WITH_AID, part)
        )
        for part in new_parts
    ]

    # 3) Amazon page-break markers
    new_parts = [
        "".join(
            _PAGEBREAK_ATTR.sub(lambda m: f' style="page-break-after:{m.group(1)}"', piece) if piece.startswith("<") else piece
            for piece in _split_keep(_TAG_WITH_PAGEBREAK, part)
        )
        for part in new_parts
    ]

    # 4) inside the stylesheet / SVG flows: images, fonts and other flows they use
    def to_images(m: re.Match) -> str:
        name = resource(from_base32(m.group(1)))
        if name is None:
            return m.group()
        used.add(name)
        return f'"../Images/{name}"'

    def to_wrapped(folder: str):
        def f(m: re.Match) -> str:
            name = resource(from_base32(m.group(1)))
            if name is None:
                return m.group()
            used.add(name)
            g = m.group()
            return g[0] + f"../{folder}/" + name + g[-1]
        return f

    def to_flow(m: re.Match) -> str:
        num = from_base32(m.group(1))
        info = book.flow_info[num] if 0 <= num < len(book.flow_info) else None
        if info is not None and info.name is not None:
            used.add(info.name)
            return f'"../{info.dir}/{info.name}"'
        return m.group()

    new_flows = [""]
    for i in range(1, len(book.flows)):
        pieces = _split_keep(_IMG_OR_IMAGE, book.flows[i])
        for j in range(1, len(pieces), 2):
            if pieces[j].startswith("<im"):
                pieces[j] = _EMBED_ANY.sub(to_images, pieces[j])
        flow = "".join(pieces)
        pieces = _split_keep(_URL_CALL, flow)
        for j in range(1, len(pieces), 2):
            tag = pieces[j]
            tag = _URL_EMBED_IMAGE.sub(to_wrapped("Images"), tag)
            tag = _EMBED_FONT.sub(to_wrapped("Fonts"), tag)
            tag = _URL_FLOW_CSS.sub(to_flow, tag)
            tag = _URL_FLOW_SVG.sub(to_flow, tag)
            pieces[j] = tag
        new_flows.append("".join(pieces))

    # 5) flow references inside the pages (stylesheets, SVG): to the file, or the flow itself when inline
    def flow_ref_tag(tag: str) -> str:
        if not tag.startswith("<"):
            return tag
        inlined = None
        for m in _FLOW_REF.finditer(tag):
            num = from_base32(m.group(1))
            if 0 < num < len(book.flow_info) and book.flow_info[num].format == "inline":
                inlined = new_flows[num]
        if inlined is not None:
            return inlined

        def repl(m: re.Match) -> str:
            num = from_base32(m.group(1))
            info = book.flow_info[num] if 0 <= num < len(book.flow_info) else None
            if num > 0 and info is not None and info.name is not None:
                used.add(info.name)
                return f'"../{info.dir}/{info.name}"'
            return m.group()
        return _FLOW_REF.sub(repl, tag)

    new_parts = each_tag(new_parts, _ANY_TAG, flow_ref_tag)

    # 6) images named in inline style="…url(kindle:embed:…)"
    new_parts = each_tag(new_parts, _STYLE_TAG, lambda tag: _EMBED_ANY.sub(to_wrapped("Images"), tag) if "kindle:embed" in tag else tag)

    # 7) <img src="kindle:embed:…">
    new_parts = each_tag(new_parts, _IMG_OR_IMAGE, lambda tag: _EMBED_QUOTED.sub(to_images, tag) if tag.startswith("<im") else tag)

    # 8) small clean-ups some readers need
    def cleanup(tag: str) -> str:
        if tag.startswith("<svg") or tag.startswith("<SVG"):
            return tag.replace("preserveaspectratio", "preserveAspectRatio").replace("viewbox", "viewBox")
        if tag.startswith("<li ") or tag.startswith("<LI "):
            return _LI_VALUE.sub("", tag)
        return tag

    new_parts = each_tag(new_parts, _ANY_TAG, cleanup)

    book.parts[:] = new_parts
    book.flows = new_flows
    return used


# ------------------------------------------------------------------------ resources

_NON_RESOURCE_TYPES = {"FLIS", "FCIS", "FDST", "DATP", "SRCS", "PAGE", "CMET", "CONT", "kind", "RESC", "CRES", "    "}


def _image_extension(d: bytes) -> str | None:
    if d[:3] == b"\xff\xd8\xff":
        return "jpeg"
    if d[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if d[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if d[:4] == b"RIFF" and d[8:12] == b"WEBP":
        return "webp"
    if d[:2] == b"BM":
        return "bmp"
    return None


def _decode_font(d: bytes) -> tuple[str, bytes] | None:
    """A font record: optionally XOR-obfuscated (first 1040 bytes) and zlib-compressed."""
    if len(d) < 24:
        return None
    flags, data_start, xor_len, xor_start = u32(d, 8), u32(d, 12), u32(d, 16), u32(d, 20)
    if data_start > len(d):
        return None
    font = bytearray(d[data_start:])
    if (flags & 2) and xor_len > 0 and xor_start + xor_len <= len(d):
        key = d[xor_start:xor_start + xor_len]
        for i in range(min(len(font), 1040)):
            font[i] ^= key[i % xor_len]
    font = bytes(font)
    if flags & 1:
        try:
            font = zlib.decompressobj().decompress(font)
        except zlib.error:
            return None
    magic = font[:4]
    if magic in (b"\x00\x01\x00\x00", b"true", b"ttcf"):
        ext = "ttf"
    elif magic == b"OTTO":
        ext = "otf"
    else:
        ext = "dat"
    return ext, font


@dataclass
class Resources:
    """The book's images and fonts, numbered the way `kindle:embed:NNNN` refers to them
    (1 = first resource record)."""
    names: list[str | None] = field(default_factory=list)
    files: dict[str, bytes] = field(default_factory=dict)
    cover_name: str | None = None


def collect_resources(db: PalmDb, headers: list[MobiHeader], boundary: int) -> Resources:
    """Walks the resource records of each header (a combined book has two) the way the
    numbering requires: every record counts, whether or not it is something we keep, so
    `kindle:embed:NNNN` indexes into one running list."""
    res = Resources()
    for mh in headers:
        beg = mh.first_resource
        end = boundary if beg < boundary else db.count
        cover_offset = mh.exth_int(201)
        if cover_offset == NONE:
            cover_offset = None
        for i in range(beg, end):
            data = db.section(i)
            kind = latin1(data, 0, 4) if len(data) >= 4 else ""
            if kind in _NON_RESOURCE_TYPES:
                res.names.append(None)
            elif kind == "FONT":
                font = _decode_font(data)
                if font is None:
                    res.names.append(None)
                else:
                    name = "font%05d.%s" % (i, font[0])
                    res.files[name] = font[1]
                    res.names.append(name)
            elif len(data) == 4 and u32(data, 0) == 0xE98E0D0A:  # end-of-file marker
                res.names.append(None)
            elif data[:8] == b"BOUNDARY":
                res.names.append(None)
            else:
                ext = _image_extension(data)
                if ext is None:
                    res.names.append(None)
                else:
                    is_cover = cover_offset is not None and i == beg + cover_offset
                    name = ("cover%05d.%s" if is_cover else "image%05d.%s") % (i, ext)
                    res.files[name] = data
                    res.names.append(name)
                    if is_cover:
                        res.cover_name = name
    return res


# --------------------------------------------------------------------------- the book

@dataclass
class Resource:
    """One file of a decoded book. `href` is relative to the book root, e.g. `Text/part0001.xhtml`."""
    href: str
    media_type: str
    data: bytes
    properties: str | None = None


@dataclass
class TocItem:
    title: str
    href: str  # relative to the book root; may end in `#anchor`
    children: list["TocItem"] = field(default_factory=list)


@dataclass
class DecodedBook:
    title: str
    authors: list[str]
    language: str
    identifier: str
    publisher: str | None
    description: str | None
    published: str | None
    subjects: list[str]
    resources: list[Resource]
    reading_order: list[str]
    cover_href: str | None
    toc: list[TocItem]
    guide: list[GuideRef]


_MEDIA_TYPES = {
    "jpeg": "image/jpeg", "jpg": "image/jpeg", "png": "image/png", "gif": "image/gif", "webp": "image/webp",
    "bmp": "image/bmp", "svg": "image/svg+xml", "ttf": "font/ttf", "otf": "font/otf",
}


def _build_toc(db: PalmDb, header: MobiHeader, book: Kf8Book) -> list[TocItem]:
    index = read_index(db, header.ncx_index)
    if index is None:
        return []
    raw = []
    for e in index.entries:
        label = index.ctoc.get(e.first(3) if e.first(3) is not None else -1)
        label = label.encode("latin-1").decode(header.codec, "replace") if label is not None else "Untitled"
        fid, off = e.first(6), e.second(6)
        target = book.id_tag_by_pos_fid(fid, off) if fid is not None and off is not None else None
        href = None
        if target:
            href = target[0] if not target[1] else f"{target[0]}#{target[1]}"
        parent = e.first(21)
        raw.append((label.strip(), href, parent if parent is not None else -1))
    items = [TocItem(label, f"Text/{href}" if href is not None else "Text/") for label, href, _ in raw]
    roots: list[TocItem] = []
    for i, (_, _, parent) in enumerate(raw):
        if 0 <= parent < len(items) and parent != i:
            items[parent].children.append(items[i])
        else:
            roots.append(items[i])
    return roots


def decode(data: bytes) -> DecodedBook:
    """Takes the book apart. Raises [KindleError] with a readable reason when it can't be read."""
    try:
        return _decode(data)
    except KindleError:
        raise
    except Exception as e:  # a damaged book surfaces as an index/array error somewhere deep: report it plainly
        raise KindleError("CORRUPT", "This Kindle book is damaged or in a layout Webdex can't read yet.") from e


def _decode(data: bytes) -> DecodedBook:
    db = PalmDb(data)
    first = MobiHeader(db, 0)
    headers = [first]
    boundary = -1
    if not first.is_kf8():
        boundary = db.find_kf8_boundary()
        if boundary < 0:
            raise KindleError(
                "UNSUPPORTED",
                "This is an old-style Kindle (MOBI) book. Webdex can read newer Kindle books (AZW3) but not this format yet.",
            )
        headers.append(MobiHeader(db, boundary + 1))
    if any(h.encrypted for h in headers):
        raise KindleError("DRM", "This Kindle book is protected by DRM, so it can't be opened.")
    if len(first.record) > 0x180 and "true" in first.exth_text(122):
        raise KindleError("UNSUPPORTED", "This is a fixed-layout (comic or print-replica) Kindle book, which Webdex can't show yet.")
    kf8 = headers[-1]
    resources = collect_resources(db, headers, boundary)
    book = Kf8Book(db, kf8, kf8.raw_markup())
    if not book.parts:
        raise KindleError("CORRUPT", "This Kindle book has no readable text.")
    # The contents table points into the pages as first assembled (and marks the anchors that must be kept),
    # so it is worked out BEFORE the pages' links are rewritten.
    guide = book.guide_references(kf8.exth_last_int(116), kf8.codec)
    toc = _build_toc(db, kf8, book)
    used = rewrite_links(book, resources.names)

    files: list[Resource] = []
    order: list[str] = []
    for i, part in enumerate(book.parts):
        href = f"Text/{book.part_info[i].filename}"
        files.append(Resource(href, "application/xhtml+xml", part.encode("latin-1")))
        order.append(href)
    for i in range(1, len(book.flows)):
        info = book.flow_info[i] if i < len(book.flow_info) else None
        if info is None or info.format != "file" or info.name is None:
            continue
        files.append(Resource(f"{info.dir}/{info.name}", "text/css" if info.type == "css" else "image/svg+xml",
                              book.flows[i].encode("latin-1")))
    # Every image and font the book has: referenced ones matter for rendering, the cover for the library.
    cover_href = None
    for name, blob in resources.files.items():
        is_font = name.startswith("font")
        if not is_font and name not in used and name != resources.cover_name:
            continue
        href = ("Fonts/" if is_font else "Images/") + name
        is_cover = name == resources.cover_name
        if is_cover:
            cover_href = href
        files.append(Resource(href, _MEDIA_TYPES.get(name.rsplit(".", 1)[-1].lower(), "application/octet-stream"),
                              blob, "cover-image" if is_cover else None))

    title_meta = kf8.exth_text(503)
    title = title_meta[0] if title_meta else (kf8.title.strip() or "Untitled")
    contents = toc or [TocItem(title_meta[0] if title_meta else (kf8.title.strip() or "Start"),
                               f"Text/{book.part_info[0].filename}")]
    ident = kf8.exth_text(504)
    lang = kf8.exth_text(524)
    publisher = kf8.exth_text(101)
    description = kf8.exth_text(103)
    published = kf8.exth_text(106)
    return DecodedBook(
        title=title,
        authors=kf8.exth_text(100),
        language=lang[0] if lang else "en",
        identifier="urn:kindle:" + (ident[0] if ident else str(kf8.unique_id)),
        publisher=publisher[0] if publisher else None,
        description=description[0] if description else None,
        published=published[0][:10] if published else None,
        subjects=kf8.exth_text(105),
        resources=files,
        reading_order=order,
        cover_href=cover_href,
        toc=contents,
        guide=[GuideRef(g.type, g.title, f"Text/{g.href}") for g in guide],
    )


# ---------------------------------------------------------------------- EPUB output

def _esc(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace('"', "&quot;")


def _id_for(href: str) -> str:
    return "i" + re.sub(r"[^A-Za-z0-9]", "_", href)


def _nav_document(toc: list[TocItem]) -> str:
    # The navigation document sits in Text/, so its links are relative to that folder.
    def lst(items: list[TocItem]) -> str:
        out = "<ol>\n"
        for i in items:
            href = i.href[len("Text/"):] if i.href.startswith("Text/") else i.href
            out += f'<li><a href="{_esc(href)}">{_esc(i.title)}</a>'
            if i.children:
                out += "\n" + lst(i.children)
            out += "</li>\n"
        return out + "</ol>\n"

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
        '<head><title>Contents</title></head>\n<body>\n<nav epub:type="toc" id="toc"><h1>Contents</h1>\n'
        + lst(toc) + "</nav>\n</body>\n</html>\n"
    )


def _ncx_document(book: DecodedBook) -> str:
    play = 0

    def point(i: TocItem) -> str:
        nonlocal play
        play += 1
        out = (f'<navPoint id="np{play}" playOrder="{play}"><navLabel><text>{_esc(i.title)}</text></navLabel>'
               f'<content src="{_esc(i.href)}"/>')
        for c in i.children:
            out += point(c)
        return out + "</navPoint>\n"

    body = "".join(point(i) for i in book.toc)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n'
        f'<head><meta name="dtb:uid" content="{_esc(book.identifier)}"/></head>\n'
        f"<docTitle><text>{_esc(book.title)}</text></docTitle>\n<navMap>\n{body}</navMap>\n</ncx>\n"
    )


def _opf_document(book: DecodedBook, manifest: list[tuple[str, str, str, str | None]], spine: list[str]) -> str:
    o = ['<?xml version="1.0" encoding="UTF-8"?>\n',
         '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">\n',
         '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">\n',
         f'    <dc:identifier id="BookId">{_esc(book.identifier)}</dc:identifier>\n',
         f"    <dc:title>{_esc(book.title)}</dc:title>\n",
         f"    <dc:language>{_esc(book.language)}</dc:language>\n"]
    for a in book.authors:
        o.append(f"    <dc:creator>{_esc(a)}</dc:creator>\n")
    if book.publisher:
        o.append(f"    <dc:publisher>{_esc(book.publisher)}</dc:publisher>\n")
    if book.description:
        o.append(f"    <dc:description>{_esc(book.description)}</dc:description>\n")
    if book.published:
        o.append(f"    <dc:date>{_esc(book.published)}</dc:date>\n")
    for s in book.subjects:
        o.append(f"    <dc:subject>{_esc(s)}</dc:subject>\n")
    if book.cover_href:
        o.append(f'    <meta name="cover" content="{_id_for(book.cover_href)}"/>\n')
    o.append('    <meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>\n')
    o.append("  </metadata>\n  <manifest>\n")
    for item_id, href, media_type, props in manifest:
        o.append(f'    <item id="{item_id}" href="{_esc(href)}" media-type="{media_type}"')
        if props:
            o.append(f' properties="{props}"')
        o.append("/>\n")
    o.append('  </manifest>\n  <spine toc="ncx">\n')
    for item_id in spine:
        o.append(f'    <itemref idref="{item_id}"/>\n')
    o.append("  </spine>\n")
    if book.guide:
        o.append("  <guide>\n")
        for g in book.guide:
            o.append(f'    <reference type="{_esc(g.type)}" title="{_esc(g.title)}" href="{_esc(g.href)}"/>\n')
        o.append("  </guide>\n")
    o.append("</package>\n")
    return "".join(o)


def write_epub(book: DecodedBook) -> bytes:
    """Writes a [DecodedBook] out as an EPUB 3 package (with an NCX for older readers)."""
    files: dict[str, bytes] = {
        "mimetype": b"application/epub+zip",
        "META-INF/container.xml": (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
            '  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n'
            "</container>\n"
        ).encode(),
    }
    manifest: list[tuple[str, str, str, str | None]] = []
    for r in book.resources:
        files[f"OEBPS/{r.href}"] = r.data
        manifest.append((_id_for(r.href), r.href, r.media_type, r.properties))
    spine = [_id_for(h) for h in book.reading_order]
    nav_href = "Text/nav.xhtml"
    files[f"OEBPS/{nav_href}"] = _nav_document(book.toc).encode()
    manifest.append(("nav", nav_href, "application/xhtml+xml", "nav"))
    files["OEBPS/toc.ncx"] = _ncx_document(book).encode()
    manifest.append(("ncx", "toc.ncx", "application/x-dtbncx+xml", None))
    files["OEBPS/content.opf"] = _opf_document(book, manifest, spine).encode()

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, blob in files.items():
            # the mimetype entry must be first and stored uncompressed
            zf.writestr(name, blob, zipfile.ZIP_STORED if name == "mimetype" else zipfile.ZIP_DEFLATED)
    return buf.getvalue()


def to_epub_bytes(data: bytes) -> bytes:
    """A Kindle file's bytes -> the bytes of an EPUB with the same content."""
    return write_epub(decode(data))
