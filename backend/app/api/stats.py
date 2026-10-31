"""Stats — how long a person listened and how many pages they read (the same screen the Audex app has).

Listening is Audiobookshelf's own record (every device, back to the start) and is passed through as daily totals plus
a per-book total. Reading has no such record anywhere, so the reader counts pages turned forward one at a time and
the time it was in use, and adds them here per day and book. Everything the screen shows (today / week / all time,
history by day / month / year / book, records, streaks, pace) is worked out in the browser from these two series.
"""
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import list_connections
from app.api.deps import get_current_identity
from app.core import abs_client
from app.core.database import Identity, ReadingStat, get_db

router = APIRouter(prefix="/api/stats", tags=["stats"])

_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# One report covers a few minutes of reading; anything bigger is a bug or someone playing with the API.
MAX_PAGES_PER_REPORT = 60
MAX_SECONDS_PER_REPORT = 1800.0


class ReadingReport(BaseModel):
    itemId: str
    title: str = ""
    day: str  # the reader's own local date, YYYY-MM-DD
    pages: int = 0
    seconds: float = 0.0


def clean_report(body: ReadingReport) -> tuple[int, float]:
    """(pages, seconds) to add, or 400 for a report that can't be right."""
    if not _DAY.match(body.day) or not (1 <= len(body.itemId) <= 200):
        raise HTTPException(400, "That reading report isn't valid.")
    pages = max(0, min(MAX_PAGES_PER_REPORT, int(body.pages)))
    seconds = max(0.0, min(MAX_SECONDS_PER_REPORT, float(body.seconds)))
    return pages, seconds


@router.post("/reading")
async def add_reading(
    body: ReadingReport,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    pages, seconds = clean_report(body)
    if pages == 0 and seconds == 0:
        return {"ok": True}
    row = (
        await db.execute(
            select(ReadingStat).where(
                ReadingStat.identity_id == identity.id, ReadingStat.day == body.day, ReadingStat.item_id == body.itemId
            )
        )
    ).scalar_one_or_none()
    if row is None:
        row = ReadingStat(identity_id=identity.id, day=body.day, item_id=body.itemId, title=body.title[:300], pages=0, seconds=0.0)
        db.add(row)
    row.pages = (row.pages or 0) + pages
    row.seconds = (row.seconds or 0.0) + seconds
    if body.title:
        row.title = body.title[:300]
    await db.commit()
    return {"ok": True}


@router.get("")
async def get_stats(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ReadingStat).where(ReadingStat.identity_id == identity.id))).scalars().all()
    reading = [
        {"day": r.day, "itemId": r.item_id, "title": r.title or "", "pages": r.pages or 0, "seconds": r.seconds or 0.0}
        for r in rows
    ]

    listening: dict | None = None
    conns = await list_connections(identity, db)
    primary = next((c for c in conns if c.is_primary), None)
    if primary:
        try:
            raw = await abs_client.listening_stats(primary.base_url, primary.token)
        except abs_client.AbsError:
            raw = None
        if raw is not None:
            days = {
                d: float(s) for d, s in (raw.get("days") or {}).items() if isinstance(d, str) and _DAY.match(d) and isinstance(s, (int, float))
            }
            items = [
                {
                    "itemId": i.get("id") or key,
                    "title": ((i.get("mediaMetadata") or {}).get("title")) or "",
                    "s": float(i.get("timeListening") or 0.0),
                }
                for key, i in (raw.get("items") or {}).items()
                if isinstance(i, dict)
            ]
            listening = {"totalS": float(raw.get("totalTime") or sum(days.values())), "days": days, "items": items}
    return {"listening": listening, "reading": reading}
