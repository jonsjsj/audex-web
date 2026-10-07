"""Per-identity preferences (Phase 5) — playback speed and reader font size, so
re-opening a book doesn't reset to 1x/100% every time. See UserSettings' own
docstring in core/database.py for why these are global-per-person rather than
per-book.
"""
import json
import re

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
    return _out(row)


# Reader appearance — docs/READER_APPEARANCE.md. Validated here so a bad client can't store junk.
_THEMES = {"auto", "light", "dark", "sepia", "custom"}
_FONTS = {"publisher", "serif", "sans", "mono", "georgia", "palatino", "times", "arial", "verdana", "courier", "custom"}
_FONT_NAME = re.compile(r"^[A-Za-z0-9 _'-]{1,60}$")
# Spacing ranges — identical in the Audex app (docs/READER_APPEARANCE.md); null = the book's own.
_SPACING = {"lineSpacing": (1.0, 2.5), "paragraphSpacing": (0.0, 2.0), "letterSpacing": (0.0, 0.5), "wordSpacing": (0.0, 1.0)}


def _spacing(raw: dict, key: str):
    v = raw.get(key)
    if v is None or v == "":
        return None
    try:
        lo, hi = _SPACING[key]
        return round(max(lo, min(hi, float(v))), 3)
    except (TypeError, ValueError):
        return None
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
FONT_MIN_PT, FONT_MAX_PT, NORMAL_PT = 9, 48, 12


def clean_appearance(raw: dict | None, fallback_percent: float = 100.0) -> dict:
    """Text size is in points (12 = the book's normal size). Older saves held a percent
    (`fontSize`, 100 = normal) — converted on the way in."""
    raw = raw if isinstance(raw, dict) else {}
    try:
        if raw.get("fontSizePt") is not None:
            size = float(raw["fontSizePt"])
        else:
            size = float(raw.get("fontSize", fallback_percent)) * NORMAL_PT / 100.0
    except (TypeError, ValueError):
        size = NORMAL_PT
    return {
        "fontSizePt": round(max(FONT_MIN_PT, min(FONT_MAX_PT, size))),
        "theme": raw.get("theme") if raw.get("theme") in _THEMES else "auto",
        "font": raw.get("font") if raw.get("font") in _FONTS else "publisher",
        "fontName": raw["fontName"].strip() if isinstance(raw.get("fontName"), str) and _FONT_NAME.match(raw["fontName"].strip()) else "",
        **{k: _spacing(raw, k) for k in _SPACING},
        "textColor": raw["textColor"] if isinstance(raw.get("textColor"), str) and _HEX.match(raw["textColor"]) else "#1a1a1a",
        "backgroundColor": raw["backgroundColor"] if isinstance(raw.get("backgroundColor"), str) and _HEX.match(raw["backgroundColor"]) else "#ffffff",
    }


def _out(row: UserSettings) -> dict:
    try:
        stored = json.loads(row.reader_appearance) if row.reader_appearance else None
    except ValueError:
        stored = None
    return {
        "playbackSpeed": row.playback_speed, "readerFontSize": row.reader_font_size,
        "useCodexMeta": row.use_codex_meta is not False,
        "readerAppearance": clean_appearance(stored, row.reader_font_size or 100.0),
    }


class UpdateSettingsBody(BaseModel):
    playbackSpeed: float | None = None
    readerFontSize: float | None = None
    useCodexMeta: bool | None = None
    readerAppearance: dict | None = None


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
    if body.useCodexMeta is not None:
        row.use_codex_meta = body.useCodexMeta
    if body.readerAppearance is not None:
        clean = clean_appearance(body.readerAppearance, row.reader_font_size or 100.0)
        row.reader_appearance = json.dumps(clean)
        row.reader_font_size = clean["fontSizePt"] * 100.0 / NORMAL_PT  # legacy percent column, kept in step
    await db.commit()
    return _out(row)
