"""Manual "Sync now" — the sidebar button. Webdex itself reads Audiobookshelf live
on every page load (nothing is cached), so what this adds is the other half:
telling Audiobookshelf to re-scan its files (book info) and telling Codex to
sync from Audiobookshelf right now instead of on its own schedule (progress).
Each service is reported separately so a failure on one says which."""
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import list_connections
from app.api.deps import get_codex_token, get_current_identity
from app.core import abs_client, codex_client
from app.core.abs_client import AbsError
from app.core.config import settings
from app.core.database import Identity, get_db

router = APIRouter(prefix="/api/sync", tags=["sync"])


@router.post("")
async def sync_now(
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
):
    servers = []
    for conn in await list_connections(identity, db):
        entry = {"name": conn.name, "ok": False, "rescan": "no", "error": None}
        try:
            libs = [l for l in await abs_client.libraries(conn.base_url, conn.token) if l.get("mediaType", "book") == "book"]
            entry["ok"] = True
            started = 0
            for lib in libs:
                try:
                    if await abs_client.scan_library(conn.base_url, conn.token, lib["id"]):
                        started += 1
                except AbsError:
                    pass
            entry["rescan"] = "started" if started else "not-allowed"
        except AbsError as e:
            entry["error"] = str(e)
        servers.append(entry)

    if not settings.CODEX_URL:
        codex = {"state": "not-configured", "detail": "No Codex set up on this server."}
    elif not codex_token:
        codex = {"state": "not-linked", "detail": "Codex isn't linked — add your token in Settings."}
    else:
        ok, detail = await codex_client.trigger_abs_sync(settings.CODEX_URL, codex_token)
        codex = {"state": "started" if ok else "failed", "detail": detail}
    return {"audiobookshelf": servers, "codex": codex}
