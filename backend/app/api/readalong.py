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

from app.api.deps import get_abs_token
from app.core import abs_client
from app.core.abs_client import AbsError
from app.core.config import align_gateway_url, settings

router = APIRouter(prefix="/api/readalong", tags=["readalong"])


def _configured() -> bool:
    return bool(settings.CODEX_URL or settings.ALIGN_GATEWAY_URL)


@router.get("/bulk-status")
async def bulk_status(library_id: str = Query(..., alias="libraryId"), token: str = Depends(get_abs_token)):
    """Read-along availability for every book in a library that could ever
    have one (both an audio and an ebook edition on the SAME item) — powers
    the library grid's third icon (docs/SYNC_API.md's "same item" case;
    cross-item pairing isn't attempted, same scope limit as the rest of this
    phase). Not configured, or no eligible books → {}, not an error."""
    if not _configured():
        return {}
    try:
        page = await abs_client.library_items(token, library_id)
    except AbsError:
        return {}
    eligible = [
        item["id"] for item in page.get("results", [])
        if (item.get("media") or {}).get("ebookFile") and (item.get("media") or {}).get("numAudioFiles", 0) > 0
    ]
    if not eligible:
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

    results = await asyncio.gather(*(_one(i) for i in eligible))
    return {item_id: available for item_id, available in results}


@router.get("/{item_id}/status")
async def status(item_id: str, token: str = Depends(get_abs_token)):
    if not _configured():
        return {"configured": False, "available": False, "state": "none", "progress": 0.0, "etaSeconds": None}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{align_gateway_url()}/status/{item_id}")
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
async def build(item_id: str, body: BuildBody, token: str = Depends(get_abs_token)):
    if not _configured():
        raise HTTPException(400, "Read-along isn't configured on this server (no Codex instance set).")
    payload: dict = {}
    if body.ebookItemId:
        payload["ebook_item_id"] = body.ebookItemId
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{align_gateway_url()}/build/{item_id}", json=payload)
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
async def get_map(item_id: str, token: str = Depends(get_abs_token)):
    """The full sync map — see docs/SYNC_API.md §3 for the shape. Passed
    through byte-for-byte (not re-modeled into camelCase like everything
    else here, and not re-serialized through r.json()/a dict return) since
    it's a large, book-scale JSON payload the frontend parses directly — an
    extra parse+reshape+re-dump pass would just cost time for no benefit,
    unlike the small responses every other route here reshapes."""
    if not _configured():
        raise HTTPException(404, "No read-along map for this book.")
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            r = await client.get(f"{align_gateway_url()}/map/{item_id}")
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(404, "No read-along map for this book yet.")
    return Response(content=r.content, media_type="application/json")
