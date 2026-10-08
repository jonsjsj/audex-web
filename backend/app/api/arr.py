"""Monitor & download via Codex's connected book *arr (Chaptarr / Readarr).

Proxies Codex's public /audex/arr/* gateway (the book-downloader twin of the /audex/align/*
gateway in readalong.py): the book is addressed by its Audiobookshelf item id, Codex resolves
title/author itself and routes the request through its own *arr, and no Codex login is needed —
so a client with only a Codex URL can still offer "monitor & download when released".

The whole feature is OPT-IN behind a connected *arr: /config reports `configured: false` when
Codex isn't set up OR Codex has no Chaptarr/Readarr enabled, and the UI hides the button then.
`identity` is required on every route purely as the auth GATE (signed in + ABS-linked, the same
bar as Player/Reader); it is never sent to Codex.
"""
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import resolve
from app.api.deps import get_current_identity
from app.core import activity
from app.core.config import settings
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/arr", tags=["arr"])


def _gateway() -> str:
    base = (settings.CODEX_URL or "").strip().rstrip("/")
    return f"{base}/audex/arr" if base else ""


@router.get("/config")
async def config(identity: Identity = Depends(get_current_identity)):
    """Is there a book downloader to offer? Any failure (no Codex, Codex down, old Codex without
    the gateway) is simply "not configured" — the button just doesn't show."""
    gw = _gateway()
    if not gw:
        return {"configured": False, "service": None}
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            r = await client.get(f"{gw}/config")
        if r.status_code == 200:
            data = r.json()
            return {"configured": bool(data.get("configured")), "service": data.get("service")}
    except (httpx.HTTPError, ValueError):
        pass
    return {"configured": False, "service": None}


@router.get("/{item_id}/status")
async def status(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    gw = _gateway()
    if not gw:
        return {"configured": False, "service": None, "present": False, "monitored": False}
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.get(f"{gw}/status/{abs_id}")
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach Codex.")
    if r.status_code != 200:
        raise HTTPException(502, "Couldn't check the book downloader.")
    return r.json()


class MonitorBody(BaseModel):
    fmt: str = "both"        # "audiobook" | "ebook" | "both"


@router.post("/{item_id}/monitor")
async def monitor(
    item_id: str, body: MonitorBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    gw = _gateway()
    if not gw:
        raise HTTPException(400, "No Codex instance is set up, so there's no book downloader to use.")
    if body.fmt not in ("audiobook", "ebook", "both"):
        raise HTTPException(422, "fmt must be audiobook, ebook or both")
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        # Searching can take a while (each indexer is queried), so allow a generous timeout.
        async with httpx.AsyncClient(timeout=90) as client:
            r = await client.post(f"{gw}/monitor/{abs_id}", json={"fmt": body.fmt})
    except httpx.HTTPError as e:
        await activity.record(identity.id, "downloads", "Monitor & download", False,
                              f"couldn't reach Codex: {activity.describe_error(e)}")
        raise HTTPException(502, "Couldn't reach Codex.")
    if r.status_code != 200:
        detail = r.json().get("detail") if r.headers.get("content-type", "").startswith("application/json") else None
        await activity.record(identity.id, "downloads", "Monitor & download", False,
                              detail or activity.describe_status(r.status_code))
        raise HTTPException(502, detail or "Couldn't start monitoring this book.")
    result = r.json()
    title = result.get("title") or "a book"
    await activity.record(identity.id, "downloads", "Monitor & download", bool(result.get("ok")),
                          f"{title}: {result.get('message') or ('monitoring' if result.get('ok') else 'not accepted')}")
    return result
