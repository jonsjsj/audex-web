"""Read-along (word-sync) — Phase 4. Proxies Codex's public /audex/align/*
gateway (see docs/SYNC_API.md §3) rather than talking to the alignment
service directly: Codex computes the book-key from its OWN stored ABS
connection, so this backend never needs to match a serverUrl string byte for
byte — it only ever needs the ABS item id, the same id every other route
here already uses. No Codex auth token required; those gateway routes are
deliberately public specifically so a client with only a Codex URL (no
login) can still use it.

`token` is required on every route below purely as an auth GATE (signed in +
ABS-linked, same bar as Player/Reader) — it's never sent anywhere, since the
proxied calls don't need it.
"""
import asyncio

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import connections_for_library, resolve
from app.api.deps import get_current_identity
from app.api.library import _iter_books_paired
from app.core import abs_client
from app.core.abs_client import AbsError
from app.core.config import align_gateway_url, settings
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/readalong", tags=["readalong"])


def _configured() -> bool:
    return bool(settings.CODEX_URL or settings.ALIGN_GATEWAY_URL)


@router.get("/bulk-status")
async def bulk_status(
    library_id: str = Query(..., alias="libraryId"),
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Read-along availability for every book in a library that could ever
    have one — either a single item with both an audio and an ebook edition,
    or a pairedItemId cross-item match (see catalog_match.py) — powers the
    library grid's third icon. Not configured, or no eligible books → {},
    not an error.

    Only the PRIMARY connection is queried: Codex computes the book-key from
    its own single ABS connection, so read-along only exists for that server —
    extra servers' items just stay "not built" (the frontend default)."""
    if not _configured():
        return {}
    eligible: list[str] = []
    for conn, lib_id in await connections_for_library(identity, db, library_id):
        if not conn.is_primary:
            continue
        try:
            libs = await abs_client.libraries(conn.base_url, conn.token)
            lib_ids = [lib_id] if lib_id else [
                lib["id"] for lib in libs if lib.get("mediaType", "book") == "book"
            ]
            for lid in lib_ids:
                page = await abs_client.library_items(conn.base_url, conn.token, lid)
                # Eligibility keys off `ebookFormat` (present in the LIST
                # response), not `ebookFile` (only on the expanded detail) —
                # keying off ebookFile left this always empty.
                eligible += [
                    item["id"] for item in page.get("results", [])
                    if ((item.get("media") or {}).get("ebookFormat") or (item.get("media") or {}).get("ebookFile"))
                    and (item.get("media") or {}).get("numAudioFiles", 0) > 0
                ]
        except AbsError:
            return {}

    # Cross-item pairs — the align gateway keys status by the AUDIO item's
    # id (same anchor /build already uses), so a paired ebook-only item's
    # status is really its paired audio item's status. Primary-server only,
    # same reasoning as above (serverKey == "" tags a primary item).
    ebook_to_audio: dict[str, str] = {}
    try:
        for _conn, _item, book in await _iter_books_paired(identity, db, library_id):
            if book["serverKey"] or not book["pairedItemId"]:
                continue
            if book["hasEbook"] and book["numAudioFiles"] == 0:
                ebook_to_audio[book["id"]] = book["pairedItemId"]
    except HTTPException:
        pass

    query_ids = set(eligible) | set(ebook_to_audio.values())
    if not query_ids:
        return {}

    # Bounded concurrency — a library with a lot of dual-format books
    # shouldn't fire 100+ simultaneous requests at the align gateway.
    sem = asyncio.Semaphore(8)

    async def _one(item_id: str) -> tuple[str, bool]:
        async with sem:
            try:
                async with httpx.AsyncClient(timeout=8) as client:
                    r = await client.get(f"{align_gateway_url()}/status/{item_id}")
                if r.status_code == 200:
                    return item_id, bool(r.json().get("available"))
            except httpx.HTTPError:
                pass
        return item_id, False

    results = await asyncio.gather(*(_one(i) for i in query_ids))
    # Primary items are bare-tagged, so their abs id IS their frontend id.
    by_audio_id = dict(results)
    out = {item_id: available for item_id, available in results if item_id in eligible}
    for ebook_id, audio_id in ebook_to_audio.items():
        out[ebook_id] = by_audio_id.get(audio_id, False)
        out[audio_id] = by_audio_id.get(audio_id, False)
    return out


@router.get("/{item_id}/status")
async def status(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    if not _configured():
        return {"configured": False, "available": False, "state": "none", "progress": 0.0, "etaSeconds": None}
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{align_gateway_url()}/status/{abs_id}")
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(502, "Read-along status check failed.")
    data = r.json()
    return {
        "configured": data.get("configured", True),
        "available": data.get("available", False),
        "state": data.get("state", "none"),
        "progress": data.get("progress", 0.0),
        "etaSeconds": data.get("eta_seconds"),
    }


class BuildBody(BaseModel):
    ebookItemId: str | None = None


@router.post("/{item_id}/build")
async def build(
    item_id: str, body: BuildBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    if not _configured():
        raise HTTPException(400, "Read-along isn't configured on this server (no Codex instance set).")
    _conn, abs_id = await resolve(identity, db, item_id)
    payload: dict = {}
    if body.ebookItemId:
        # An ebook pair id may itself be namespaced; strip to the real abs id.
        _c2, ebook_abs = await resolve(identity, db, body.ebookItemId)
        payload["ebook_item_id"] = ebook_abs
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{align_gateway_url()}/build/{abs_id}", json=payload)
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        # Forward Codex's own detail (e.g. "No Audiobookshelf connection is
        # set up in Codex.") rather than a generic message — it's the one
        # piece of information the user can actually act on.
        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else None
        raise HTTPException(502, detail or "Couldn't start the read-along build.")
    return r.json()


@router.get("/{item_id}/map")
async def get_map(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """The full sync map — see docs/SYNC_API.md §3 for the shape. Passed
    through byte-for-byte (not re-modeled into camelCase like everything
    else here, and not re-serialized through r.json()/a dict return) since
    it's a large, book-scale JSON payload the frontend parses directly — an
    extra parse+reshape+re-dump pass would just cost time for no benefit,
    unlike the small responses every other route here reshapes."""
    if not _configured():
        raise HTTPException(404, "No read-along map for this book.")
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(f"{align_gateway_url()}/map/{abs_id}")
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(404, "No read-along map for this book yet.")
    return Response(content=r.content, media_type="application/json")
