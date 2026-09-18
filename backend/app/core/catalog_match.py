"""Pairs an ebook-only ABS library item with an audio-only one when they're
editions of the same work — Audiobookshelf sometimes catalogs an audiobook
and its ebook as two separate library items (even across different
libraries within the same server) instead of one item with both files, so
per-item format detection alone can't offer a Listen/Read toggle for them.

Ports the identity-matching cascade already proven live in the Audex
mobile app's local catalog engine (github.com/jonsjsj/codexaudio,
core/catalog/{Normalize,GraphBuilder}.kt — see the ☠ history in this
project's memory for how the embedded-series-title and Jaro-Winkler
threshold tuning were arrived at): ASIN exact match -> ISBN-13 exact match
-> weighted fuzzy title+author (Jaro-Winkler, accept >= 0.90). Deliberately
NOT a port of that file's full author/series graph builder (union-find
clustering, series-alias resolution, embedded-series title recovery) —
this only needs pairwise "is this the other format of THAT book", not a
whole-library work graph, so the series/position-based match branch and
recoverSeriesPosition() are left out. A title that only has its series
baked into ONE side's text (and not the other) may therefore score lower
here than the mobile app would — acceptable for what this is: same-item,
across-library pairing, not the general dedupe problem.
"""
from __future__ import annotations

import re
import unicodedata

_WHITESPACE_RE = re.compile(r"\s+")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9# ]")
_LEADING_ARTICLE_RE = re.compile(r"^(the|a|an)\s+")
_PARENTHETICAL_RE = re.compile(r"\([^)]*\)|\[[^\]]*\]")
_TITLE_POSITION_SUFFIX_RE = re.compile(r"^(?P<stem>.+?)[,:]?\s+(book|vol\.?|volume)\s+\d+(\.\d+)?$")
_SUBTITLE_DROPPABLE_RE = re.compile(
    r"^(a novel( of .*)?|book (one|two|three|four|five|six|seven|eight|nine|ten|\d+)( of .*)?|"
    r"the (first|second|third|fourth|fifth|final) (book|novel|volume)( of .*)?)$"
)
_NAME_SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"}
_OMNIBUS_RE = re.compile(r"(books?|volumes?|vols?\.?)\s*\d+\s*[-–—&]\s*\d+|omnibus|box\s*set|collection", re.IGNORECASE)
_DRAMATIZED_RE = re.compile(r"graphic\s*audio|graphicaudio|dramatized adaptation|full[- ]cast dramatization", re.IGNORECASE)


