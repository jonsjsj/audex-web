"""Podcasts (optional — Settings → Extras → Podcasts; Audex has the same).

Everything goes through Audiobookshelf's own podcast support, so the subscriptions, the downloaded episodes and your
place in each are the same ones the Audiobookshelf web app and the Audex app see:

- the shows are the items of the person's podcast libraries, on every connected server;
- a show's episodes are the ones Audiobookshelf has downloaded, each with its own saved position
  (`/api/me/progress/{item}/{episode}`) and played through the normal player (`POST /api/play/{item}?episodeId=…`);
- finding a new show searches Audiobookshelf's podcast index (`/api/search/podcast`), or previews an RSS address
  (`/api/podcasts/feed` — Audiobookshelf fetches the feed itself and refuses private addresses);
- subscribing creates the show in a podcast library (`POST /api/podcasts`), which needs an Audiobookshelf account
  that may upload. Audiobookshelf then downloads new episodes on its own schedule when auto-download is on.

Webdex never fetches a feed itself."""
import re
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import list_connections, resolve, tag
from app.api.deps import get_current_identity
from app.core import abs_client
from app.core.abs_client import AbsError, _auth, _base
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/podcasts", tags=["podcasts"])

_TAGS = re.compile(r"<[^>]+>")


def plain(html: str | None, limit: int = 600) -> str | None:
    """Feed descriptions are HTML: plain text, trimmed."""
    if not html:
        return None
    t = _TAGS.sub(" ", html)
    for a, b in (("&amp;", "&"), ("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&#39;", "'"), ("&nbsp;", " ")):
        t = t.replace(a, b)
    t = re.sub(r"\s+", " ", t).strip()
    return (t[: limit - 1].rstrip() + "…") if len(t) > limit else (t or None)


def safe_folder_name(title: str) -> str:
    """The show's folder inside the library folder — no characters a file system refuses, no path tricks."""
    name = re.sub(r'[\\/:*?"<>|]', "_", (title or "").strip()).strip(" .")
    return name[:120] or "Podcast"


def can_upload(me: dict | None) -> bool:
    if not me:
        return False
    if me.get("type") in ("root", "admin"):
        return True
    return bool((me.get("permissions") or {}).get("upload"))


async def _get(conn, path: str, params: dict | None = None) -> httpx.Response:
    async with httpx.AsyncClient(timeout=20) as client:
        return await client.get(f"{_base(conn.base_url)}{path}", headers=_auth(conn.token), params=params)


async def _post(conn, path: str, json: dict) -> httpx.Response:
    async with httpx.AsyncClient(timeout=30) as client:
        return await client.post(f"{_base(conn.base_url)}{path}", headers=_auth(conn.token), json=json)


def _show(conn, item: dict, library_name: str) -> dict:
    media = item.get("media") or {}
    meta = media.get("metadata") or {}
    tagged = tag(conn, item["id"])
    return {
        "id": tagged,
        "title": meta.get("title") or "(untitled)",
        "author": meta.get("author"),
        "coverUrl": f"/api/library/items/{tagged}/cover",
        "numEpisodes": media.get("numEpisodes") or len(media.get("episodes") or []),
        "autoDownload": bool(media.get("autoDownloadEpisodes")),
        "library": library_name,
        "serverName": conn.name,
    }


