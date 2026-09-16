"""Library browsing — Phase 1. Thin projections over Audiobookshelf's own shapes
(see abs_client.py's module docstring) rather than a separate catalog graph: that
richer Authors→Series→Works matching the mobile app does is a later-phase concern
(§3 in the plan calls this lift "M" on purpose), not a Phase-1 blocker.
"""
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
import httpx

from app.api.deps import get_abs_token
from app.core import abs_client
from app.core.abs_client import AbsError

router = APIRouter(prefix="/api/library", tags=["library"])


def _book_summary(item: dict, progress: dict | None = None) -> dict:
    media = item.get("media") or {}
    meta = media.get("metadata") or {}
    authors = meta.get("authors") or []
    author = ", ".join(a["name"] for a in authors if a.get("name")) or meta.get("authorName") or None
    series_list = meta.get("series") or []
    series = None
    if series_list:
        s = series_list[0]
        series = s.get("name")
        seq = s.get("sequence")
        if series and seq:
            series = f"{series} #{seq}"
    elif meta.get("seriesName"):
        series = meta["seriesName"]
    p = progress or {}
    # A book with BOTH an audio and ebook progress % (rare — most ABS items are
    # one format) shows whichever is further along, same idea as the mobile
    # app's cross-edition "furthest wins": one progress bar per library card,
    # not two competing ones.
    pct = max(float(p.get("progress") or 0), float(p.get("ebookProgress") or 0))
    return {
        "id": item["id"],
        "title": meta.get("title") or "(untitled)",
        "subtitle": meta.get("subtitle"),
        "author": author,
        "series": series,
        "durationS": media.get("duration"),
        "mediaType": item.get("mediaType", "book"),
        "hasEbook": bool(media.get("ebookFile")),
        "numAudioFiles": media.get("numAudioFiles", 0),
        "coverUrl": f"/api/library/items/{item['id']}/cover",
        "progress": pct,
        "isFinished": bool(p.get("isFinished")),
        "lastUpdate": p.get("lastUpdate"),  # epoch ms, or None if never opened — for sorting "Continue"
        # The two RAW per-medium fractions (not just the merged `progress` above)
        # — Player/Reader use these to work out which medium is further along and
        # auto-resume the OTHER one there via the read-along sync map, the same
        # "furthest wins" idea this file already applies for the library card.
        "audioProgress": float(p.get("progress") or 0),
        "ebookProgress": float(p.get("ebookProgress") or 0),
        "audioTimeS": float(p.get("currentTime") or 0),
        "addedAt": item.get("addedAt"),  # epoch ms — for "date added" sort
    }


def _book_detail_extra(item: dict) -> dict:
    """The metadata fields worth a whole detail page but not a library card —
    kept out of _book_summary (used by the list AND detail endpoints) so
    browsing a library of hundreds of books doesn't ship every description."""
    meta = (item.get("media") or {}).get("metadata") or {}
    narrators = meta.get("narrators") or []
    return {
        "description": meta.get("description"),
        "narrator": ", ".join(narrators) if narrators else None,
        "publisher": meta.get("publisher"),
        "publishedYear": meta.get("publishedYear"),
        "genres": meta.get("genres") or [],
        "language": meta.get("language"),
        "isbn": meta.get("isbn"),
        "asin": meta.get("asin"),
    }


def _series_entries(item: dict) -> list[tuple[str, float | None]]:
    """All (seriesName, sequence) pairs on an item — almost always one, ABS
    allows more than one series membership so this doesn't assume just one.

    The library LIST endpoint (library_items(), used here) doesn't always
    return the structured `series: [{name, sequence}]` array the expanded
    single-item endpoint does — some ABS versions/configs only give a flat
    `seriesName` string ("Name #3") instead, same as _book_summary already
    has to handle. Missing this fallback was why /series came back empty."""
    meta = (item.get("media") or {}).get("metadata") or {}
    out: list[tuple[str, float | None]] = []
    series_list = meta.get("series") or []
    if series_list:
        for s in series_list:
            name = s.get("name")
            if not name:
                continue
            seq = s.get("sequence")
            try:
                seq_f = float(seq) if seq not in (None, "") else None
            except (TypeError, ValueError):
                seq_f = None
            out.append((name, seq_f))
    elif meta.get("seriesName"):
        raw = str(meta["seriesName"]).strip()
        m = re.match(r"^(.*?)\s*#\s*([\d.]+)\s*$", raw)
        if m:
            out.append((m.group(1).strip(), _safe_float(m.group(2))))
        else:
            out.append((raw, None))
    return out


def _safe_float(v) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _author_entries(item: dict) -> list[tuple[str, str | None]]:
    """(name, authorId) pairs — the id (when ABS gives one) is what lets the
    Authors page show a real headshot via /api/library/authors/{id}/image
    instead of a book-cover stand-in."""
    meta = (item.get("media") or {}).get("metadata") or {}
    authors = meta.get("authors") or []
    if authors:
        return [(a["name"], a.get("id")) for a in authors if a.get("name")]
    if meta.get("authorName"):
        # Same list-endpoint-shape caveat as series — a flat string, possibly
        # multiple authors joined with ", " (ABS's own convention), no id.
        return [(name.strip(), None) for name in meta["authorName"].split(",") if name.strip()]
    return []


@router.get("/libraries")
async def get_libraries(token: str = Depends(get_abs_token)):
    try:
        libs = await abs_client.libraries(token)
    except AbsError as e:
        raise HTTPException(502, str(e))
    return [
        {"id": lib["id"], "name": lib.get("name", ""), "mediaType": lib.get("mediaType", "book")}
        for lib in libs
        if lib.get("mediaType", "book") == "book"  # podcasts are a separate later phase
    ]