def _fold_diacritics(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def _basic(s: str) -> str:
    return _WHITESPACE_RE.sub(" ", _fold_diacritics(s).lower().strip())


def norm_title(title: str) -> str:
    """Title identity key: strips parenthetical/bracketed edition tags
    ("(Unabridged)"), a droppable subtitle (": A Novel of the Cosmere",
    ": Book One of the Stormlight Archive"), a trailing "Book N"/"Volume N"
    position marker, and the leading article."""
    s = _basic(_PARENTHETICAL_RE.sub(" ", title))
    sub_idx = next((i for i, c in enumerate(s) if c in (":", "—")), None)
    if sub_idx is not None and 0 < sub_idx < len(s) - 1:
        subtitle = _WHITESPACE_RE.sub(" ", s[sub_idx + 1:].strip())
        if _SUBTITLE_DROPPABLE_RE.match(subtitle):
            s = s[:sub_idx].strip()
    m = _TITLE_POSITION_SUFFIX_RE.match(s)
    if m:
        s = m.group("stem").strip()
    s = _LEADING_ARTICLE_RE.sub("", s.strip())
    s = _NON_ALNUM_RE.sub(" ", s).replace("#", " ")
    return _WHITESPACE_RE.sub(" ", s).strip()


def norm_author(name: str) -> str:
    """Author identity key: collapses initials ("B. V." == "BV"), drops
    generational/degree suffixes, folds diacritics."""
    cleaned = _NON_ALNUM_RE.sub(" ", _basic(name.replace(".", " ")))
    tokens = [t for t in cleaned.strip().split(" ") if t]
    kept = [t for t in tokens if t not in _NAME_SUFFIXES]
    merged: list[str] = []
    run = ""
    for t in kept:
        if len(t) == 1:
            run += t
        else:
            if run:
                merged.append(run)
                run = ""
            merged.append(t)
    if run:
        merged.append(run)
    return " ".join(merged)


def is_omnibus(title: str, subtitle: str | None) -> bool:
    return bool(_OMNIBUS_RE.search(title) or (subtitle and _OMNIBUS_RE.search(subtitle)))


def is_dramatized(title: str, subtitle: str | None) -> bool:
    return bool(_DRAMATIZED_RE.search(title) or (subtitle and _DRAMATIZED_RE.search(subtitle)))


def normalize_isbn(raw: str | None) -> str | None:
    """ISBN-13 digits (no hyphens); ISBN-10 is converted with the 978
    prefix + a recomputed EAN-13 check digit. None if it doesn't look like
    an ISBN."""
    if not raw or not raw.strip():
        return None
    digits = "".join(c for c in raw.upper() if c.isdigit() or c == "X")
    if len(digits) == 13:
        return digits if digits.isdigit() else None
    if len(digits) == 10:
        core = "978" + digits[:9]
        if not core.isdigit():
            return None
        total = sum((int(c) if i % 2 == 0 else int(c) * 3) for i, c in enumerate(core))
        check = (10 - total % 10) % 10
        return core + str(check)
    return None


def _jaro_similarity(s1: str, s2: str) -> float:
    if s1 == s2:
        return 1.0
    len1, len2 = len(s1), len(s2)
    if len1 == 0 or len2 == 0:
        return 0.0
    match_distance = max(0, max(len1, len2) // 2 - 1)
    s1_matches = [False] * len1
    s2_matches = [False] * len2
    matches = 0
    for i in range(len1):
        start, end = max(0, i - match_distance), min(i + match_distance + 1, len2)
        for j in range(start, end):
            if s2_matches[j] or s1[i] != s2[j]:
                continue
            s1_matches[i] = s2_matches[j] = True
            matches += 1
            break
    if matches == 0:
        return 0.0
    transpositions = 0
    k = 0
    for i in range(len1):
        if not s1_matches[i]:
            continue
        while not s2_matches[k]:
            k += 1
        if s1[i] != s2[k]:
            transpositions += 1
        k += 1
    transpositions //= 2
    return (matches / len1 + matches / len2 + (matches - transpositions) / matches) / 3


def jaro_winkler(s1: str, s2: str) -> float:
    """Standard Winkler-boosted Jaro similarity (p=0.1, max 4-char common
    prefix bonus) — same parameters as Apache commons-text's
    JaroWinklerSimilarity, which the mobile app's GraphBuilder uses."""
    jaro = _jaro_similarity(s1, s2)
    prefix = 0
    for c1, c2 in zip(s1, s2):
        if c1 != c2:
            break
        prefix += 1
        if prefix == 4:
            break
    return jaro + prefix * 0.1 * (1 - jaro)


ACCEPT_THRESHOLD = 0.90  # matches GraphBuilder's acceptThreshold


def pair_dual_format(entries: list[dict]) -> None:
    """Mutates each entry's `book` dict in place, setting
    `book["pairedItemId"]` when a different entry is the same work in the
    complementary format. Each entry: {"book": <_book_summary() dict>,
    "meta": <raw ABS item.media.metadata dict>}."""
    ebooks: list[dict] = []
    audios: list[dict] = []
    for e in entries:
        book = e["book"]
        if book["numAudioFiles"] > 0 and book["hasEbook"]:
            continue  # already has both natively, nothing to pair
        meta = e["meta"]
        authors = meta.get("authors") or []
        primary_author = next((a.get("name") for a in authors if a.get("name")), None) or meta.get("authorName") or ""
        entry = {
            "book": book,
            "asin": (meta.get("asin") or "").strip().upper() or None,
            "isbn13": normalize_isbn(meta.get("isbn")),
            "title_norm": norm_title(book["title"]),
            "author_norm": norm_author(primary_author),
            "omnibus": is_omnibus(book["title"], book.get("subtitle")),
            "dramatized": is_dramatized(book["title"], book.get("subtitle")),
        }
        if book["hasEbook"]:
            ebooks.append(entry)
        elif book["numAudioFiles"] > 0:
            audios.append(entry)

    used_audio: set[int] = set()
    for e in ebooks:
        best_j, best_score = None, 0.0
        for j, a in enumerate(audios):
            if j in used_audio:
                continue
            if e["omnibus"] or a["omnibus"] or e["dramatized"] != a["dramatized"]:
                continue
            if e["asin"] and a["asin"]:
                if e["asin"] != a["asin"]:
                    continue
                score = 1.0
            elif e["isbn13"] and a["isbn13"]:
                if e["isbn13"] != a["isbn13"]:
                    continue
                score = 1.0
            else:
                if not e["author_norm"] or not a["author_norm"]:
                    continue
                author_sim = 1.0 if e["author_norm"] == a["author_norm"] else jaro_winkler(e["author_norm"], a["author_norm"])
                if author_sim < ACCEPT_THRESHOLD:
                    continue
                title_sim = jaro_winkler(e["title_norm"], a["title_norm"])
                score = 0.7 * title_sim + 0.3 * author_sim
            if score >= ACCEPT_THRESHOLD and score > best_score:
                best_score, best_j = score, j
        if best_j is not None:
            used_audio.add(best_j)
            e["book"]["pairedItemId"] = audios[best_j]["book"]["id"]
            audios[best_j]["book"]["pairedItemId"] = e["book"]["id"]
