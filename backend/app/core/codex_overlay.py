"""Apply Codex's checked metadata onto raw Audiobookshelf library items.

The library endpoints build every view (cards, series, authors, narrators, search, sort) from the raw ABS
item's `media.metadata`. Overlaying Codex's values onto that raw metadata BEFORE any of them run means the
corrected author/series/narrator/year/description is used everywhere at once — a book Codex moved into a
series sorts and groups there — without touching each view. The rule is per field: Codex's value if it has
one, else ABS's (a missing key is "no opinion", never a blank).
"""
import re

_AUTHOR_SPLIT = re.compile(r"\s*(?:,|;|&|\band\b|\+)\s*", re.I)


def _key(name: str) -> str:
    return re.sub(r"[^0-9a-z]+", "", (name or "").lower())


def _seq(pos) -> str:
    try:
        return ("%g" % float(pos))
    except (TypeError, ValueError):
        return ""


def overlay_item(item: dict, entry: dict | None) -> bool:
    """Mutate `item` (a raw ABS library item) with Codex's fields. Returns True if anything changed."""
    fields = (entry or {}).get("fields") or {}
    if not fields:
        return False
    media = item.setdefault("media", {})
    meta = media.setdefault("metadata", {})
    changed = False

    def put(key, value):
        nonlocal changed
        if meta.get(key) != value:
            meta[key] = value
            changed = True

    if fields.get("title"):
        put("title", fields["title"])
    if fields.get("author"):
        names = [n for n in _AUTHOR_SPLIT.split(fields["author"]) if n.strip()]
        ids = {_key(a.get("name")): a.get("id") for a in (meta.get("authors") or []) if a.get("name")}
        put("authors", [({"id": ids[_key(n)], "name": n} if ids.get(_key(n)) else {"name": n}) for n in names])
        put("authorName", ", ".join(names))
    if fields.get("narrator"):
        names = [n.strip() for n in fields["narrator"].split(",") if n.strip()]
        put("narrators", names)
        put("narratorName", ", ".join(names))
    if fields.get("series_name"):
        seq = _seq(fields.get("series_position")) if fields.get("series_position") is not None else ""
        old = (meta.get("series") or [{}])[0] if meta.get("series") else {}
        sid = old.get("id") if _key(old.get("name")) == _key(fields["series_name"]) else None
        entry_ = {"name": fields["series_name"], "sequence": seq}
        if sid:
            entry_["id"] = sid
        put("series", [entry_])
        put("seriesName", f"{fields['series_name']} #{seq}" if seq else fields["series_name"])
    if fields.get("year"):
        put("publishedYear", str(fields["year"]))
    if fields.get("description"):
        put("description", fields["description"])
    return changed
