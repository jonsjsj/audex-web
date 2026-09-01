"""Minimal Audiobookshelf client — just enough for Phase 0 (login) plus the shape
later phases build on. All calls happen server-side; the browser never talks to
ABS directly (see the plan §6)."""
import httpx

from app.core.config import settings


class AbsAuthError(Exception):
    pass


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