@router.get("")
async def shows(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    """Every show in the person's podcast libraries, plus where a new one can be subscribed to."""
    out, targets = [], []
    for conn in await list_connections(identity, db):
        try:
            libs = [l for l in await abs_client.libraries(conn.base_url, conn.token) if l.get("mediaType") == "podcast"]
        except (AbsError, httpx.HTTPError):
            continue
        if not libs:
            continue
        me = await abs_client.me(conn.base_url, conn.token)
        uploads = can_upload(me)
        for lib in libs:
            if any((f.get("fullPath") or "").strip() for f in lib.get("folders") or []):
                targets.append({"id": tag(conn, lib["id"]), "name": lib.get("name") or "Podcasts",
                                "serverName": conn.name, "canSubscribe": uploads})
            try:
                page = await abs_client.library_items(conn.base_url, conn.token, lib["id"])
            except (AbsError, httpx.HTTPError):
                continue
            out += [_show(conn, it, lib.get("name") or "") for it in page.get("results") or []]
    out.sort(key=lambda s: s["title"].lower())
    return {"shows": out, "targets": targets}


def _episode(ep: dict, prog: dict | None) -> dict:
    audio = ep.get("audioFile") or {}
    duration = float(ep.get("duration") or audio.get("duration") or 0)
    p = prog or {}
    return {
        "id": ep.get("id"),
        "title": ep.get("title") or "(untitled episode)",
        "publishedAt": ep.get("publishedAt"),  # epoch ms
        "season": ep.get("season") or None,
        "episode": ep.get("episode") or None,
        "durationS": duration,
        "description": plain(ep.get("description") or ep.get("subtitle"), 400),
        "currentTimeS": float(p.get("currentTime") or 0),
        "progress": float(p.get("progress") or 0),
        "isFinished": bool(p.get("isFinished")),
        "lastUpdate": p.get("lastUpdate"),
    }


@router.get("/{item_id}")
async def show(item_id: str, identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    """One show: its details and its downloaded episodes (newest first), each with your place in it."""
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        item = await abs_client.item_detail(conn.base_url, conn.token, abs_id)
    except AbsError as e:
        raise HTTPException(502, "Couldn't load this podcast.") from e
    if item.get("mediaType") != "podcast":
        raise HTTPException(404, "That isn't a podcast.")
    me = await abs_client.me(conn.base_url, conn.token) or {}
    progress = {p.get("episodeId"): p for p in me.get("mediaProgress") or []
                if p.get("libraryItemId") == abs_id and p.get("episodeId")}
    media = item.get("media") or {}
    meta = media.get("metadata") or {}
    episodes = [_episode(e, progress.get(e.get("id"))) for e in media.get("episodes") or []]
    episodes.sort(key=lambda e: e["publishedAt"] or 0, reverse=True)
    return {
        **_show(conn, item, ""),
        "description": plain(meta.get("description"), 1200),
        "feedUrl": meta.get("feedUrl"),
        "episodes": episodes,
    }


@router.get("/{item_id}/episodes/{episode_id}")
async def episode(item_id: str, episode_id: str, identity: Identity = Depends(get_current_identity),
                  db: AsyncSession = Depends(get_db)):
    """What the player shows for an episode: its title, the show, the cover."""
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        item = await abs_client.item_detail(conn.base_url, conn.token, abs_id)
    except AbsError as e:
        raise HTTPException(502, "Couldn't load this podcast.") from e
    media = item.get("media") or {}
    ep = next((e for e in media.get("episodes") or [] if e.get("id") == episode_id), None)
    if not ep:
        raise HTTPException(404, "That episode isn't on the server (any more).")
    s = _show(conn, item, "")
    return {"podcastId": s["id"], "podcastTitle": s["title"], "author": s["author"], "coverUrl": s["coverUrl"],
            **_episode(ep, None)}


@router.post("/{item_id}/check-new")
async def check_new(item_id: str, identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    """Ask Audiobookshelf to look at the feed for new episodes now (it downloads them)."""
    conn, abs_id = await resolve(identity, db, item_id)
    try:
        r = await _get(conn, f"/api/podcasts/{abs_id}/checknew")
    except httpx.HTTPError as e:
        raise HTTPException(502, "Couldn't reach Audiobookshelf.") from e
    if r.status_code == 403:
        raise HTTPException(403, "Your Audiobookshelf account isn't allowed to download episodes.")
    if r.status_code >= 400:
        raise HTTPException(502, f"Audiobookshelf answered HTTP {r.status_code}.")
    try:
        found = len((r.json() or {}).get("episodes") or [])
    except ValueError:
        found = 0
    return {"ok": True, "newEpisodes": found}


async def _primary(identity: Identity, db: AsyncSession):
    conns = await list_connections(identity, db)
    if not conns:
        raise HTTPException(400, "No Audiobookshelf server connected.")
    return next((c for c in conns if c.is_primary), conns[0])


@router.get("/find/search")
async def search(term: str = Query(..., min_length=2, max_length=120), identity: Identity = Depends(get_current_identity),
                 db: AsyncSession = Depends(get_db)):
    """Find shows by name, through Audiobookshelf's podcast index."""
    conn = await _primary(identity, db)
    try:
        r = await _get(conn, "/api/search/podcast", {"term": term})
    except httpx.HTTPError as e:
        raise HTTPException(502, "Couldn't reach Audiobookshelf.") from e
    if r.status_code >= 400:
        raise HTTPException(502, f"Audiobookshelf's podcast search answered HTTP {r.status_code}.")
    rows = r.json() if isinstance(r.json(), list) else []
    return {"results": [
        {"title": x.get("title") or "", "author": x.get("artistName"), "coverUrl": x.get("cover"),
         "feedUrl": x.get("feedUrl") or "", "episodes": x.get("trackCount") or 0, "genres": x.get("genres") or [],
         "description": plain(x.get("descriptionPlain") or x.get("description"), 300)}
        for x in rows[:30] if x.get("feedUrl")
    ]}


class FeedBody(BaseModel):
    rssFeed: str


@router.post("/find/feed")
async def preview_feed(body: FeedBody, identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    """Preview an RSS address before subscribing (Audiobookshelf fetches it)."""
    url = body.rssFeed.strip()
    if not re.match(r"^https?://", url, re.I):
        raise HTTPException(400, "That isn't a web address (it should start with http:// or https://).")
    conn = await _primary(identity, db)
    try:
        r = await _post(conn, "/api/podcasts/feed", {"rssFeed": url})
    except httpx.HTTPError as e:
        raise HTTPException(502, "Couldn't reach Audiobookshelf.") from e
    if r.status_code >= 400:
        raise HTTPException(400, "Audiobookshelf couldn't read a podcast feed at that address.")
    pod = (r.json() or {}).get("podcast") or {}
    meta = pod.get("metadata") or {}
    eps = pod.get("episodes") or []
    return {"title": meta.get("title") or "", "author": meta.get("author"), "coverUrl": meta.get("image") or meta.get("imageUrl"),
            "feedUrl": meta.get("feedUrl") or url, "description": plain(meta.get("descriptionPlain") or meta.get("description"), 600),
            "episodes": pod.get("numEpisodes") or len(eps),
            "latest": [{"title": e.get("title") or "", "publishedAt": e.get("publishedAt")} for e in eps[:5]]}


class SubscribeBody(BaseModel):
    target: str           # a podcast library id from GET /api/podcasts → targets
    feedUrl: str
    title: str
    author: str | None = None
    description: str | None = None
    imageUrl: str | None = None
    autoDownload: bool = True


@router.post("/subscribe")
async def subscribe(body: SubscribeBody, identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    if not re.match(r"^https?://", body.feedUrl.strip(), re.I):
        raise HTTPException(400, "That isn't a feed address.")
    conn, lib_id = await resolve(identity, db, body.target)
    try:
        libs = await abs_client.libraries(conn.base_url, conn.token)
    except (AbsError, httpx.HTTPError) as e:
        raise HTTPException(502, "Couldn't load your libraries.") from e
    lib = next((l for l in libs if l.get("id") == lib_id and l.get("mediaType") == "podcast"), None)
    folder = next((f for f in (lib or {}).get("folders") or [] if (f.get("fullPath") or "").strip()), None)
    if not lib or not folder:
        raise HTTPException(400, "That podcast library isn't there any more.")
    title = body.title.strip() or "Podcast"
    payload = {
        "libraryId": lib_id,
        "folderId": folder["id"],
        "path": folder["fullPath"].rstrip("/") + "/" + safe_folder_name(title),
        "media": {
            "metadata": {"title": title, "author": body.author, "description": body.description,
                         "feedUrl": body.feedUrl.strip(), "imageUrl": body.imageUrl},
            "autoDownloadEpisodes": body.autoDownload,
        },
    }
    try:
        r = await _post(conn, "/api/podcasts", payload)
    except httpx.HTTPError as e:
        raise HTTPException(502, "Couldn't reach Audiobookshelf.") from e
    if r.status_code == 403:
        raise HTTPException(403, "Your Audiobookshelf account isn't allowed to add podcasts (it needs upload rights).")
    if r.status_code >= 400:
        msg = (r.text or "").strip()[:160]
        raise HTTPException(400, f"Audiobookshelf didn't add it: {msg or f'HTTP {r.status_code}'}")
    item = r.json() or {}
    return {"ok": True, "id": tag(conn, item["id"]) if item.get("id") else None, "at": int(time.time() * 1000)}

