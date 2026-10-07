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


# ── Codex's checked metadata (GET /audex/config → meta_via_codex, /audex/meta) ──────────────
#
# Audiobookshelf's own metadata is often wrong; the owner fixes it in Codex, which writes the fix back
# into ABS AND serves it here so a fix shows up at once. See docs/SYNC_API.md ("Codex's checked
# metadata"). Everything below is best-effort: Codex being down, old, slow or unconfigured must leave
# the library exactly as Audiobookshelf reports it — never an error, never a slow page.
import time

META_CHUNK = 200            # Codex's per-request cap
META_TTL_S = 300            # how long a fetched (or "unknown to Codex") answer is reused
CONFIG_TTL_S = 600
DOWN_FOR_S = 60             # after a failure, skip Codex this long instead of paying the timeout on every page
META_TIMEOUT_S = 5

_meta_cache: dict[str, tuple[float, dict | None]] = {}   # abs item id -> (fetched_at, entry | None)
_config_cache: dict[str, tuple[float, bool]] = {}        # codex url -> (checked_at, meta_via_codex)
_down_until: dict[str, float] = {}


def _reset_caches() -> None:
    """For tests."""
    _meta_cache.clear()
    _config_cache.clear()
    _down_until.clear()


async def meta_enabled(codex_url: str) -> bool:
    """Does this Codex serve /audex/meta? Cached; False for an unconfigured, unreachable or older Codex."""
    if not codex_url:
        return False
    base = codex_url.rstrip("/")
    hit = _config_cache.get(base)
    if hit and time.time() - hit[0] < CONFIG_TTL_S:
        return hit[1]
    if _down_until.get(base, 0) > time.time():
        return False
    ok = False
    try:
        async with httpx.AsyncClient(timeout=META_TIMEOUT_S) as client:
            r = await client.get(f"{base}/audex/config")
        ok = r.status_code == 200 and bool((r.json() or {}).get("meta_via_codex"))
    except (httpx.HTTPError, ValueError):
        _down_until[base] = time.time() + DOWN_FOR_S
        return False
    _config_cache[base] = (time.time(), ok)
    return ok


async def fetch_meta(codex_url: str, ids: list[str]) -> dict[str, dict]:
    """{abs item id: {fields, edited, codex_id}} for the ids Codex knows. Unknown ids are absent. Fetches only
    what isn't cached, in chunks of META_CHUNK; on a failure returns whatever is cached (even stale)."""
    base = (codex_url or "").rstrip("/")
    if not base or not ids or not await meta_enabled(base):
        return {}
    now = time.time()
    wanted = list(dict.fromkeys(i for i in ids if i))
    stale = [i for i in wanted if not (i in _meta_cache and now - _meta_cache[i][0] < META_TTL_S)]
    if stale and _down_until.get(base, 0) <= now:
        try:
            async with httpx.AsyncClient(timeout=META_TIMEOUT_S) as client:
                for k in range(0, len(stale), META_CHUNK):
                    chunk = stale[k:k + META_CHUNK]
                    r = await client.post(f"{base}/audex/meta", json={"ids": chunk})
                    r.raise_for_status()
                    items = (r.json() or {}).get("items") or {}
                    for i in chunk:
                        _meta_cache[i] = (time.time(), items.get(i))
        except (httpx.HTTPError, ValueError):
            _down_until[base] = time.time() + DOWN_FOR_S
    return {i: _meta_cache[i][1] for i in wanted if i in _meta_cache and _meta_cache[i][1]}


def forget_meta(item_id: str) -> None:
    """Drop one item's cached answer (after an edit) so the next read sees the change."""
    _meta_cache.pop(item_id, None)


# Codex's field names for the things this app can edit; the ABS-shaped payload is translated below.
def codex_fields_from_abs_metadata(metadata: dict) -> dict:
    out: dict = {}
    if "title" in metadata:
        out["title"] = metadata["title"] or ""
    if "authors" in metadata:
        out["author"] = ", ".join(a.get("name", "") for a in metadata["authors"] if a.get("name"))
    if "narrators" in metadata:
        out["narrator"] = ", ".join(n for n in metadata["narrators"] if n)
    if "series" in metadata:
        first = (metadata["series"] or [None])[0] or {}
        out["series_name"] = first.get("name") or ""
        seq = first.get("sequence")
        try:
            out["series_position"] = float(seq) if seq not in (None, "") else ""
        except (TypeError, ValueError):
            out["series_position"] = ""
    return out


async def push_edit(codex_url: str, token: str, codex_id: int, fields: dict) -> bool:
    """Send a fix made here to Codex too (PATCH /media/{id}, the person's own API key), so Codex — the source
    of truth — records it as a hand edit and its periodic ABS correction doesn't undo it. Best-effort."""
    if not codex_url or not token or not codex_id or not fields:
        return False
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.patch(
                f"{codex_url.rstrip('/')}/media/{codex_id}", json=fields,
                headers={"Authorization": f"Bearer {token}"},
            )
        return r.status_code == 200
    except httpx.HTTPError:
        return False
