"""Settings → Activity (the log) and Settings → Connections (test everything now)."""
import os
import socket
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

    # The two things the one-click update depends on besides Docker itself: finding THIS container, and pulling
    # both images (the app from ghcr.io, the small helper from Docker Hub) from where this server runs.
    async def self_check():
        if not os.path.exists(settings.DOCKER_SOCK):
            raise _Failed("No Docker socket mounted.")
        transport = httpx.AsyncHTTPTransport(uds=settings.DOCKER_SOCK)
        async with httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=8) as client:
            for ref in (settings.UPDATE_CONTAINER_NAME, socket.gethostname()):
                r = await client.get(f"/containers/{ref}/json")
                if r.status_code == 200:
                    info = r.json()
                    nets = ", ".join((info.get("NetworkSettings") or {}).get("Networks", {}).keys()) or "none"
                    return f"found as \"{(info.get('Name') or '').lstrip('/')}\" · networks: {nets} (the update keeps them)"
        raise _Failed(f"Couldn't find this container (tried the name \"{settings.UPDATE_CONTAINER_NAME}\" and its own id). Set UPDATE_CONTAINER_NAME to its real name.")
    checks.append(await _timed("Updates · this container", self_check()))

    async def registry_check(auth_url: str, manifest_url: str, label: str):
        async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
            tr = await client.get(auth_url)
            if tr.status_code != 200:
                raise _Failed(f"{label}: token request answered {activity.describe_status(tr.status_code)}")
            token = (tr.json() or {}).get("token") or (tr.json() or {}).get("access_token")
            mr = await client.head(manifest_url, headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json",
            })
        if mr.status_code != 200:
            hint = " (rate limit — wait a bit, or log this host in to Docker Hub)" if mr.status_code == 429 else ""
            raise _Failed(f"{label}: answered {activity.describe_status(mr.status_code)}{hint}")
        return f"{label} reachable — the image can be pulled from here"

    img, _, tag = settings.UPDATE_IMAGE.rpartition(":")
    img, tag = (img, tag) if img else (tag, "latest")
    if img.startswith("ghcr.io/"):
        repo = img[len("ghcr.io/"):]
        checks.append(await _timed("Updates · app image (ghcr.io)", registry_check(
            f"https://ghcr.io/token?scope=repository:{repo}:pull&service=ghcr.io",
            f"https://ghcr.io/v2/{repo}/manifests/{tag}", f"ghcr.io/{repo}:{tag}")))
    checks.append(await _timed("Updates · helper image (Docker Hub)", registry_check(
        "https://auth.docker.io/token?service=registry.docker.io&scope=repository:curlimages/curl:pull",
        "https://registry-1.docker.io/v2/curlimages/curl/manifests/latest", "curlimages/curl:latest")))

    for c in checks:
        if not c["ok"]:
            await activity.record(identity.id, "diagnostics", c["name"], False, c["detail"], dedupe_s=300)
    return {"checkedAt": int(time.time() * 1000), "checks": checks}
