"""Audiobookshelf client. All calls happen server-side; the browser never talks to
ABS directly (see the plan §6) — it only ever holds an httpOnly session cookie for
audex-web itself.

Endpoint shapes here mirror the mobile Audex app's verified AbsApi.kt/Dto.kt
(core/network-abs in the codexaudio repo) rather than being re-derived from
scratch, since those were confirmed against a real ABS 2.35.1 server.
"""
import httpx

from app.core.config import settings


class AbsAuthError(Exception):
    pass


class AbsError(Exception):
    """A post-login ABS call failed (expired/revoked token, item not found, ABS
    unreachable). Distinct from AbsAuthError, which is specifically about signing
    in — callers surface this as a generic "couldn't reach your library" error."""


def _base() -> str:
    if not settings.ABS_URL:
        raise AbsError("ABS_URL is not configured on the server.")
    return settings.ABS_URL.rstrip("/")


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def login(username: str, password: str) -> dict:
    """POST /login → {user: {id, username, token, ...}}. Raises AbsAuthError on any
    non-2xx response (bad credentials, ABS unreachable, etc.)."""
    if not settings.ABS_URL:
        raise AbsAuthError("ABS_URL is not configured on the server.")
    url = settings.ABS_URL.rstrip("/") + "/login"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(url, json={"username": username, "password": password})
    except httpx.HTTPError as e:
        raise AbsAuthError(f"Couldn't reach Audiobookshelf: {e}")
    if r.status_code != 200:
        raise AbsAuthError("Invalid Audiobookshelf username or password.")
    data = r.json()
    user = data.get("user") or {}
    if not user.get("token"):
        raise AbsAuthError("Audiobookshelf didn't return a session token.")
    return user


async def me(token: str) -> dict | None:
    """GET /api/me with the given ABS token — used to validate a stored token is
    still good (e.g. before trusting a resumed session)."""
    if not settings.ABS_URL:
        return None
    url = settings.ABS_URL.rstrip("/") + "/api/me"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        return None
    return r.json() if r.status_code == 200 else None


# ─── Library browsing (Phase 1) ────────────────────────────────────────────

async def libraries(token: str) -> list[dict]:
    """GET /api/libraries → {libraries: [...]}."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{_base()}/api/libraries", headers=_auth(token))
    if r.status_code != 200:
        raise AbsError("Couldn't load your libraries.")
    return r.json().get("libraries", [])


async def library_items(token: str, library_id: str, *, limit: int = 500, page: int = 0) -> dict:
    """GET /api/libraries/{id}/items. Not requesting `minified` — we want full
    metadata (authors, series) the same way the mobile app's sync does, and a
    homelab-scale library fits comfortably in one page at this limit."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_base()}/api/libraries/{library_id}/items",
            headers=_auth(token),
            params={"limit": limit, "page": page, "sort": "media.metadata.title"},
        )
    if r.status_code != 200:
        raise AbsError("Couldn't load this library's items.")
    return r.json()


async def item_detail(token: str, item_id: str) -> dict:
    """GET /api/items/{id}?expanded=1 — full metadata + chapters + audio files."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_base()}/api/items/{item_id}", headers=_auth(token), params={"expanded": 1},
        )
    if r.status_code != 200:
        raise AbsError("Couldn't load this book.")
    return r.json()


# ─── Playback sessions (Phase 1) ───────────────────────────────────────────
# ABS direct-plays when it recognizes the browser can decode the source codec —
# these are exactly the containers a stock <audio> element handles natively.
_SUPPORTED_MIME_TYPES = [
    "audio/mpeg", "audio/mp4", "audio/aac", "audio/ogg", "audio/webm",
    "audio/flac", "audio/x-flac", "audio/wav",
]


async def start_play(token: str, item_id: str) -> dict:
    """POST /api/items/{id}/play → a session with the resume position ABS already
    computed (`currentTime`), the audio track list, and chapters."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{_base()}/api/items/{item_id}/play",
            headers=_auth(token),
            json={"supportedMimeTypes": _SUPPORTED_MIME_TYPES, "mediaPlayer": "audex-web"},
        )
    if r.status_code != 200:
        raise AbsError("Couldn't start playback for this book.")
    return r.json()


async def sync_session(token: str, session_id: str, *, current_time: float, time_listened: float, duration: float | None) -> None:
    """POST /api/session/{id}/sync — the sanctioned audio-progress channel (never
    PATCH /api/me/progress for audio)."""
    body: dict = {"currentTime": current_time, "timeListened": time_listened}
    if duration is not None:
        body["duration"] = duration
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(f"{_base()}/api/session/{session_id}/sync", headers=_auth(token), json=body)


async def close_session(token: str, session_id: str, *, current_time: float, time_listened: float, duration: float | None) -> None:
    body: dict = {"currentTime": current_time, "timeListened": time_listened}
    if duration is not None:
        body["duration"] = duration
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(f"{_base()}/api/session/{session_id}/close", headers=_auth(token), json=body)


def cover_url(item_id: str) -> str:
    return f"{_base()}/api/items/{item_id}/cover"


def stream_url(path: str) -> str:
    """[path] is one audio track's ABS-relative `contentUrl` (e.g.
    `/api/items/<id>/file/<ino>`), as returned verbatim by start_play() — the
    frontend never constructs this itself, only replays what ABS gave it."""
    return f"{_base()}{path}"
