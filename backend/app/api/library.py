"""Library browsing — Phase 1. Thin projections over Audiobookshelf's own shapes
(see abs_client.py's module docstring) rather than a separate catalog graph: that
richer Authors→Series→Works matching the mobile app does is a later-phase concern
(§3 in the plan calls this lift "M" on purpose), not a Phase-1 blocker. The one
exception is dual-format edition pairing (catalog_match.py) — ABS sometimes
catalogs an item's audiobook and ebook as two separate library items instead of
one with both files, which needs *some* cross-item matching to offer a format
toggle at all; see that module's docstring for how it's scoped down from the
mobile app's full graph builder.
"""
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import AbsConn, connections_for_library, list_connections, resolve, tag
from app.api.deps import get_current_identity
from app.core import abs_client
from app.core.abs_client import AbsError
from app.core.catalog_match import pair_dual_format
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/library", tags=["library"])


def _book_summary(conn: AbsConn, item: dict, progress: dict | None = None) -> dict:
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
    tagged_id = tag(conn, item["id"])
    return {
        "id": tagged_id,
        "serverKey": conn.key,  # "" = primary; identifies which ABS server this came from
        "serverName": conn.name,
        "title": meta.get("title") or "(untitled)",
        "subtitle": meta.get("subtitle"),
        "author": author,
        "series": series,
        "durationS": media.get("duration"),
        "mediaType": item.get("mediaType", "book"),
        # `ebookFormat` (a string like "epub") is present on BOTH the library
        # LIST response and the expanded detail; `ebookFile` (the full file
        # object) only appears on the expanded detail. Keying `hasEbook` off
        # `ebookFile` alone left every library-card ebook undetected — no
        # ebook icon, an empty "Audio + ebook" filter, and no Read button.
        # The mobile app keys this off `ebookFormat` for exactly this reason
        # (CatalogRepositoryImpl: `hasEbook = !ebookFormat.isNullOrBlank()`).
        "hasEbook": bool(media.get("ebookFormat")) or bool(media.get("ebookFile")),
        "numAudioFiles": media.get("numAudioFiles", 0),
        "coverUrl": f"/api/library/items/{tagged_id}/cover",
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
        "publishedYear": meta.get("publishedYear"),  # string, e.g. "2013" — for "Released" sort
        "pairedItemId": None,  # set by catalog_match.pair_dual_format() via _run_pairing() below
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


def _narrator_names(item: dict) -> list[str]:
    """ABS has no dedicated Narrator entity (no id, no image, no bio API —
    unlike Author) — just a flat string list on the book's own metadata.

    Same list-endpoint-shape caveat as series and authors: the library LIST
    response often only carries the flat `narratorName` string ("A, B, C"),
    not the structured `narrators` array (that comes with the expanded
    single-item endpoint). Missing this fallback was why /narrators came back
    empty. The mobile app does the same: `narrators.ifEmpty { split(narratorName) }`."""
    meta = (item.get("media") or {}).get("metadata") or {}
    names = [n.strip() for n in (meta.get("narrators") or []) if (n or "").strip()]
    if not names and meta.get("narratorName"):
        names = [n.strip() for n in str(meta["narratorName"]).split(",") if n.strip()]
    return names


async def _conn_book_library_ids(conn: AbsConn) -> list[str]:
    """A connection's book-library ids (podcasts excluded, same as /libraries)."""
    libs = await abs_client.libraries(conn.base_url, conn.token)
    return [lib["id"] for lib in libs if lib.get("mediaType", "book") == "book"]


async def _progress_by_item(conn: AbsConn) -> dict[str, dict]:
    """One /api/me call per connection, reused for every book on the page.
    Best-effort: a failed fetch shows that server's books with no progress
    badges rather than failing the whole page over a secondary feature. Keyed
    by the RAW ABS item id (progress is looked up before the id is tagged)."""
    me = await abs_client.me(conn.base_url, conn.token)
    entries = (me or {}).get("mediaProgress") or []
    return {e["libraryItemId"]: e for e in entries if e.get("libraryItemId")}


async def _iter_books(
    identity: Identity, db: AsyncSession, library_sel: str
) -> list[tuple[AbsConn, dict, dict]]:
    """(connection, raw ABS item, tagged summary) across every connection the
    selection covers. Per-connection failures are tolerated (one unreachable
    extra server shouldn't blank the whole combined view); if every connection
    fails, that's surfaced as a 502 so a genuinely-down single server still
    reports an error rather than an empty library. The raw item is carried
    alongside the summary so the series/authors/narrators groupings can read
    its metadata without a second pass or leaking `_`-fields into responses."""
    pairs = await connections_for_library(identity, db, library_sel)
    if not pairs:
        raise HTTPException(400, "That Audiobookshelf server isn't connected.")
    triples: list[tuple[AbsConn, dict, dict]] = []
    ok = 0
    errors = 0
    for conn, lib_id in pairs:
        try:
            lib_ids = [lib_id] if lib_id else await _conn_book_library_ids(conn)
            progress = await _progress_by_item(conn)
            for lid in lib_ids:
                page = await abs_client.library_items(conn.base_url, conn.token, lid)
                for item in page.get("results", []):
                    triples.append((conn, item, _book_summary(conn, item, progress.get(item["id"]))))
            ok += 1
        except AbsError:
            errors += 1
            continue
    if ok == 0 and errors > 0:
        raise HTTPException(502, "Couldn't reach your Audiobookshelf server.")
    return triples


def _run_pairing(triples: list[tuple[AbsConn, dict, dict]]) -> None:
    entries = [
        {"book": book, "meta": (item.get("media") or {}).get("metadata") or {}}
        for _conn, item, book in triples
    ]
    pair_dual_format(entries)


async def _iter_books_paired(
    identity: Identity, db: AsyncSession, library_sel: str
) -> list[tuple[AbsConn, dict, dict]]:
    """_iter_books(), with pairedItemId resolved against the identity's FULL
    catalog — a book's other-format edition may live in a library the caller
    isn't currently browsing (see catalog_match.py). When library_sel is
    already "all" that's the same fetch, so no second round-trip; otherwise
    a broader "all libraries" scan finds the pair and its id is copied back
    onto the (separately fetched) items actually being returned."""
    triples = await _iter_books(identity, db, library_sel)
    if library_sel == "all":
        _run_pairing(triples)
        return triples
    all_triples = await _iter_books(identity, db, "all")
    _run_pairing(all_triples)
    paired_by_id = {b["id"]: b.get("pairedItemId") for _, _, b in all_triples}
    for _, _, b in triples:
        b["pairedItemId"] = paired_by_id.get(b["id"])
    return triples


@router.get("/libraries")
async def get_libraries(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    """Every book library across every connected server, ids tagged so the
    frontend can select one (or "all", the default combined view)."""
    out = []
    for conn in await list_connections(identity, db):
        try:
            libs = await abs_client.libraries(conn.base_url, conn.token)
        except AbsError:
            continue  # one unreachable server shouldn't blank the picker
        for lib in libs:
            if lib.get("mediaType", "book") != "book":  # podcasts are a later phase
                continue
            name = lib.get("name", "")
            out.append({
                "id": tag(conn, lib["id"]),
                "name": name,
                "mediaType": lib.get("mediaType", "book"),
                "serverKey": conn.key,
                "serverName": conn.name,
            })
    return out


@router.get("/items")
async def get_items(
    library_id: str = Query(..., alias="libraryId"),
    search: str = Query("", alias="search"),
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """One page covers a homelab-scale library; `search` filters title/author/
    series client-side (case-insensitive substring) rather than round-tripping to
    ABS's own filter query language, which the mobile app doesn't use either.
    `libraryId` may be "all" to combine every book library across every
    connected server into one view."""
    books = [b for _, _, b in await _iter_books_paired(identity, db, library_id)]
    if search.strip():
        q = search.strip().lower()
        books = [
            b for b in books
            if q in b["title"].lower() or q in (b["author"] or "").lower() or q in (b["series"] or "").lower()
        ]
    books.sort(key=lambda b: b["title"].lower())
    return {"items": books, "total": len(books)}


@router.get("/items/{item_id}")
async def get_item(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        item = await abs_client.item_detail(conn.base_url, conn.token, abs_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    media = item.get("media") or {}
    try:
        progress = await abs_client.get_progress(conn.base_url, conn.token, abs_id)
    except AbsError:
        # Best-effort, same as the library list: the book itself loaded fine,
        # don't fail the whole page over a progress badge.
        progress = None
    summary = _book_summary(conn, item, progress)
    summary["chapters"] = [
        {"id": c.get("id", 0), "startS": c.get("start", 0.0), "endS": c.get("end", 0.0), "title": c.get("title", "")}
        for c in media.get("chapters", [])
    ]
    summary.update(_book_detail_extra(item))
    # Best-effort: a book's other-format edition may be a whole separate
    # library item (see catalog_match.py) — scan every connected library for
    # one, but a failure here shouldn't break the detail page over a toggle.
    try:
        others = [t for t in await _iter_books(identity, db, "all") if t[2]["id"] != summary["id"]]
        _run_pairing([*others, (conn, item, summary)])
    except HTTPException:
        pass
    return summary


@router.get("/series")
async def get_series(
    library_id: str = Query(..., alias="libraryId"),
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Series grouped from the selected libraries' own items (not a Hardcover-
    style fill-in of volumes you don't own — Codex does that; this just
    organizes what's actually in your ABS libraries). `libraryId` may be "all"
    to combine every book library across every connected server."""
    groups: dict[str, list[tuple[float | None, dict]]] = {}
    for _conn, item, book in await _iter_books_paired(identity, db, library_id):
        for name, seq in _series_entries(item):
            groups.setdefault(name, []).append((seq, book))
    result = []
    for name, entries in groups.items():
        entries.sort(key=lambda e: (e[0] is None, e[0]))
        result.append({"name": name, "books": [b for _, b in entries]})
    result.sort(key=lambda g: g["name"].lower())
    return result


@router.get("/authors")
async def get_authors(
    library_id: str = Query(..., alias="libraryId"),
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Same idea as /series, grouped by author instead. Carries the (tagged)
    ABS author id when known so the frontend can show a real headshot via
    /authors/{id}/image instead of a book-cover stand-in. `libraryId` may be
    "all" to combine every book library across every connected server."""
    groups: dict[str, dict] = {}  # name -> {id, books}
    for conn, item, book in await _iter_books_paired(identity, db, library_id):
        for name, author_id in _author_entries(item):
            g = groups.setdefault(name, {"id": None, "books": []})
            if author_id and not g["id"]:
                # Tagged so the image/bio endpoints know which server to ask.
                g["id"] = tag(conn, author_id)
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


@router.get("/narrators")
async def get_narrators(
    library_id: str = Query(..., alias="libraryId"),
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Same idea as /authors, grouped by narrator instead. No id/imageUrl —
    ABS has no Narrator entity to look either up from (see _narrator_names).
    `libraryId` may be "all" to combine every book library across every
    connected server."""
    groups: dict[str, list[dict]] = {}
    for _conn, item, book in await _iter_books_paired(identity, db, library_id):
        for name in _narrator_names(item):
            groups.setdefault(name, []).append(book)
    result = [
        {"name": name, "books": sorted(books_, key=lambda b: b["title"].lower())}
        for name, books_ in groups.items()
    ]
    result.sort(key=lambda g: g["name"].lower())
    return result


@router.get("/authors/{author_id}/bio")
async def get_author_bio(
    author_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """A one-off ABS call, not embedded in /authors' list response — a bio can
    run to a paragraph or more, not worth shipping for every author on every
    library load when only the one being opened needs it."""
    conn, abs_id = await resolve(identity, db, author_id)
    detail = await abs_client.author_detail(conn.base_url, conn.token, abs_id)
    if not detail:
        return {"description": None}
    return {"description": detail.get("description")}


@router.get("/authors/{author_id}/image")
async def get_author_image(
    author_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Proxies an ABS author's headshot — same reasoning as /items/{id}/cover
    (an <img> tag can't carry the Bearer token). A 404 here (author has no
    photo set in ABS) is normal, not an error — the frontend falls back to
    initials rather than surfacing it."""
    conn, abs_id = await resolve(identity, db, author_id)
    url = abs_client.author_image_url(conn.base_url, abs_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {conn.token}"})
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
async def get_cover(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Proxies ABS's cover art — the browser needs an <img src>, and an <img> tag
    can't carry an Authorization header, so this is the one legitimate place a
    GET is forwarded with the token attached server-side rather than routed
    through fetch()+blob (simpler, and browsers cache <img> responses for free)."""
    conn, abs_id = await resolve(identity, db, item_id)
    url = abs_client.cover_url(conn.base_url, abs_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, headers={"Authorization": f"Bearer {conn.token}"})
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach Audiobookshelf for the cover.")
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, "Cover not available.")
    return StreamingResponse(
        iter([resp.content]),
        media_type=resp.headers.get("content-type", "image/jpeg"),
        headers={"Cache-Control": "public, max-age=86400"},
    )
