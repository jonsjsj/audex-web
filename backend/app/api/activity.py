"""Settings → Activity (the log) and Settings → Connections (test everything now)."""
import os
import time

import httpx
from fastapi import APIRouter, Depends
from sqlalchemy import delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.connections import list_connections
from app.api.deps import get_codex_token, get_current_identity
from app.core import abs_client, activity
from app.core.abs_client import AbsError
from app.core.config import align_gateway_url, settings
from app.core.database import ActivityLog, Identity, get_db

router = APIRouter(prefix="/api", tags=["activity"])


@router.get("/activity")
async def get_activity(
    failures: bool = False,
    limit: int = 150,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    q = select(ActivityLog).where(or_(ActivityLog.identity_id == identity.id, ActivityLog.identity_id.is_(None)))
    if failures:
        q = q.where(ActivityLog.ok.is_(False))
    rows = (await db.execute(q.order_by(ActivityLog.id.desc()).limit(max(1, min(limit, 500))))).scalars().all()
    return [
        {"id": r.id, "at": int(r.at * 1000), "area": r.area, "action": r.action, "ok": bool(r.ok), "message": r.message}
        for r in rows
    ]


@router.delete("/activity")
async def clear_activity(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    await db.execute(delete(ActivityLog).where(ActivityLog.identity_id == identity.id))
    await db.commit()
    return {"ok": True}


async def _timed(name: str, coro) -> dict:
    """Run one check: {name, ok, ms, detail}. A check returns a detail string on success or raises."""
    t0 = time.time()
    try:
        detail = await coro
        return {"name": name, "ok": True, "ms": int((time.time() - t0) * 1000), "detail": detail}
    except _Failed as f:
        return {"name": name, "ok": False, "ms": int((time.time() - t0) * 1000), "detail": str(f)}
    except (httpx.HTTPError, AbsError) as e:
        return {"name": name, "ok": False, "ms": int((time.time() - t0) * 1000),
                "detail": activity.describe_error(e) if isinstance(e, httpx.HTTPError) else str(e)}


class _Failed(Exception):
    pass


async def _get(url: str, **kw) -> httpx.Response:
    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        return await client.get(url, **kw)


@router.get("/diagnostics")
async def diagnostics(
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
    codex_token: str | None = Depends(get_codex_token),
):
    """Try every connection Webdex depends on, right now, and say exactly what failed and why — the
    answer to "it can't reach Codex" without reading container logs."""
    checks: list[dict] = []

    for conn in await list_connections(identity, db):
        async def abs_check(c=conn):
            libs = await abs_client.libraries(c.base_url, c.token)
            return f"connected — {len(libs)} librar{'y' if len(libs) == 1 else 'ies'} at {c.base_url}"
        checks.append(await _timed(f"Audiobookshelf · {conn.name}", abs_check()))
    if not checks:
        checks.append({"name": "Audiobookshelf", "ok": False, "ms": 0, "detail": "No Audiobookshelf server connected."})

    base = settings.CODEX_URL.rstrip("/")
    if not base:
        checks.append({"name": "Codex", "ok": False, "ms": 0, "detail": "CODEX_URL isn't set on this server, so Codex features are off."})
    else:
        async def codex_reach():
            r = await _get(f"{base}/audex/config")
            if r.status_code != 200:
                raise _Failed(f"{base} answered {activity.describe_status(r.status_code)}")
            meta = bool((r.json() or {}).get("meta_via_codex"))
            return f"reachable at {base}" + (" · serves checked metadata" if meta else " · older Codex (no checked-metadata API)")
        checks.append(await _timed("Codex · reachable", codex_reach()))

        async def codex_token_check():
            if not codex_token:
                raise _Failed("Not linked — add your Codex API key in Settings.")
            r = await _get(f"{base}/api/auth/me", headers={"Authorization": f"Bearer {codex_token}"})
            if r.status_code != 200:
                raise _Failed(activity.describe_status(r.status_code))
            return "your Codex API key is accepted"
        checks.append(await _timed("Codex · your account", codex_token_check()))

        async def align_check():
            r = await _get(f"{align_gateway_url()}/status/diagnostic-ping")
            if r.status_code != 200:
                raise _Failed(activity.describe_status(r.status_code))
            return "read-along service answers"
        checks.append(await _timed("Codex · read-along service", align_check()))

    async def github_check():
        r = await _get(f"https://raw.githubusercontent.com/{settings.UPDATE_REPO}/main/VERSION")
        if r.status_code != 200:
            raise _Failed(f"GitHub answered {activity.describe_status(r.status_code)} (is the repo public? is UPDATE_REPO right?)")
        return f"latest published version is v{r.text.strip()}"
    checks.append(await _timed("Updates · GitHub", github_check()))

    async def docker_check():
        if not os.path.exists(settings.DOCKER_SOCK):
            raise _Failed("No Docker socket mounted — the Update button can't swap the container (update from Portainer instead).")
        transport = httpx.AsyncHTTPTransport(uds=settings.DOCKER_SOCK)
        async with httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=8) as client:
            r = await client.get("/_ping")
        if r.status_code != 200:
            raise _Failed(f"Docker answered {r.status_code}")
        return "Docker socket works — one-click update is possible"
    checks.append(await _timed("Updates · Docker", docker_check()))

    for c in checks:
        if not c["ok"]:
            await activity.record(identity.id, "diagnostics", c["name"], False, c["detail"], dedupe_s=300)
    return {"checkedAt": int(time.time() * 1000), "checks": checks}
