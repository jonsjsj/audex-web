"""Self-update — the Settings page's "Update now" button.

A running container can't safely replace itself mid-sequence: the moment it
stops ITSELF, the process carrying out the rest of the steps (rm, create,
start) dies with it. So this pulls the new image, then hands the actual
stop/remove/recreate/start off to a short-lived helper container — spawned
via the Docker socket, outside audex-web's own process tree, so it survives
audex-web going down mid-swap.

Needs the host's own Docker socket bind-mounted into THIS container (see
docker-compose.yml's `docker_sock` bind) — a clean 400 when it isn't, not a
crash. Homelab-scale trust model: this app has no separate admin role, so
any signed-in person can trigger it, same as every other write endpoint here.
"""
import json
import os
import re

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_identity
from app.core.config import settings

router = APIRouter(prefix="/api/admin", tags=["admin"])


def _client() -> httpx.AsyncClient:
    # The "docker" host in base_url is never actually resolved — all traffic
    # goes over the Unix socket transport instead; it just needs to be A
    # valid hostname for httpx's URL parsing.
    transport = httpx.AsyncHTTPTransport(uds=settings.DOCKER_SOCK)
    return httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=60)


@router.get("/update/available")
async def update_available(identity=Depends(get_current_identity)):
    return {"available": os.path.exists(settings.DOCKER_SOCK)}


def _parse_version(v: str) -> tuple[int, ...]:
    parts = re.findall(r"\d+", v or "")
    return tuple(int(p) for p in parts) or (0,)


def _version_newer(latest: str, current: str) -> bool:
    return _parse_version(latest) > _parse_version(current)


def _changelog_entry_for(md: str, version: str) -> str | None:
    """The one `## [x.y.z] ...` section matching `version`, body only (no
    other releases' entries leak into what the button shows)."""
    sections = re.split(r"^## \[", md, flags=re.MULTILINE)
    for section in sections[1:]:
        head, _, body = section.partition("]")
        if head.strip() == version:
            return body.strip()
    return None


@router.get("/update/check")
async def update_check(identity=Depends(get_current_identity)):
    """Compares the running version against VERSION on the repo's default
    branch — the same file CI stamps every image with (see .github/
    workflows/build.yml) — so "update available" reflects an actual newer
    release, not just "the self-update capability exists." The Settings
    button is only enabled when this says so."""
    current = settings.APP_VERSION
    base = f"https://raw.githubusercontent.com/{settings.UPDATE_REPO}/main"
    latest = None
    changelog_entry = None
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            vr = await client.get(f"{base}/VERSION")
            latest = vr.text.strip() if vr.status_code == 200 else None
            if latest:
                cr = await client.get(f"{base}/CHANGELOG.md")
                if cr.status_code == 200:
                    changelog_entry = _changelog_entry_for(cr.text, latest)
    except httpx.HTTPError:
        pass

    return {
        "currentVersion": current,
        "latestVersion": latest,
        "updateAvailable": bool(latest) and _version_newer(latest, current),
        "changelogEntry": changelog_entry,
    }


@router.post("/update")
async def trigger_update(identity=Depends(get_current_identity)):
    if not os.path.exists(settings.DOCKER_SOCK):
        raise HTTPException(400, "No Docker socket mounted — can't self-update from inside the container.")

    name = settings.UPDATE_CONTAINER_NAME
    helper_name = f"{name}-updater"
    image, _, tag = settings.UPDATE_IMAGE.rpartition(":")
    if not image:
        image, tag = tag, "latest"

    async with _client() as client:
        # Self-inspect: clone the running container's own Env/HostConfig so
        # the helper recreates an IDENTICAL container on the new image — no
        # secrets duplicated in this code, they're read back from the
        # container that's already running with them.
        r = await client.get(f"/containers/{name}/json")
        if r.status_code != 200:
            raise HTTPException(502, f"Couldn't inspect the running container ({name}).")
        info = r.json()
        cfg = info.get("Config") or {}
        host_cfg = info.get("HostConfig") or {}
        spec = {
            "Image": settings.UPDATE_IMAGE,
            "Env": cfg.get("Env") or [],
            "ExposedPorts": cfg.get("ExposedPorts") or {},
            "HostConfig": {
                "Binds": host_cfg.get("Binds") or [],
                "PortBindings": host_cfg.get("PortBindings") or {},
                "RestartPolicy": host_cfg.get("RestartPolicy") or {"Name": "unless-stopped"},
            },
        }

        # Pull the small curl helper image up front — POST /containers/create
        # 404s on an image that isn't already local, unlike `docker run`'s
        # CLI convenience of auto-pulling.
        await client.post("/images/create", params={"fromImage": "curlimages/curl", "tag": "latest"})

        # Best-effort: a leftover helper from a previous failed attempt would
        # otherwise 409 the create below (AutoRemove normally cleans this up,
        # but don't assume it always ran).
        await client.delete(f"/containers/{helper_name}", params={"force": "true"})

        sock = settings.DOCKER_SOCK
        script = (
            "sleep 2; "
            f"curl -s --unix-socket {sock} -X POST 'http://localhost/images/create?fromImage={image}&tag={tag}'; "
            f"curl -s --unix-socket {sock} -X POST http://localhost/containers/{name}/stop; "
            f"curl -s --unix-socket {sock} -X DELETE http://localhost/containers/{name}; "
            f"curl -s --unix-socket {sock} -X POST http://localhost/containers/create?name={name} "
            "-H 'Content-Type: application/json' -d \"$SPEC\"; "
            f"curl -s --unix-socket {sock} -X POST http://localhost/containers/{name}/start"
        )
        helper_body = {
            "Image": "curlimages/curl:latest",
            "Env": [f"SPEC={json.dumps(spec)}"],
            "Cmd": ["sh", "-c", script],
            "HostConfig": {"Binds": [f"{sock}:{sock}"], "AutoRemove": True},
        }
        cr = await client.post("/containers/create", params={"name": helper_name}, json=helper_body)
        if cr.status_code not in (200, 201):
            raise HTTPException(502, f"Couldn't start the updater: {cr.text}")
        helper_id = cr.json()["Id"]
        sr = await client.post(f"/containers/{helper_id}/start")
        if sr.status_code != 204:
            raise HTTPException(502, "Updater container failed to start.")

    return {"ok": True, "message": "Update started — this page will go offline for a few seconds while it swaps in."}
