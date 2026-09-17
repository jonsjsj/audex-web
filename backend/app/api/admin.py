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
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException

from app.api.deps import get_current_identity
from app.core.config import settings

router = APIRouter(prefix="/api/admin", tags=["admin"])

# Where the updater records its progress. Lives in the data volume so the
# freshly-recreated container can read back what its predecessor's swap did —
# the whole point of the status endpoint is to survive the restart. Plain
# space-separated text ("<state> <step> <target> <epoch>") so the helper, a
# minimal curl-image shell with no jq, can write it without JSON escaping.
_STATUS_FILE = "update_status.txt"


def _client() -> httpx.AsyncClient:
    # The "docker" host in base_url is never actually resolved — all traffic
    # goes over the Unix socket transport instead; it just needs to be A
    # valid hostname for httpx's URL parsing. Timeout is generous: pulling a
    # fresh image can take a while and must not be cut off mid-download.
    transport = httpx.AsyncHTTPTransport(uds=settings.DOCKER_SOCK)
    return httpx.AsyncClient(transport=transport, base_url="http://docker", timeout=300)


def _status_path() -> str:
    return os.path.join(settings.DATA_DIR, _STATUS_FILE)


def _write_status(state: str, step: str, target: str) -> None:
    try:
        with open(_status_path(), "w") as f:
            f.write(f"{state} {step} {target} {int(time.time())}")
    except OSError:
        pass  # best-effort; a missing status file just reads back as "idle"


async def _pull_image(client: httpx.AsyncClient, image: str, tag: str) -> None:
    """Pull an image via the Docker API, raising a DESCRIPTIVE error if the
    registry rejects it. This is the single most common self-update failure
    (private/renamed package, wrong tag, no network) and the old fire-and-forget
    helper swallowed it silently with `curl -s`, leaving the button to look
    like it worked while nothing changed. A pull error is surfaced as JSON
    lines with an `error` field even when the HTTP status is 200."""
    try:
        resp = await client.post("/images/create", params={"fromImage": image, "tag": tag})
    except httpx.HTTPError as e:
        raise HTTPException(502, f"Couldn't reach the Docker daemon to pull {image}:{tag}: {e}")
    if resp.status_code != 200:
        raise HTTPException(502, f"Docker refused to pull {image}:{tag} (HTTP {resp.status_code}): {resp.text[:300]}")
    for line in resp.text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if obj.get("error"):
            raise HTTPException(502, f"Pull of {image}:{tag} failed: {obj['error']}")


@router.get("/update/available")
async def update_available(identity=Depends(get_current_identity)):
    return {"available": os.path.exists(settings.DOCKER_SOCK)}


