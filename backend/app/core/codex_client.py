"""Codex sync — Phase 3. Pushes audio progress to Codex's own ABS webhook, the
exact call the mobile app's CodexSyncImpl.pushAudioProgress() makes, so a web
listening session shows up on Codex immediately instead of waiting for its
periodic Audiobookshelf poll. Ebook progress doesn't need an equivalent push
here: audex-web already PATCHes ebook position straight to ABS (abs_client.
save_ebook_progress, Phase 2) the same way the mobile app's reader does, and
Codex's own periodic ABS sync picks that up on its normal interval — neither
client pushes ebook position to Codex directly.

Codex's `/webhooks/abs` validates `token` the same way a Bearer Authorization
header would (a real Codex API key, generated from Codex's own Settings → API
Keys — see Identity.codex_token_encrypted), and maps the update to whichever
Codex user that key belongs to.
"""
import httpx


async def push_audio_progress(
    codex_url: str, token: str, *, library_item_id: str, current_time_s: float, is_finished: bool,
) -> None:
    """Best-effort: a Codex outage (or a stale/revoked token) must never
    disrupt playback. Callers fire this and ignore the result, same as the
    mobile app does — see play.py."""
    if not codex_url or not token:
        return
    url = f"{codex_url.rstrip('/')}/webhooks/abs"
    body = {
        "event": "user_mediaProgressUpdated",
        "data": {
            "progress": {
                "libraryItemId": library_item_id,
                "currentTime": current_time_s,
                "isFinished": is_finished,
            },
        },
    }
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(url, params={"token": token}, json=body)
    except httpx.HTTPError:
        pass


async def verify_token(codex_url: str, token: str) -> bool:
    """A Codex API key is validated by Codex's get_current_user the same way a
    normal Bearer session token is — so a lightweight GET /api/auth/me with it
    doubles as "is this token real" before saving it, the same check the
    mobile app's own token field effectively gets on its first use."""
    if not codex_url or not token:
        return False
    url = f"{codex_url.rstrip('/')}/api/auth/me"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers={"Authorization": f"Bearer {token}"})
    except httpx.HTTPError:
        return False
    return r.status_code == 200
