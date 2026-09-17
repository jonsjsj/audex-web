"""Audiobookshelf client. All calls happen server-side; the browser never talks to
ABS directly (see the plan §6) — it only ever holds an httpOnly session cookie for
audex-web itself.

Every call takes an explicit `base_url` (and, where authenticated, a `token`)
rather than reading a single global server: a person can connect more than one
Audiobookshelf server (the deploy's configured `ABS_URL` plus any number of
extras — see app/api/connections.py), and each call has to go to the right one.

Endpoint shapes here mirror the mobile Audex app's verified AbsApi.kt/Dto.kt
(core/network-abs in the codexaudio repo) rather than being re-derived from
scratch, since those were confirmed against a real ABS 2.35.1 server.
"""
import httpx


class AbsAuthError(Exception):
    pass


class AbsError(Exception):
    """A post-login ABS call failed (expired/revoked token, item not found, ABS
    unreachable). Distinct from AbsAuthError, which is specifically about signing
    in — callers surface this as a generic "couldn't reach your library" error."""


def _base(base_url: str) -> str:
    if not base_url:
        raise AbsError("No Audiobookshelf server URL configured.")
    return base_url.rstrip("/")


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def login(base_url: str, username: str, password: str) -> dict:
    """POST /login → {user: {id, username, token, ...}}. Raises AbsAuthError on any
    non-2xx response (bad credentials, ABS unreachable, etc.)."""
    if not base_url:
        raise AbsAuthError("No Audiobookshelf server URL was given.")
    url = base_url.rstrip("/") + "/login"
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


async def me(base_url: str, token: str) -> dict | None:
    """GET /api/me with the given ABS token — used to validate a stored token is
    still good, and as the source of the user's mediaProgress/bookmarks."""
    if not base_url:
        return None
    url = base_url.rstrip("/") + "/api/me"
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get(url, headers=_auth(token))
    except httpx.HTTPError:
        return None
    return r.json() if r.status_code == 200 else None


# ─── Library browsing (Phase 1) ────────────────────────────────────────────

async def libraries(base_url: str, token: str) -> list[dict]:
    """GET /api/libraries → {libraries: [...]}."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{_base(base_url)}/api/libraries", headers=_auth(token))
    if r.status_code != 200:
        raise AbsError("Couldn't load your libraries.")
    return r.json().get("libraries", [])


async def library_items(base_url: str, token: str, library_id: str, *, limit: int = 500, page: int = 0) -> dict:
    """GET /api/libraries/{id}/items. Not requesting `minified` — we want full
    metadata (authors, series) the same way the mobile app's sync does, and a
    homelab-scale library fits comfortably in one page at this limit."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_base(base_url)}/api/libraries/{library_id}/items",
            headers=_auth(token),
            params={"limit": limit, "page": page, "sort": "media.metadata.title"},
        )
    if r.status_code != 200:
        raise AbsError("Couldn't load this library's items.")
    return r.json()


async def item_detail(base_url: str, token: str, item_id: str) -> dict:
    """GET /api/items/{id}?expanded=1 — full metadata + chapters + audio files."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(
            f"{_base(base_url)}/api/items/{item_id}", headers=_auth(token), params={"expanded": 1},
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


async def start_play(base_url: str, token: str, item_id: str) -> dict:
    """POST /api/items/{id}/play → a session with the resume position ABS already
    computed (`currentTime`), the audio track list, and chapters."""
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(
            f"{_base(base_url)}/api/items/{item_id}/play",
            headers=_auth(token),
            json={"supportedMimeTypes": _SUPPORTED_MIME_TYPES, "mediaPlayer": "audex-web"},
        )
    if r.status_code != 200:
        raise AbsError("Couldn't start playback for this book.")
    return r.json()


async def sync_session(base_url: str, token: str, session_id: str, *, current_time: float, time_listened: float, duration: float | None) -> None:
    """POST /api/session/{id}/sync — the sanctioned audio-progress channel (never
    PATCH /api/me/progress for audio)."""
    body: dict = {"currentTime": current_time, "timeListened": time_listened}
    if duration is not None:
        body["duration"] = duration
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(f"{_base(base_url)}/api/session/{session_id}/sync", headers=_auth(token), json=body)


async def close_session(base_url: str, token: str, session_id: str, *, current_time: float, time_listened: float, duration: float | None) -> None:
    body: dict = {"currentTime": current_time, "timeListened": time_listened}
    if duration is not None:
        body["duration"] = duration
    async with httpx.AsyncClient(timeout=10) as client:
        await client.post(f"{_base(base_url)}/api/session/{session_id}/close", headers=_auth(token), json=body)


def cover_url(base_url: str, item_id: str) -> str:
    return f"{_base(base_url)}/api/items/{item_id}/cover"


def author_image_url(base_url: str, author_id: str) -> str:
    """ABS's real Author entity (distinct from the plain name string on a
    book's metadata) carries an optional headshot once the author's been
    matched via an author-search provider in ABS itself — same idea as
    cover_url() above, proxied server-side for the same reason (an <img> tag
    can't carry the Bearer token). 404s when the author has no image, which
    the frontend treats as "no headshot" rather than an error."""
    return f"{_base(base_url)}/api/authors/{author_id}/image"


async def author_detail(base_url: str, token: str, author_id: str) -> dict | None:
    """GET /api/authors/{id} → {id, name, description, imagePath, ...} — the
    bio shown on the Author detail page. None if ABS 404s (a stale/unmatched
    id), not raised — the page just skips the bio section."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{_base(base_url)}/api/authors/{author_id}", headers=_auth(token))
    return r.json() if r.status_code == 200 else None


