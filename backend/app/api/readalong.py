"""Read-along (word-sync) — Phase 4. Proxies Codex's public /audex/align/*
gateway (see docs/SYNC_API.md §3) rather than talking to the alignment
service directly: Codex computes the book-key from its OWN stored ABS
connection, so this backend never needs to match a serverUrl string byte for
byte — it only ever needs the ABS item id, the same id every other route
here already uses. No Codex auth token required; those gateway routes are
deliberately public specifically so a client with only a Codex URL (no
login) can still use it.

Codex now requires a Codex key to START a build and, in its strict mode, for every
gateway call (docs/SYNC_API.md §3), and keeps each person's own map pick per Codex
user. So every call carries the signed-in person's linked Codex key when they have
one (Settings → Codex); without one the read calls still work against a default
Codex and a build is refused with Codex's own how-to-fix message.
"""
import asyncio

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import connections_for_library, resolve
from app.api.deps import get_codex_token, get_current_identity
from app.api.library import _iter_books_paired
from app.core import abs_client, activity
from app.core.abs_client import AbsError
from app.core.config import align_gateway_url, settings
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/readalong", tags=["readalong"])


def _configured() -> bool:
    return bool(settings.CODEX_URL or settings.ALIGN_GATEWAY_URL)


def _auth(codex_token: str | None) -> dict:
    """The person's own Codex key for the gateway, when they linked one."""
    return {"Authorization": f"Bearer {codex_token}"} if codex_token else {}


def _codex_detail(r: httpx.Response, fallback: str) -> str:
    """Codex's own words for what went wrong ({"detail": ...}) — the one thing the person can act on."""
    try:
        if r.headers.get("content-type", "").startswith("application/json"):
            detail = (r.json() or {}).get("detail")
            if isinstance(detail, str) and detail.strip():
                return detail
    except ValueError:
        pass
    return fallback


def shape_version(v: dict) -> dict:
    """One map version as the frontend sees it (camelCase). `createdAt` is UTC ISO: the browser formats it."""
    return {
        "id": v.get("id"),
        "createdAt": v.get("created_at"),
        "source": v.get("source"),
        "model": v.get("model"),
        "device": v.get("device"),
        "anchors": v.get("anchors"),
        "durationS": v.get("duration_s"),
        "size": v.get("size"),
        "requestedBy": v.get("requested_by"),
        "isDefault": bool(v.get("is_default")),
        "isMine": bool(v.get("is_mine")),
    }


def shape_maps(data: dict) -> dict:
    return {
        "default": data.get("default"),
        "mine": data.get("mine"),
        "versions": [shape_version(v) for v in data.get("versions", []) if v.get("id")],
        "canManage": bool(data.get("can_manage")),
    }


@router.get("/bulk-status")
async def bulk_status(
    library_id: str = Query(..., alias="libraryId"),
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
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
        for _conn, _item, book in await _iter_books_paired(identity, db, library_id, merge=False):
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
                    r = await client.get(f"{align_gateway_url()}/status/{item_id}", headers=_auth(codex_token))
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
    codex_token: str | None = Depends(get_codex_token),
):
    if not _configured():
        return {"configured": False, "available": False, "state": "none", "progress": 0.0, "etaSeconds": None}
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{align_gateway_url()}/status/{abs_id}", headers=_auth(codex_token))
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(502, "Read-along status check failed.")
    data = r.json()
    out = {
        "configured": data.get("configured", True),
        "available": data.get("available", False),
        "state": data.get("state", "none"),
        "progress": data.get("progress", 0.0),
        "etaSeconds": data.get("eta_seconds"),
    }
    # A NEW map is being built next to the one that exists (re-align / re-transcribe).
    if isinstance(data.get("rebuild"), dict):
        out["rebuild"] = {"state": data["rebuild"].get("state"), "progress": data["rebuild"].get("progress")}
    # Present only when state == "error" (docs/SYNC_API.md §3, "Descriptive
    # failures"): which phase died, what happened, and `hint` — a plain-language
    # next step written for whoever pressed "Align". Passing it through is what
    # lets the UI say WHY an alignment failed instead of just "error".
    err = data.get("error")
    if isinstance(err, dict):
        out["error"] = {
            "stage": err.get("stage"),
            "message": err.get("message"),
            "hint": err.get("hint"),
        }
        await activity.record(
            identity.id, "read-along", "Read-along map failed", False,
            f"while {err.get('stage') or 'working'}: {err.get('message') or 'unknown error'}"
            + (f" - {err['hint']}" if err.get("hint") else ""),
            dedupe_s=900)
    return out


class BuildBody(BaseModel):
    ebookItemId: str | None = None


