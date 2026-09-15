"""Playback — Phase 1, Codex push added in Phase 3. Starts an ABS session
(which hands back the resume position ABS already computed), proxies the
audio bytes so the <audio> element never needs the bearer token, and relays
position sync/close the same way the mobile app does (POST
/api/session/{id}/sync — never PATCH progress for audio).
"""
from urllib.parse import quote, unquote

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import get_abs_token, get_codex_token
from app.core import abs_client, codex_client
from app.core.abs_client import AbsError
from app.core.config import settings

router = APIRouter(prefix="/api/play", tags=["play"])
stream_router = APIRouter(prefix="/api/stream", tags=["play"])


@router.post("/{item_id}")
async def play(item_id: str, token: str = Depends(get_abs_token)):
    try:
        session = await abs_client.start_play(token, item_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    tracks = session.get("audioTracks", [])
    return {
        "sessionId": session["id"],
        "currentTimeS": session.get("currentTime", 0.0),
        "durationS": sum(t.get("duration", 0.0) for t in tracks),
        "tracks": [
            {
                "index": t.get("index", i),
                "startOffsetS": t.get("startOffset", 0.0),
                "durationS": t.get("duration", 0.0),
                # Opaque to the frontend — just what to hand back to /api/stream.
                "streamUrl": f"/api/stream?path={quote(t.get('contentUrl', ''), safe='')}",
            }
            for i, t in enumerate(tracks)
        ],
        "chapters": [
            {"id": c.get("id", 0), "startS": c.get("start", 0.0), "endS": c.get("end", 0.0), "title": c.get("title", "")}
            for c in session.get("chapters", [])
        ],
    }


class SyncBody(BaseModel):
    sessionId: str
    currentTimeS: float
    timeListenedS: float
    durationS: float | None = None


def _is_finished(body: SyncBody) -> bool:
    # Same threshold the mobile app's PlaybackController uses: within the
    # last second counts as finished, since the true end is credits/silence
    # you'd never land on exactly.
    return body.durationS is not None and body.currentTimeS >= body.durationS - 1.0


@router.post("/{item_id}/sync")
async def sync(
    item_id: str, body: SyncBody,
    token: str = Depends(get_abs_token), codex_token: str | None = Depends(get_codex_token),
):
    await abs_client.sync_session(
        token, body.sessionId,
        current_time=body.currentTimeS, time_listened=body.timeListenedS, duration=body.durationS,
    )
    if codex_token:
        await codex_client.push_audio_progress(
            settings.CODEX_URL, codex_token,
            library_item_id=item_id, current_time_s=body.currentTimeS, is_finished=_is_finished(body),
        )
    return {"ok": True}


@router.post("/{item_id}/close")
async def close(
    item_id: str, body: SyncBody,
    token: str = Depends(get_abs_token), codex_token: str | None = Depends(get_codex_token),
):
    await abs_client.close_session(
        token, body.sessionId,
        current_time=body.currentTimeS, time_listened=body.timeListenedS, duration=body.durationS,
    )
    if codex_token:
        await codex_client.push_audio_progress(
            settings.CODEX_URL, codex_token,
            library_item_id=item_id, current_time_s=body.currentTimeS, is_finished=_is_finished(body),
        )
    return {"ok": True}


@router.delete("/{item_id}/progress")
async def discard_progress(item_id: str, token: str = Depends(get_abs_token)):
    """Discard audiobook progress — the same "wipe it, don't try to PATCH it
    to zero" fix the mobile app uses for a stuck/wrong position."""
    try:
        await abs_client.delete_progress(token, item_id)
    except AbsError as e:
        raise HTTPException(502, str(e))
    return {"ok": True}


@stream_router.get("")
async def stream(request: Request, path: str = Query(...), token: str = Depends(get_abs_token)):
    """Proxies one audio track's bytes from ABS, forwarding the client's Range
    header and relaying back ABS's 206/Content-Range/Accept-Ranges verbatim —
    without that, the <audio> element's scrubber can't seek (every seek would
    have to re-download from byte 0). [path] must be an /api/items/... URL that
    /api/play just handed the frontend; anything else is rejected so this can't
    be turned into an open proxy to an arbitrary ABS_URL path.
    """
    raw_path = unquote(path)
    if not raw_path.startswith("/api/items/"):
        raise HTTPException(400, "Invalid stream path.")
    url = abs_client.stream_url(raw_path)
    headers = {"Authorization": f"Bearer {token}"}
    range_header = request.headers.get("range")
    if range_header:
        headers["Range"] = range_header

    client = httpx.AsyncClient(timeout=None)
    try:
        upstream_request = client.build_request("GET", url, headers=headers)
        upstream = await client.send(upstream_request, stream=True)
    except httpx.HTTPError:
        await client.aclose()
        raise HTTPException(502, "Couldn't reach Audiobookshelf for streaming.")

    async def body():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    passthrough = {}
    for h in ("content-type", "content-length", "content-range", "accept-ranges"):
        if h in upstream.headers:
            passthrough[h] = upstream.headers[h]
    passthrough.setdefault("accept-ranges", "bytes")
    return StreamingResponse(body(), status_code=upstream.status_code, headers=passthrough)
