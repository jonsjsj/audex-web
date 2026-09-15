"""Per-identity preferences (Phase 5) — playback speed and reader font size, so
re-opening a book doesn't reset to 1x/100% every time. See UserSettings' own
docstring in core/database.py for why these are global-per-person rather than
per-book.
"""
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_identity
from app.core.database import Identity, UserSettings, get_db

router = APIRouter(prefix="/api/settings", tags=["settings"])


async def _get_or_create(db: AsyncSession, identity_id: int) -> UserSettings:
    row = (
        await db.execute(select(UserSettings).where(UserSettings.identity_id == identity_id))
    ).scalar_one_or_none()
    if row is None:
        row = UserSettings(identity_id=identity_id)
        db.add(row)
        await db.flush()
    return row


@router.get("")
async def get_settings(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    row = await _get_or_create(db, identity.id)
    await db.commit()
    return {"playbackSpeed": row.playback_speed, "readerFontSize": row.reader_font_size}


class UpdateSettingsBody(BaseModel):
    playbackSpeed: float | None = None
    readerFontSize: float | None = None


@router.put("")
async def update_settings(
    body: UpdateSettingsBody,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    row = await _get_or_create(db, identity.id)
    if body.playbackSpeed is not None:
        row.playback_speed = max(0.5, min(3.0, body.playbackSpeed))
    if body.readerFontSize is not None:
        row.reader_font_size = max(50.0, min(300.0, body.readerFontSize))
    await db.commit()
    return {"playbackSpeed": row.playback_speed, "readerFontSize": row.reader_font_size}
