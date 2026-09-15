"""Library browsing — Phase 1. Thin projections over Audiobookshelf's own shapes
(see abs_client.py's module docstring) rather than a separate catalog graph: that
richer Authors→Series→Works matching the mobile app does is a later-phase concern
(§3 in the plan calls this lift "M" on purpose), not a Phase-1 blocker.
"""
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
import httpx

from app.api.deps import get_abs_token
from app.core import abs_client
from app.core.abs_client import AbsError

router = APIRouter(prefix="/api/library", tags=["library"])


def _book_summary(item: dict) -> dict:
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
    }


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
    books = [_book_summary(item) for item in page.get("results", [])]
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
    summary = _book_summary(item)
    summary["chapters"] = [
        {"id": c.get("id", 0), "startS": c.get("start", 0.0), "endS": c.get("end", 0.0), "title": c.get("title", "")}
        for c in media.get("chapters", [])
    ]
    return summary


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