def stream_url(base_url: str, path: str) -> str:
    """[path] is one audio track's ABS-relative `contentUrl` (e.g.
    `/api/items/<id>/file/<ino>`), as returned verbatim by start_play() — the
    frontend never constructs this itself, only replays what ABS gave it."""
    return f"{_base(base_url)}{path}"


# ─── Ebook reading (Phase 2) ────────────────────────────────────────────────

async def ebook_file(base_url: str, token: str, item_id: str) -> bytes:
    """Downloads the item's primary ebook file's raw bytes. There's no dedicated
    "/ebook" endpoint — audiobooks and ebooks are both served the same way, by
    the file's `ino` off the expanded item (matching audio's own contentUrl
    shape, `/api/items/<id>/file/<ino>` — see stream_url() above)."""
    detail = await item_detail(base_url, token, item_id)
    ebook_file_meta = (detail.get("media") or {}).get("ebookFile")
    ino = ebook_file_meta.get("ino") if ebook_file_meta else None
    if not ino:
        raise AbsError("This item has no ebook file.")
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(f"{_base(base_url)}/api/items/{item_id}/file/{ino}", headers=_auth(token))
    if r.status_code != 200:
        raise AbsError("Couldn't download this book's ebook file.")
    return r.content


async def get_progress(base_url: str, token: str, item_id: str) -> dict | None:
    """GET /api/me/progress/{id} → the saved MediaProgress record (`ebookLocation`,
    `ebookProgress`, …), or None if this item has never been opened. 404 is the
    normal "no progress yet" response, not an error."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{_base(base_url)}/api/me/progress/{item_id}", headers=_auth(token))
    if r.status_code == 404:
        return None
    if r.status_code != 200:
        raise AbsError("Couldn't load your reading position for this book.")
    return r.json()


async def save_ebook_progress(base_url: str, token: str, item_id: str, *, ebook_location: str, ebook_progress: float) -> None:
    """PATCH /api/me/progress/{id} — the sanctioned channel for EBOOK position
    specifically (audio position goes through /api/session/{id}/sync instead —
    see sync_session() above; PATCHing an audio position is known not to take
    reliably). Best-effort: a failed save shouldn't interrupt reading, the
    frontend just retries on the next position-changed event."""
    body = {"ebookLocation": ebook_location, "ebookProgress": max(0.0, min(1.0, ebook_progress))}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.patch(f"{_base(base_url)}/api/me/progress/{item_id}", headers=_auth(token), json=body)
    if r.status_code != 200:
        raise AbsError("Couldn't save your reading position.")


# ─── Bookmarks ──────────────────────────────────────────────────────────────
# NOTE on confidence: unlike everything above, these three write endpoints
# are NOT independently confirmed against a live server this session (no
# ABS access here) — only the DATA SHAPE is (real /api/me responses seen
# earlier this project show `bookmarks: [{libraryItemId, time, title,
# createdAt}]` on the user record, alongside mediaProgress). The write paths
# below follow ABS's established `/api/me/item/{id}/...` convention (matching
# how progress and everything else under /api/me is shaped), but if they're
# wrong, callers get a clean AbsError, not a crash — see play.py's handling.

async def list_bookmarks(base_url: str, token: str, item_id: str) -> list[dict]:
    """Bookmarks live on the user record (me()'s `bookmarks` array), not a
    per-item endpoint — same place mediaProgress does."""
    m = await me(base_url, token)
    all_bookmarks = (m or {}).get("bookmarks") or []
    return sorted(
        (b for b in all_bookmarks if b.get("libraryItemId") == item_id),
        key=lambda b: b.get("time", 0),
    )


async def add_bookmark(base_url: str, token: str, item_id: str, *, time_s: float, title: str) -> None:
    body = {"time": round(time_s), "title": title}
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{_base(base_url)}/api/me/item/{item_id}/bookmark", headers=_auth(token), json=body)
    if r.status_code != 200:
        raise AbsError("Couldn't save that bookmark.")


async def delete_bookmark(base_url: str, token: str, item_id: str, time_s: int) -> None:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.delete(f"{_base(base_url)}/api/me/item/{item_id}/bookmark/{time_s}", headers=_auth(token))
    if r.status_code not in (200, 204, 404):
        raise AbsError("Couldn't delete that bookmark.")


async def delete_progress(base_url: str, token: str, item_id: str) -> None:
    """Wipes this item's progress in ABS — audio position, ebook position, and
    the finished flag alike, since it's one shared record. The ONLY reliable
    way to clear stuck/wrong progress: a PATCH to zero is known not to stick
    (ABS keeps the old currentTime/isFinished around regardless).

    DELETE is keyed on the progress record's OWN `id`, not the libraryItemId —
    deleting by libraryItemId 404s. get_progress()'s GET-by-libraryItemId
    convenience route is how that record id is found in the first place; a
    404 there means there's genuinely nothing to discard, not an error."""
    prog = await get_progress(base_url, token, item_id)
    record_id = prog.get("id") if prog else None
    if not record_id:
        return
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.delete(f"{_base(base_url)}/api/me/progress/{record_id}", headers=_auth(token))
    if r.status_code not in (200, 204):
        raise AbsError("Couldn't clear this book's progress.")
