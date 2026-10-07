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


ACCEPT_THRESHOLD = 0.95  # title-only similarity; authors/numbers/series are checked separately

_SERIES_SEQ_RE = re.compile(r"^(.*?)\s*#\s*([\d.]+)\s*$")
_SEGMENT_SPLIT_RE = re.compile(r"\s*(?::|\u2014|\s-\s)\s*")
_BOOK_N_TAIL_RE = re.compile(r"[,]?\s*\b(book|vol|vol\.|volume)\s+\d+(\.\d+)?$")
_NUM_TOKEN_RE = re.compile(r"(?<![a-z])\d+(?:\.\d+)?(?![a-z])")


def title_segments(title: str) -> list[str]:
    """The title cut into its ':'-separated parts, each normalized, with the
    parts publishers vary freely ("A Novel", "Book One of X", "…, Book 13")
    dropped. ABS items for the same work are often titled differently per
    edition — "Name 13: A LitRPG Adventure" vs "Name 13: A LitRPG Adventure:
    Name, Book 13" — so identity is judged part by part (see _same_work)."""
    raw = _PARENTHETICAL_RE.sub(" ", title)
    out: list[str] = []
    for part in _SEGMENT_SPLIT_RE.split(raw):
        p = _basic(part)
        p = _BOOK_N_TAIL_RE.sub("", p).strip(" ,")
        if not p or _SUBTITLE_DROPPABLE_RE.match(p):
            continue
        if not out:
            p = _LEADING_ARTICLE_RE.sub("", p)
        p = _WHITESPACE_RE.sub(" ", _NON_ALNUM_RE.sub(" ", p).replace("#", " ")).strip()
        if p:
            out.append(p)
    return out


def author_tokens(meta: dict) -> set[str]:
    """Every word of every credited author. "Deverell, Travis" + "Shirtaloon"
    and "Shirtaloon" + "Travis Deverell" are the same people listed in a
    different order / name format — a word bag compares them correctly where
    comparing just the first-listed author string does not."""
    names = [a.get("name") for a in (meta.get("authors") or []) if a.get("name")]
    if not names and meta.get("authorName"):
        names = [meta["authorName"]]
    # What Audiobookshelf itself lists, when Codex's checked metadata replaced it (see codex_overlay): the two
    # editions are compared on either spelling, so a correction made to only one of them can't split the pair.
    names += [n for n in (meta.get("_authorsAbs") or []) if n]
    toks: set[str] = set()
    for n in names:
        toks.update(t for t in norm_author(n.replace(",", " ")).split(" ") if len(t) > 1)
    return toks


def series_keys(meta: dict) -> list[tuple[str, float | None]]:
    out: list[tuple[str, float | None]] = []
    for s in meta.get("series") or []:
        name = norm_title(s.get("name") or "")
        if name:
            out.append((name, _to_float(s.get("sequence"))))
    if not out and meta.get("seriesName"):
        m = _SERIES_SEQ_RE.match(str(meta["seriesName"]).strip())
        raw, seq = (m.group(1), _to_float(m.group(2))) if m else (str(meta["seriesName"]), None)
        name = norm_title(raw)
        if name:
            out.append((name, seq))
    return out