@router.get("/update/status")
async def update_status(identity=Depends(get_current_identity)):
    """The most recent self-update attempt's outcome, so the Settings page can
    show success/failure after the swap instead of guessing. `state` is one of
    idle | in_progress | success | failed; `step` names where a failure landed."""
    path = _status_path()
    if not os.path.exists(path):
        return {"state": "idle", "step": None, "target": None, "at": None}
    try:
        with open(path) as f:
            parts = f.read().strip().split()
    except OSError:
        return {"state": "idle", "step": None, "target": None, "at": None}
    state = parts[0] if len(parts) > 0 else "idle"
    step = parts[1] if len(parts) > 1 else None
    target = parts[2] if len(parts) > 2 else None
    at = int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None
    return {"state": state, "step": step, "target": target, "at": at}


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
            raise HTTPException(
                502,
                f"Couldn't find the running container named \"{name}\" "
                f"(Docker returned {r.status_code}). If your container has a different "
                f"name, set UPDATE_CONTAINER_NAME to match it.",
            )
        info = r.json()
        cfg = info.get("Config") or {}
        host_cfg = info.get("HostConfig") or {}
        binds = host_cfg.get("Binds") or []
        spec = {
            "Image": settings.UPDATE_IMAGE,
            "Env": cfg.get("Env") or [],
            "ExposedPorts": cfg.get("ExposedPorts") or {},
            "HostConfig": {
                "Binds": binds,
                "PortBindings": host_cfg.get("PortBindings") or {},
                "RestartPolicy": host_cfg.get("RestartPolicy") or {"Name": "unless-stopped"},
            },
        }

        # 1) Pull the NEW app image up front, IN THIS PROCESS, so a failed pull
        # (private/renamed package, wrong tag, no network) is reported to the
        # user right here instead of silently no-opping inside the helper. This
        # is the fix for "the button says it updated but nothing changed."
        await _pull_image(client, image, tag)

        # 2) Pull the tiny curl helper image (also checked) — POST
        # /containers/create 404s on an image that isn't already local.
        await _pull_image(client, "curlimages/curl", "latest")

        # Best-effort: a leftover helper from a previous failed attempt would
        # otherwise 409 the create below (AutoRemove normally cleans this up,
        # but don't assume it always ran).
        await client.delete(f"/containers/{helper_name}", params={"force": "true"})

        # Give the helper the same /data mount the app has, so it can write the
        # step-by-step result where the recreated container will read it back.
        # A Bind is "<source>:<target>[:opts]"; the source may be a host path
        # OR a named volume — either works as the helper's own bind source.
        data_source = None
        for b in binds:
            parts = b.split(":")
            if len(parts) >= 2 and parts[1] == settings.DATA_DIR:
                data_source = parts[0]
                break
        status_file = f"{settings.DATA_DIR}/{_STATUS_FILE}" if data_source else "/tmp/_ignore"

        _write_status("in_progress", "queued", tag)

        sock = settings.DOCKER_SOCK
        # Plain-text status ("<state> <step> <target> <epoch>") — no JSON to
        # escape in a bare curl-image shell. `curl -f` makes each step fail the
        # script on an HTTP error (the old `curl -s` swallowed them), and the
        # `|| { … }` records exactly which step broke before exiting. The image
        # is already pulled above, so the helper only does the self-recreate the
        # app can't do from inside itself.
        script = "\n".join([
            f'S="{status_file}"',
            f'w(){{ echo "$1 $2 {tag} $(date +%s)" > "$S" 2>/dev/null || true; }}',
            "sleep 2",
            "w in_progress stop",
            f"curl -fsS --unix-socket {sock} -X POST http://localhost/containers/{name}/stop || {{ w failed stop; exit 1; }}",
            "w in_progress remove",
            f"curl -fsS --unix-socket {sock} -X DELETE http://localhost/containers/{name} || {{ w failed remove; exit 1; }}",
            "w in_progress create",
            f'curl -fsS --unix-socket {sock} -X POST "http://localhost/containers/create?name={name}" -H "Content-Type: application/json" -d "$SPEC" || {{ w failed create; exit 1; }}',
            "w in_progress start",
            f"curl -fsS --unix-socket {sock} -X POST http://localhost/containers/{name}/start || {{ w failed start; exit 1; }}",
            "w success done",
        ])
        helper_binds = [f"{sock}:{sock}"]
        if data_source:
            helper_binds.append(f"{data_source}:{settings.DATA_DIR}")
        helper_body = {
            "Image": "curlimages/curl:latest",
            "Env": [f"SPEC={json.dumps(spec)}"],
            "Cmd": ["sh", "-c", script],
            "HostConfig": {"Binds": helper_binds, "AutoRemove": True},
        }
        cr = await client.post("/containers/create", params={"name": helper_name}, json=helper_body)
        if cr.status_code not in (200, 201):
            _write_status("failed", "helper_create", tag)
            raise HTTPException(502, f"Couldn't start the updater: {cr.text}")
        helper_id = cr.json()["Id"]
        sr = await client.post(f"/containers/{helper_id}/start")
        if sr.status_code != 204:
            _write_status("failed", "helper_start", tag)
            raise HTTPException(502, "Updater container failed to start.")

    return {"ok": True, "message": "New image pulled — swapping now. This page will briefly go offline while it restarts."}
