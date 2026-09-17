import time
from typing import AsyncGenerator

from sqlalchemy import Column, Integer, String, Float, Boolean, ForeignKey
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings


class Base(DeclarativeBase):
    pass


class Identity(Base):
    """One signed-in person. Created either by their first OIDC login (sub/email from
    the IdP) or by the ABS-credential fallback (no oidc_sub). `abs_token` is the ABS
    API token audex-web uses server-side on their behalf — set the moment they sign in
    with ABS credentials, or via the one-time "connect Audiobookshelf" link step after
    an SSO-only login (see api/auth.py). Never sent to the browser.
    """
    __tablename__ = "identities"

    id = Column(Integer, primary_key=True)
    oidc_sub = Column(String, unique=True, nullable=True, index=True)
    email = Column(String, nullable=True)
    display_name = Column(String, nullable=True)

    abs_user_id = Column(String, nullable=True)
    abs_username = Column(String, nullable=True)
    abs_token_encrypted = Column(String, nullable=True)

    # Codex sync (Phase 3) is optional and per-person, same as the mobile app's
    # own Settings → Codex sync — NOT a single server-wide token, or every
    # identity's progress would get attributed to whichever one account that
    # token belongs to (the exact cross-account bug class Codex's own ABS sync
    # had to be fixed for). CODEX_URL (the instance) stays a server-wide
    # setting since a household shares one Codex; the token doesn't.
    codex_token_encrypted = Column(String, nullable=True)

    created_at = Column(Float, default=time.time)


class AbsServer(Base):
    """An ADDITIONAL Audiobookshelf server a person has connected, beyond the
    one the deploy is configured with (settings.ABS_URL, whose token lives on
    Identity.abs_token_encrypted — that stays the "primary" connection for
    backward compatibility). The mobile app syncs every enabled server into one
    catalog; this table is how audex-web holds the extras per person.

    Each row carries its OWN base_url and token — an extra server is usually a
    different box entirely, so it can't share the primary's URL or credentials.
    Item and library ids from these servers are namespaced `{row id}::{abs id}`
    at the API boundary (see app/api/connections.py) so they never collide with
    the primary server's bare ids or each other."""
    __tablename__ = "abs_servers"

    id = Column(Integer, primary_key=True)
    identity_id = Column(Integer, ForeignKey("identities.id"), nullable=False, index=True)
    name = Column(String, nullable=True)  # optional label; the host is used when blank
    base_url = Column(String, nullable=False)
    abs_user_id = Column(String, nullable=True)
    abs_username = Column(String, nullable=True)
    token_encrypted = Column(String, nullable=False)
    created_at = Column(Float, default=time.time)


class WebSession(Base):
    """A server-side session row a signed, httpOnly cookie points at by id. Table name
    avoids colliding with SQLAlchemy's own `Session` symbol."""
    __tablename__ = "sessions"

    id = Column(String, primary_key=True)  # the opaque cookie value itself
    identity_id = Column(Integer, ForeignKey("identities.id"), nullable=False)
    created_at = Column(Float, default=time.time)
    expires_at = Column(Float, nullable=False)


class UserSettings(Base):
    """Per-identity preferences that mirror the Android app's Settings screen
    (read-along toggle, notifications) — populated from Phase 5 onward; the table
    exists from the start so the migration story stays simple.

    playback_speed/reader_font_size (Phase 5): so re-opening a book doesn't
    reset to 1x/100% every time — the mobile app remembers these too. Global
    per-person, not per-book: matches the mobile app's own single Settings
    value rather than a per-book preference, simpler and it's what a listener
    who always prefers 1.5x actually wants."""
    __tablename__ = "user_settings"

    identity_id = Column(Integer, ForeignKey("identities.id"), primary_key=True)
    read_along = Column(Boolean, default=True)
    notify_readalong = Column(Boolean, default=True)
    playback_speed = Column(Float, default=1.0)
    reader_font_size = Column(Float, default=100.0)


engine = create_async_engine(settings.DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


async def init_db() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        yield session
