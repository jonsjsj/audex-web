import time

from fastapi import Cookie, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import Identity, WebSession, get_db


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