async def _progress_by_item(token: str) -> dict[str, dict]:
    """One /api/me call, reused for every book on the page — the same shape
    already relied on elsewhere (abs_client.me(), get_progress()'s single-item
    GET). Best-effort: a failed fetch shows the library with no progress
    badges rather than failing the whole page over a secondary feature."""
    me = await abs_client.me(token)
    entries = (me or {}).get("mediaProgress") or []
    return {e["libraryItemId"]: e for e in entries if e.get("libraryItemId")}


@router.get("/items")
async def get_items(
    library_id: str = Query(..., alias="libraryId"),
    search: str = Query("", alias="search"),
    token: str = Depends(get_abs_token),
):
    """One page covers a homelab-scale library; `search` filters title/author/
    series client-side (case-insensitive substring) rather than round-tripping to
    ABS's own filter query language, which the mobile app doesn't use either."""
    try:
        page = await abs_client.library_items(token, library_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    progress = await _progress_by_item(token)
    books = [_book_summary(item, progress.get(item["id"])) for item in page.get("results", [])]
    if search.strip():
        q = search.strip().lower()
        books = [
            b for b in books
            if q in b["title"].lower() or q in (b["author"] or "").lower() or q in (b["series"] or "").lower()
        ]
    books.sort(key=lambda b: b["title"].lower())
    return {"items": books, "total": len(books)}


@router.get("/items/{item_id}")
async def get_item(item_id: str, token: str = Depends(get_abs_token)):
    try:
        item = await abs_client.item_detail(token, item_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    media = item.get("media") or {}
    try:
        progress = await abs_client.get_progress(token, item_id)
    except AbsError:
        # Best-effort, same as the library list: the book itself loaded fine,
        # don't fail the whole page over a progress badge.
        progress = None
    summary = _book_summary(item, progress)
    summary["chapters"] = [
        {"id": c.get("id", 0), "startS": c.get("start", 0.0), "endS": c.get("end", 0.0), "title": c.get("title", "")}
        for c in media.get("chapters", [])
    ]
    summary.update(_book_detail_extra(item))
    return summary


@router.get("/series")
async def get_series(library_id: str = Query(..., alias="libraryId"), token: str = Depends(get_abs_token)):
    """Series grouped from this library's own items (not a Hardcover-style
    fill-in of volumes you don't own — Codex does that; this just organizes
    what's actually in your ABS library). Books embedded directly rather than
    a separate per-series fetch: a homelab-scale library's whole item list
    already fits in one call (see library_items()'s own docstring)."""
    try:
        page = await abs_client.library_items(token, library_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    progress = await _progress_by_item(token)
    groups: dict[str, list[tuple[float | None, dict]]] = {}
    for item in page.get("results", []):
        entries = _series_entries(item)
        if not entries:
            continue
        book = _book_summary(item, progress.get(item["id"]))
        for name, seq in entries:
            groups.setdefault(name, []).append((seq, book))
    result = []
    for name, entries in groups.items():
        entries.sort(key=lambda e: (e[0] is None, e[0]))
        result.append({"name": name, "books": [b for _, b in entries]})
    result.sort(key=lambda g: g["name"].lower())
    return result


@router.get("/authors")
async def get_authors(library_id: str = Query(..., alias="libraryId"), token: str = Depends(get_abs_token)):
    """Same idea as /series, grouped by author instead. Carries the ABS
    author id (when known) so the frontend can show a real headshot via
    /authors/{id}/image instead of a book-cover stand-in."""
    try:
        page = await abs_client.library_items(token, library_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    progress = await _progress_by_item(token)
    groups: dict[str, dict] = {}  # name -> {id, books}
    for item in page.get("results", []):
        entries = _author_entries(item)
        if not entries:
            continue
        book = _book_summary(item, progress.get(item["id"]))
        for name, author_id in entries:
            g = groups.setdefault(name, {"id": None, "books": []})
            if author_id and not g["id"]:
                g["id"] = author_id
            g["books"].append(book)
    result = [
        {
            "name": name,
            "id": g["id"],
            "imageUrl": f"/api/library/authors/{g['id']}/image" if g["id"] else None,
            "books": sorted(g["books"], key=lambda b: b["title"].lower()),
        }
        for name, g in groups.items()
    ]
    result.sort(key=lambda g: g["name"].lower())
    return result


@router.get("/authors/{author_id}/image")
async def get_author_image(author_id: str, token: str = Depends(get_abs_token)):
    """Proxies an ABS author's headshot — same reasoning as /items/{id}/cover
    (an <img> tag can't carry the Bearer token). A 404 here (author has no
    photo set in ABS) is normal, not an error — the frontend falls back to
    initials rather than surfacing it."""
    url = abs_client.author_image_url(author_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach Audiobookshelf for this author's photo.")
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, "No photo for this author.")
    return StreamingResponse(
        iter([resp.content]),
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/items/{item_id}/cover")
async def get_cover(item_id: str, token: str = Depends(get_abs_token)):
    """Proxies ABS's cover art — the browser needs an <img src>, and an <img> tag
    can't carry an Authorization header, so this is the one legitimate place a
    GET is forwarded with the token attached server-side rather than routed
    through fetch()+blob (simpler, and browsers cache <img> responses for free)."""
    url = abs_client.cover_url(item_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach Audiobookshelf for the cover.")
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, "Cover not available.")
    return StreamingResponse(
        iter([resp.content]),
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400"},
    )
