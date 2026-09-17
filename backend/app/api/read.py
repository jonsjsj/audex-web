"""Ebook reading — Phase 2. Downloads the ebook file from ABS once per opened
book, parses it into a Readium Web Publication Manifest (epub.py — none of the
@readium/* packages do this themselves, see its module docstring), and serves
the manifest + individual resources for @readium/navigator's HttpFetcher to
consume. Position (a Readium Locator) round-trips through ABS's own
`ebookLocation`/`ebookProgress` fields, same as the mobile app.
"""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import AbsConn, resolve
from app.api.deps import get_current_identity
from app.core import abs_client
from app.core.abs_client import AbsError
from app.core.database import Identity, get_db
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


async def _get_parsed(conn: AbsConn, identity_id: int, item_id: str, abs_id: str) -> ParsedEpub:
    # Cache key uses the NAMESPACED id so two servers' items can't collide.
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
        data = await abs_client.ebook_file(conn.base_url, conn.token, abs_id)
        parsed = parse_epub(data)  # raises EpubError — let the caller turn that into a 422
        if len(_cache) >= _CACHE_MAX:
            del _cache[next(iter(_cache))]  # dict preserves insertion order — drop the oldest
        _cache[key] = parsed
        return parsed


@router.get("/{item_id}/manifest")
async def get_manifest(
    item_id: str,
    request: Request,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        parsed = await _get_parsed(conn, identity.id, item_id, abs_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    except EpubError as e:
        raise HTTPException(422, str(e))
    # MUST be absolute (scheme + host), not just a path: @readium/shared's
    # Manifest.baseURL strips the last segment off this `self` link to get
    # the publication's base, and @readium/navigator feeds that straight into
    # each reading frame's Content-Security-Policy as an allowed domain. A
    # relative URL there is a syntactically invalid CSP source — the browser
    # drops it silently (visible only as a console warning, not an error the
    # app sees), which starves every directive down to 'unsafe-inline'/blob:
    # only and leaves each chapter frame stuck never becoming visible.
    # uvicorn isn't told to trust proxy headers (no --proxy-headers flag), so
    # request.base_url reflects the scheme of the raw connection from
    # whatever's directly in front of it (NPMplus/Cloudflare), not what the
    # browser actually used — check X-Forwarded-Proto ourselves rather than
    # bake in an http:// URL a browser loaded over https will reject as a
    # mixed-content CSP source.
    scheme = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.url.netloc)
    # The trailing path segment here is never actually fetched — Readium
    # only strips it off to compute pub.baseURL (see Manifest.baseURL: "the
    # URL with the `self` Link's last path segment removed"). What's left
    # MUST be the same root the readingOrder/resources hrefs are relative
    # to, i.e. RES_BASE (.../res/) on the frontend, not the bare item route
    # — every chapter's own HTML sets a <base> from THIS base for its OWN
    # relative refs (stylesheet.css, images/...), so pointing it at
    # .../api/read/{id}/ instead of .../res/ 404s every such reference
    # (as text/html from our SPA fallback, not even a real 404 body).
    self_url = f"{scheme}://{host}/api/read/{item_id}/res/manifest"
    return build_manifest(parsed, self_url=self_url)


@router.get("/{item_id}/res/{path:path}")
async def get_resource(
    item_id: str,
    path: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        parsed = await _get_parsed(conn, identity.id, item_id, abs_id)
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
async def get_position(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """The saved Locator (as JSON) to resume from, or None for a book that's
    never been opened — distinct from a genuinely-empty book, so the frontend
    can tell "start at the beginning" from "we don't know yet, don't move"."""
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        prog = await abs_client.get_progress(conn.base_url, conn.token, abs_id)
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
async def save_position(
    item_id: str, body: SavePositionBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        await abs_client.save_ebook_progress(
            conn.base_url, conn.token, abs_id, ebook_location=json.dumps(body.locator), ebook_progress=body.progress,
        )
    except AbsError as e:
        raise HTTPException(502, str(e))
    return {"ok": True}


@router.delete("/{item_id}/position")
async def discard_position(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Discard ebook progress — see play.py's discard_progress for the audio
    side; each format's own progress can be wrong independently (ABS keeps
    them on the SAME record, but a book bought as audio-only vs ebook-only
    never shares one, so there's no cross-format entanglement to worry about
    here the way the mobile app's cross-edition model has to)."""
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        await abs_client.delete_progress(conn.base_url, conn.token, abs_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    return {"ok": True}
