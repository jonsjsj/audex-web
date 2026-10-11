"""Chapter names + numbers heard from the narration — Phase 5.

Proxies Codex's /audex/chapters/{item} gateway (see Codex api/audex_chapters.py): the align service
listens to the start of every chapter and Codex serves the result, addressed by the Audiobookshelf
item id like the read-along map in readalong.py. The result is OPTIONAL — a book Codex hasn't listened to
yet (or no Codex at all) is simply `{chapters: []}` and the player falls back to the file's own titles.

`identity` is the auth GATE only (signed in + ABS-linked, same bar as Player); it is never sent to Codex.
"""
import httpx
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import resolve
from app.api.deps import get_current_identity
from app.core.config import settings
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/chapters", tags=["chapters"])


def _gateway() -> str:
    base = (settings.CODEX_URL or "").strip().rstrip("/")
    return f"{base}/audex/chapters" if base else ""


async def synthesized_chapters(abs_id: str) -> list[dict]:
    """A book Audiobookshelf has NO chapter list for (a single file with no markers) can still have chapters: Codex
    finds them by listening for the narrator's "Chapter N" after long pauses. Returned in the shape the player and the
    book page already use ({id, startS, endS, title}); empty when there is no Codex, no such document, or the book
    has real chapters in Audiobookshelf (the caller only asks when it has none)."""
    gw = _gateway()
    if not gw:
        return []
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{gw}/{abs_id}")
        if r.status_code != 200:
            return []
        data = r.json()
    except (httpx.HTTPError, ValueError):
        return []
    if not data.get("synthesized"):
        return []
    return [
        {"id": i, "startS": float(c.get("start") or 0.0), "endS": float(c.get("end") or 0.0), "title": c.get("label") or ""}
        for i, c in enumerate(data.get("chapters") or [])
    ]


@router.get("/{item_id}/heard")
async def heard(
    item_id: str,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    gw = _gateway()
    if not gw:
        return {"chapters": []}
    _conn, abs_id = await resolve(identity, db, item_id)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(f"{gw}/{abs_id}")
        if r.status_code == 200:
            data = r.json()
            return {"generatedAt": data.get("generatedAt"), "chapters": data.get("chapters") or []}
    except (httpx.HTTPError, ValueError):
        pass
    return {"chapters": []}
