"""Resolving a signed-in person's Audiobookshelf connections, and the id
namespacing that lets one combined catalog span several servers.

There are two kinds of connection:

* the **primary** one — the deploy's configured `ABS_URL` with the token on
  `Identity.abs_token_encrypted`, established at sign-in/link. This is the only
  connection a single-server deploy ever has, and its ids stay BARE so nothing
  about that (by far most common) case changes.
* any number of **additional** ones — `AbsServer` rows, each its own box with
  its own url + token. Their ids are namespaced `{row id}::{abs id}` so they
  can't collide with the primary's bare ids or each other.

`resolve()` turns an id from the API boundary back into (connection, real abs
id); `tag()` does the reverse when building a response. Because the primary
stays bare, `resolve("li_x")` is unambiguous — no `::` means primary.
"""
from dataclasses import dataclass

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AbsServer, Identity
from app.core.security import decrypt_value

DELIM = "::"


@dataclass
class AbsConn:
    key: str  # "" for the primary connection, str(AbsServer.id) for additional ones
    base_url: str
    token: str
    username: str | None
    name: str
    is_primary: bool


def _host_label(base_url: str) -> str:
    return base_url.split("://", 1)[-1].rstrip("/")


async def list_connections(identity: Identity, db: AsyncSession) -> list[AbsConn]:
    """Every usable ABS connection for this person, primary first. A connection
    with an undecryptable/blank token is skipped rather than raised on — one
    broken extra server shouldn't blank the whole combined library."""
    conns: list[AbsConn] = []
    if identity.abs_token_encrypted and settings.ABS_URL:
        token = decrypt_value(identity.abs_token_encrypted)
        if token:
            base = settings.ABS_URL.rstrip("/")
            conns.append(AbsConn("", base, token, identity.abs_username, _host_label(base), True))
    rows = (
        await db.execute(
            select(AbsServer).where(AbsServer.identity_id == identity.id).order_by(AbsServer.id)
        )
    ).scalars().all()
    for r in rows:
        token = decrypt_value(r.token_encrypted)
        if not token:
            continue
        base = r.base_url.rstrip("/")
        conns.append(AbsConn(str(r.id), base, token, r.abs_username, r.name or _host_label(base), False))
    return conns


def tag(conn: AbsConn, abs_id: str) -> str:
    """Namespace a real ABS id for the API boundary — bare for the primary."""
    return abs_id if conn.is_primary else f"{conn.key}{DELIM}{abs_id}"


def split_id(namespaced: str) -> tuple[str, str]:
    """(server key, real abs id). No delimiter means the primary connection."""
    if DELIM in namespaced:
        key, _, rest = namespaced.partition(DELIM)
        return key, rest
    return "", namespaced


async def resolve(identity: Identity, db: AsyncSession, namespaced: str) -> tuple[AbsConn, str]:
    """Map an id from the API boundary back to (its connection, its real abs
    id), or 400 if the server it names isn't one this person has connected."""
    key, abs_id = split_id(namespaced)
    for conn in await list_connections(identity, db):
        if conn.key == key:
            return conn, abs_id
    raise HTTPException(status.HTTP_400_BAD_REQUEST, "That item's Audiobookshelf server isn't connected.")


async def connections_for_library(identity: Identity, db: AsyncSession, library_sel: str) -> list[tuple[AbsConn, str | None]]:
    """The (connection, library id) pairs a browse request covers.

    `library_sel` is one of: "all" (every connection, every library — the
    default combined view), a bare library id (primary connection, that one
    library), or a namespaced `{key}::{lib id}` (that server, that library).
    A None library id means "all libraries on this connection"."""
    conns = await list_connections(identity, db)
    if not library_sel or library_sel == "all":
        return [(c, None) for c in conns]
    key, lib_id = split_id(library_sel)
    for c in conns:
        if c.key == key:
            return [(c, lib_id)]
    return []
