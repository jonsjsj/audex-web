import time

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import Identity, WebSession, get_db
from app.core.security import decrypt_value


async def get_current_identity(
    db: AsyncSession = Depends(get_db),
    session_id: str | None = Cookie(default=None, alias="audexweb_session"),
) -> Identity:
    """Resolve the session cookie → the signed-in Identity, or 401. The cookie carries
    only an opaque id (see core/security.new_session_id) — this is the one place that
    id is dereferenced back to a person."""
    if not session_id:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in.")
    row = (await db.execute(select(WebSession).where(WebSession.id == session_id))).scalar_one_or_none()
    if not row or row.expires_at < time.time():
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired.")
    identity = (await db.execute(select(Identity).where(Identity.id == row.identity_id))).scalar_one_or_none()
    if not identity:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not signed in.")
    return identity


async def get_optional_identity(
    db: AsyncSession = Depends(get_db),
    session_id: str | None = Cookie(default=None, alias="audexweb_session"),
) -> Identity | None:
    if not session_id:
        return None
    try:
        return await get_current_identity(db, session_id)
    except HTTPException:
        return None


async def get_abs_token(identity: Identity = Depends(get_current_identity)) -> str:
    """The signed-in identity's decrypted Audiobookshelf token — every library/
    play/stream endpoint depends on this rather than re-deriving it, so "not
    linked to ABS yet" is one 400 in one place instead of a null check per route."""
    if not identity.abs_token_encrypted:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No Audiobookshelf account connected.")
    token = decrypt_value(identity.abs_token_encrypted)
    if not token:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Audiobookshelf connection is invalid — reconnect it.")
    return token


async def get_codex_token(identity: Identity = Depends(get_current_identity)) -> str | None:
    """Unlike get_abs_token, Codex sync is OPTIONAL — same as the mobile app,
    where a blank/off Codex setting just no-ops the push rather than blocking
    anything. Returns None (never raises) when not linked, so callers can
    `if token:` instead of catching a 400 they'd have to ignore anyway."""
    if not identity.codex_token_encrypted:
        return None
    return decrypt_value(identity.codex_token_encrypted) or None
