"""Ebook reading — Phase 2. Downloads the ebook file from ABS once per opened
book, parses it into a Readium Web Publication Manifest (epub.py — none of the
@readium/* packages do this themselves, see its module docstring), and serves
the manifest + individual resources for @readium/navigator's HttpFetcher to
consume. Position (a Readium Locator) round-trips through ABS's own
`ebookLocation`/`ebookProgress` fields, same as the mobile app.
"""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from app.api.deps import get_abs_token, get_current_identity
from app.core import abs_client
from app.core.abs_client import AbsError
from app.core.database import Identity
from app.core.epub import EpubError, ParsedEpub, build_manifest, parse_epub

router = APIRouter(prefix="/api/read", tags=["read"])

# In-process cache of parsed EPUBs, so the navigator's many resource requests
# for one reading session don't each re-download + re-unzip the whole file
# from ABS. Keyed by (identity id, item id); a homelab-scale personal reader
# doesn't need anything sturdier than "keep the last few opened books" — this
# is deliberately NOT a persistent cache (an ABS-side ebook file replacement
# should be picked up on the next process restart, not held stale forever).
_CACHE_MAX = 4
_cache: dict[tuple[int, str], ParsedEpub] = {}
_cache_locks: dict[tuple[int, str], asyncio.Lock] = {}


async def _get_parsed(token: str, identity_id: int, item_id: str) -> ParsedEpub:
    key = (identity_id, item_id)
    cached = _cache.get(key)
    if cached is not None:
        return cached
    # One lock per key: concurrent resource requests for the SAME book (the
    # navigator fires several as soon as a chapter loads) must wait for the
    # first download+parse rather than each independently re-fetching the
    # whole file from ABS; a DIFFERENT book's request isn't blocked by it.
    lock = _cache_locks.setdefault(key, asyncio.Lock())
    async with lock:
        cached = _cache.get(key)  # re-check: someone else may have filled it while we waited
        if cached is not None:
            return cached
        data = await abs_client.ebook_file(token, item_id)
        parsed = parse_epub(data)  # raises EpubError — let the caller turn that into a 422
        if len(_cache) >= _CACHE_MAX:
            del _cache[next(iter(_cache))]  # dict preserves insertion order — drop the oldest
        _cache[key] = parsed
        return parsed


@router.get("/{item_id}/manifest")
async def get_manifest(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    token: str = Depends(get_abs_token),
):
    try:
        parsed = await _get_parsed(token, identity.id, item_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    except EpubError as e:
        raise HTTPException(422, str(e))
    return build_manifest(parsed, self_url=f"/api/read/{item_id}/manifest")


@router.get("/{item_id}/res/{path:path}")
async def get_resource(
    item_id: str,
    path: str,
    identity: Identity = Depends(get_current_identity),
    token: str = Depends(get_abs_token),
):
    try:
        parsed = await _get_parsed(token, identity.id, item_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    except EpubError as e:
        raise HTTPException(422, str(e))
    try:
        content = parsed.read(path)
    except EpubError:
        raise HTTPException(404, "Resource not found in this book.")
    media_type = parsed.media_type_for(path) or "application/octet-stream"
    return Response(
        content=content, media_type=media_type,
        headers={"Cache-Control": "private, max-age=3600"},  # the parsed book won't change mid-session
    )


@router.get("/{item_id}/position")
async def get_position(item_id: str, token: str = Depends(get_abs_token)):
    """The saved Locator (as JSON) to resume from, or None for a book that's
    never been opened — distinct from a genuinely-empty book, so the frontend
    can tell "start at the beginning" from "we don't know yet, don't move"."""
    try:
        prog = await abs_client.get_progress(token, item_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    raw = prog.get("ebookLocation") if prog else None
    if not raw:
        return {"locator": None}
    try:
        locator = json.loads(raw)
    except (TypeError, ValueError):
        # A locator written by a different client in a format we don't
        # recognise (e.g. an epubcfi string from the mobile app's own
        # reader) — resuming from scratch beats crashing the reader open.
        locator = None
    return {"locator": locator}


class SavePositionBody(BaseModel):
    locator: dict
    progress: float  # 0..1 fraction through the whole book, for ebookProgress


@router.put("/{item_id}/position")
async def save_position(item_id: str, body: SavePositionBody, token: str = Depends(get_abs_token)):
    try:
        await abs_client.save_ebook_progress(
            token, item_id, ebook_location=json.dumps(body.locator), ebook_progress=body.progress,
        )
    except AbsError as e:
        raise HTTPException(502, str(e))
    return {"ok": True}