def _to_float(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _series_relation(a: list[tuple[str, float | None]], b: list[tuple[str, float | None]]) -> str:
    """"same" (same series, same position), "conflict" (same series, different
    position — certainly a different book), or "unknown"."""
    rel = "unknown"
    for na, sa in a:
        for nb, sb in b:
            if na != nb:
                continue
            if sa is None or sb is None:
                continue
            if sa == sb:
                return "same"
            rel = "conflict"
    return rel


def _numbers(seg: str) -> set[str]:
    return set(_NUM_TOKEN_RE.findall(seg))


def _title_score(ta: list[str], tb: list[str]) -> float:
    """1.0 when one title's parts are a leading run of the other's (the same
    work with a longer/shorter subtitle); otherwise Jaro-Winkler of the whole
    normalized title. Two different volume numbers in the lead part always
    score 0 — "Monsters 12" vs "Monsters 13" is a one-character difference to
    a fuzzy matcher but a different book."""
    if not ta or not tb:
        return 0.0
    na, nb = _numbers(ta[0]), _numbers(tb[0])
    if na and nb and na != nb:
        return 0.0
    n = min(len(ta), len(tb))
    if ta[:n] == tb[:n]:
        return 1.0
    return jaro_winkler(" ".join(ta), " ".join(tb))


def pair_dual_format(entries: list[dict], joins=frozenset(), splits=frozenset()) -> None:
    """Mutates each entry's `book` dict in place, setting
    `book["pairedItemId"]` when a different entry is the same work in the
    complementary format. Each entry: {"book": <_book_summary() dict>,
    "meta": <raw ABS item.media.metadata dict>}.

    `joins` / `splits` are the person's own decisions — sets of frozenset({id_a, id_b}). A join is applied FIRST
    and is never moved by the automatic matching; a split is never paired automatically.

    Identity cascade: matching ASIN or ISBN-13 wins outright. Otherwise the
    title (part by part, see _title_score) must match AND the credited authors
    must share their names — unless both items sit at the same position of
    the same series, which stands in for the author check (pen names and
    co-author lists differ between an ebook and its audiobook)."""
    ebooks: list[dict] = []
    audios: list[dict] = []
    for e in entries:
        book = e["book"]
        if book["numAudioFiles"] > 0 and book["hasEbook"]:
            continue  # already has both natively, nothing to pair
        meta = e["meta"]
        entry = {
            "book": book,
            "asin": (meta.get("asin") or "").strip().upper() or None,
            "isbn13": normalize_isbn(meta.get("isbn")),
            "segments": title_segments(book["title"]),
            "authors": author_tokens(meta),
            "series": series_keys(meta),
            "omnibus": is_omnibus(book["title"], book.get("subtitle")),
            "dramatized": is_dramatized(book["title"], book.get("subtitle")),
        }
        if book["hasEbook"]:
            ebooks.append(entry)
        elif book["numAudioFiles"] > 0:
            audios.append(entry)

    used_audio: set[int] = set()
    used_ebook: set[int] = set()
    # 1) The person's own joins — absolute.
    for i, e in enumerate(ebooks):
        for j, a in enumerate(audios):
            if j in used_audio or frozenset((e["book"]["id"], a["book"]["id"])) not in joins:
                continue
            used_ebook.add(i)
            used_audio.add(j)
            e["book"]["pairedItemId"] = a["book"]["id"]
            a["book"]["pairedItemId"] = e["book"]["id"]
            break
    # 2) Everything else by identity.
    for i, e in enumerate(ebooks):
        if i in used_ebook:
            continue
        best_j, best_score = None, 0.0
        for j, a in enumerate(audios):
            if j in used_audio:
                continue
            if frozenset((e["book"]["id"], a["book"]["id"])) in splits:
                continue
            if e["omnibus"] or a["omnibus"] or e["dramatized"] != a["dramatized"]:
                continue
            if (e["asin"] and e["asin"] == a["asin"]) or (e["isbn13"] and e["isbn13"] == a["isbn13"]):
                score = 10.0
            else:
                # A Kindle ASIN and an Audible ASIN are different by nature,
                # so differing ids prove nothing — fall through to the title.
                rel = _series_relation(e["series"], a["series"])
                if rel == "conflict":
                    continue
                title = _title_score(e["segments"], a["segments"])
                if title < ACCEPT_THRESHOLD:
                    continue
                overlap = 0.0
                if e["authors"] and a["authors"]:
                    overlap = len(e["authors"] & a["authors"]) / min(len(e["authors"]), len(a["authors"]))
                if overlap <= 0.5 and rel != "same":
                    continue
                score = title + overlap + (0.5 if rel == "same" else 0.0)
            if score > best_score:
                best_score, best_j = score, j
        if best_j is not None:
            used_audio.add(best_j)
            e["book"]["pairedItemId"] = audios[best_j]["book"]["id"]
            audios[best_j]["book"]["pairedItemId"] = e["book"]["id"]
