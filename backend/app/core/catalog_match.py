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


_SERIES_TRAILING_NUMBER_RE = re.compile(r"(\s*#\s*\d+(\.\d+)?|,?\s+book\s+\d+(\.\d+)?|\s+\d+(\.\d+)?)$")
_SERIES_SUFFIX_WORD_RE = re.compile(
    r"\s+(trilogy|quartet|quintet|sextet|saga|series|novels?|cycle|sequence|chronicles|companion books?)$"
)
_POSITION_SUFFIX_RE = re.compile(r"^(?P<stem>.+?)[,:]?\s+(book|vol\.?|volume)\s+(?P<num>\d+(\.\d+)?)$")
_HASH_SUFFIX_RE = re.compile(r"^(?P<stem>.+?)\s*#(?P<num>\d+(\.\d+)?)$")


def norm_series(name: str) -> str:
    """Series identity key (port of Audex's Normalize.normSeries): drops a leading article, trailing marketing
    words ("… Series", "… Trilogy") and trailing numbering ("#1", ", Book 2")."""
    s = _basic(name)
    s = _LEADING_ARTICLE_RE.sub("", s)
    while True:
        prev = s
        s = _SERIES_TRAILING_NUMBER_RE.sub("", s)
        s = _SERIES_SUFFIX_WORD_RE.sub("", s)
        s = s.strip().rstrip(",:-\u2013 ")
        if s == prev:
            break
    return _WHITESPACE_RE.sub(" ", _NON_ALNUM_RE.sub(" ", s).replace("#", " ")).strip()


def recover_series_position(title: str, known: set[str]) -> tuple[str, float] | None:
    """Series + position for an item whose own metadata has no series, found from its TITLE against the series
    other items are known to be in (port of Audex's recoverSeriesPosition, plus the "<Series> 13: Subtitle"
    form): "Dungeon Crawler Carl Book 3", "Cradle #1", "Unsouled (Cradle #1)", "He Who Fights with Monsters 13: …"."""
    if not known:
        return None
    for m in _PARENTHETICAL_RE.finditer(title):
        inner = _basic(m.group(0)[1:-1])  # the text inside the (…) or […]
        hit = _HASH_SUFFIX_RE.match(inner) or _POSITION_SUFFIX_RE.match(inner)
        if hit and norm_series(hit.group("stem")) in known:
            return norm_series(hit.group("stem")), float(hit.group("num"))
    flat = _basic(_PARENTHETICAL_RE.sub(" ", title))
    for rx in (_POSITION_SUFFIX_RE, _HASH_SUFFIX_RE):
        hit = rx.match(flat)
        if hit and norm_series(hit.group("stem")) in known:
            return norm_series(hit.group("stem")), float(hit.group("num"))
    head = _WHITESPACE_RE.sub(" ", _NON_ALNUM_RE.sub(" ", _LEADING_ARTICLE_RE.sub("", flat)).replace("#", " ")).strip()
    for series in sorted(known, key=len, reverse=True):
        hit = re.match(rf"^{re.escape(series)}\s+(?:(?:book|vol|volume)\s+)?(\d+)(?:\s|$)", head)
        if hit:
            return series, float(hit.group(1))
    return None


def title_info(title: str, known: set[str] = frozenset()) -> tuple[list[str], set[str]]:
    """(parts, volume numbers). The title cut into its ':'-separated parts, each normalized, with the parts
    publishers vary freely ("A Novel", "Book One of X", "…, Book 13") dropped — and, like Audex, a leading
    "<series> 13" part and any subtitle that just names the series, when the series is known. The volume numbers
    are read from the FIRST part before that clean-up, so "Monsters 12" and "Monsters 13" never look alike."""
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
    numbers = _numbers(out[0]) if out else set()
    if known and len(out) > 1 and norm_series(out[0]) in known:
        out = out[1:]
    if known and len(out) > 1:
        kept = [seg for i, seg in enumerate(out) if i == 0 or not any(k and k in seg for k in known)]
        out = kept or out
    return out, numbers


def title_segments(title: str, known: set[str] = frozenset()) -> list[str]:
    return title_info(title, known)[0]


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
        name = norm_series(s.get("name") or "")
        if name:
            out.append((name, _to_float(s.get("sequence"))))
    if not out and meta.get("seriesName"):
        m = _SERIES_SEQ_RE.match(str(meta["seriesName"]).strip())
        raw, seq = (m.group(1), _to_float(m.group(2))) if m else (str(meta["seriesName"]), None)
        name = norm_series(raw)
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


def _title_score(ia: tuple[list[str], set[str]], ib: tuple[list[str], set[str]]) -> float:
    """1.0 when one title's parts are a leading run of the other's (the same work with a longer/shorter subtitle);
    otherwise Jaro-Winkler of the whole normalized title. Two different volume numbers always score 0 —
    "Monsters 12" vs "Monsters 13" is a one-character difference to a fuzzy matcher but a different book."""
    (ta, na), (tb, nb) = ia, ib
    if not ta or not tb:
        return 0.0
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
    # Every series any item is known to be in — used to read a series + number out of a bare title.
    known = {name for e in entries for name, _pos in series_keys(e["meta"])}
    for e in entries:
        book = e["book"]
        if book["numAudioFiles"] > 0 and book["hasEbook"]:
            continue  # already has both natively, nothing to pair
        meta = e["meta"]
        entry = {
            "book": book,
            "asin": (meta.get("asin") or "").strip().upper() or None,
            "isbn13": normalize_isbn(meta.get("isbn")),
            "title": title_info(book["title"], known),
            "authors": author_tokens(meta),
            "series": series_keys(meta),
            "omnibus": is_omnibus(book["title"], book.get("subtitle")),
            "dramatized": is_dramatized(book["title"], book.get("subtitle")),
        }
        omnibus = entry["omnibus"]
        if not entry["series"]:
            hit = recover_series_position(book["title"], known)
            if hit:
                entry["series"] = [(hit[0], None if omnibus else hit[1])]
        if book["hasEbook"]:
            ebooks.append(entry)
        elif book["numAudioFiles"] > 0:
            audios.append(entry)

    used_audio: set[int] = set()
    used_ebook: set[int] = set()
    # 1) The person's own joins — absolute.
    for i, e in enumerate(ebooks):
        for j, a in enumerate(audios):
            pair = frozenset((e["book"]["id"], a["book"]["id"]))
            if j in used_audio or pair not in joins or pair in splits:
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
                    continue  # same series, different volume — certainly a different book
                title = _title_score(e["title"], a["title"])
                overlap = 0.0
                if e["authors"] and a["authors"]:
                    overlap = len(e["authors"] & a["authors"]) / min(len(e["authors"]), len(a["authors"]))
                if rel == "same":
                    # Same series, same volume: that identifies the book (Audex's series-position rule) — the
                    # titles may differ completely ("Dungeon Crawler Carl Book 3" vs "The Dungeon Anarchist's
                    # Cookbook"). The authors must agree, unless the titles do (pen name vs real name).
                    if overlap <= 0.5 and title < 0.8:
                        continue
                    score = 2.0 + overlap + title
                else:
                    if title < ACCEPT_THRESHOLD or overlap <= 0.5:
                        continue
                    score = title + overlap
            if score > best_score:
                best_score, best_j = score, j
        if best_j is not None:
            used_audio.add(best_j)
            e["book"]["pairedItemId"] = audios[best_j]["book"]["id"]
            audios[best_j]["book"]["pairedItemId"] = e["book"]["id"]