@router.post("/{item_id}/build")
async def build(
    item_id: str, body: BuildBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
):
    if not _configured():
        raise HTTPException(400, "Read-along isn't configured on this server (no Codex instance set).")
    _conn, abs_id = await resolve(identity, db, item_id)
    # Who asked — shown on the Align dashboard's job list ("Audex Web · jonsj").
    who = identity.abs_username or identity.display_name or identity.email or "someone"
    payload: dict = {"requestedBy": f"Audex Web · {who}"}
    if body.ebookItemId:
        # An ebook pair id may itself be namespaced; strip to the real abs id.
        _c2, ebook_abs = await resolve(identity, db, body.ebookItemId)
        payload["ebook_item_id"] = ebook_abs
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{align_gateway_url()}/build/{abs_id}", json=payload, headers=_auth(codex_token))
    except httpx.HTTPError as e:
        why = activity.describe_error(e)
        await activity.record(identity.id, "read-along", "Build read-along map", False,
                              f"couldn't reach Codex's read-along service: {why}")
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        # Forward Codex's own detail (e.g. "No Audiobookshelf connection is
        # set up in Codex.") rather than a generic message — it's the one
        # piece of information the user can actually act on.
        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else None
        await activity.record(identity.id, "read-along", "Build read-along map", False,
                              detail or activity.describe_status(r.status_code))
        raise HTTPException(502, detail or "Couldn't start the read-along build.")
    result = r.json()
    await activity.record(identity.id, "read-along", "Build read-along map", True,
                          "already built" if result.get("state") == "done" else
                          f"started ({result.get('state') or 'queued'}) - progress shows on the book")
    return result


@router.get("/{item_id}/map")
async def get_map(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
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
            r = await client.get(f"{align_gateway_url()}/map/{abs_id}", headers=_auth(codex_token))
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(404, "No read-along map for this book yet.")
    return Response(content=r.content, media_type="application/json")


# ---- map versions ------------------------------------------------------------------------------------------------
# Every map built for a book is kept with the date it was made; one is the default for everybody and each person
# can pick another for themselves (stored in Codex against their Codex key, so Audex and Audex Web agree).
# Deleting a map or choosing the default for everyone is done in Codex by an admin.


@router.get("/{item_id}/maps")
async def list_maps(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
):
    if not _configured():
        return {"default": None, "mine": None, "versions": [], "canManage": False}
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{align_gateway_url()}/maps/{abs_id}", headers=_auth(codex_token))
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(502 if r.status_code >= 500 else 403, _codex_detail(r, "Couldn't list the read-along maps."))
    return shape_maps(r.json())


class ChoiceBody(BaseModel):
    version: str | None = None


@router.put("/{item_id}/maps/choice")
async def choose_map(
    item_id: str, body: ChoiceBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
):
    """Use one map just for you (`version` = its id), or null to follow the default again."""
    if not _configured():
        raise HTTPException(400, "Read-along isn't configured on this server (no Codex instance set).")
    if not codex_token:
        raise HTTPException(403, "Link your Codex key in Settings to choose a map.")
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.put(f"{align_gateway_url()}/maps/{abs_id}/choice", json={"version": body.version},
                                 headers=_auth(codex_token))
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        raise HTTPException(502 if r.status_code >= 500 else 403, _codex_detail(r, "Couldn't change the map."))
    return {"ok": True, "mine": r.json().get("mine")}


class NewMapBody(BaseModel):
    kind: str
    ebookItemId: str | None = None
    title: str | None = None


@router.post("/{item_id}/maps/new")
async def new_map(
    item_id: str, body: NewMapBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
):
    """Add another map next to the existing ones: `realign` (seconds, from the saved transcript) or `transcribe`
    (hours, listens to the audio again). Neither replaces the default."""
    if body.kind not in ("realign", "transcribe"):
        raise HTTPException(400, "kind must be 'realign' or 'transcribe'.")
    if not _configured():
        raise HTTPException(400, "Read-along isn't configured on this server (no Codex instance set).")
    if not codex_token:
        raise HTTPException(403, "Link your Codex key in Settings to ask for a new map.")
    _conn, abs_id = await resolve(identity, db, item_id)
    who = identity.abs_username or identity.display_name or identity.email or "someone"
    payload: dict = {"kind": body.kind, "requestedBy": f"Audex Web · {who}"}
    if body.title:
        payload["title"] = body.title[:200]
    if body.ebookItemId:
        _c2, ebook_abs = await resolve(identity, db, body.ebookItemId)
        payload["ebook_item_id"] = ebook_abs
    try:
        async with httpx.AsyncClient(timeout=200) as client:     # a re-align builds the map before it answers
            r = await client.post(f"{align_gateway_url()}/maps/{abs_id}/new", json=payload, headers=_auth(codex_token))
    except httpx.HTTPError as e:
        await activity.record(identity.id, "read-along", "New read-along map", False,
                              f"couldn't reach Codex's read-along service: {activity.describe_error(e)}")
        raise HTTPException(502, "Couldn't reach the read-along service.")
    if r.status_code != 200:
        detail = _codex_detail(r, "Couldn't ask for a new map.")
        await activity.record(identity.id, "read-along", "New read-along map", False, detail)
        raise HTTPException(502 if r.status_code >= 500 else 409 if r.status_code == 409 else 403, detail)
    data = r.json()
    await activity.record(identity.id, "read-along", "New read-along map", True,
                          "added" if data.get("state") == "done" else "queued - it appears in the list when it is ready")
    return {"ok": True, "state": data.get("state"), "version": shape_version(data["version"]) if data.get("version") else None}
