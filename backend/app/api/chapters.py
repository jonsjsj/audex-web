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
