"""audex-web backend — serves the SPA and owns /api/*. See the plan: this process
holds sign-in state (SSO or ABS) and proxies Audiobookshelf + Codex so the browser
never sees a raw credential (§6) and gets a real, documented API to run on (§4)."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import admin, auth, library, play, read, readalong, report
# Aliased: app.api.settings (this router) vs app.core.config.settings (the
# Settings instance imported right below) would otherwise collide on the
# same name in this module's namespace.
from app.api import settings as settings_api
from app.core.config import oidc_active, settings
from app.core.database import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(title="audex-web", version=settings.APP_VERSION, lifespan=lifespan)

app.include_router(admin.router)
app.include_router(auth.router)
app.include_router(library.router)
app.include_router(play.router)
app.include_router(play.stream_router)
app.include_router(read.router)
app.include_router(readalong.router)
app.include_router(report.router)
app.include_router(settings_api.router)


@app.get("/api/health")
async def health():
    return {
        "status": "ok",
        "version": settings.APP_VERSION,
        "absConfigured": bool(settings.ABS_URL),
        "codexConfigured": bool(settings.CODEX_URL),
        "ssoEnabled": oidc_active(),
    }


# Serve the built React SPA (see the root Dockerfile's frontend build stage).
# Any non-/api route falls back to index.html so client-side routing works on a
# hard refresh — the same pattern Codex's backend uses for its own SPA. A path
# that IS a real file under STATIC_DIR (e.g. /CHANGELOG.md, copied into
# frontend/public/ so Vite bundles it) is served as itself first — without
# this check every such file would silently 404-as-index.html instead of
# returning its actual content.
STATIC_DIR = "/app/static"
if os.path.isdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=f"{STATIC_DIR}/assets"), name="assets")

    STATIC_ROOT = os.path.realpath(STATIC_DIR)

    @app.get("/{path:path}")
    async def serve_spa(path: str):
        # realpath resolves any ".." before the containment check below — a
        # naive os.path.join alone would let a path like "../../etc/passwd"
        # escape STATIC_DIR entirely.
        candidate = os.path.realpath(os.path.join(STATIC_DIR, path))
        in_static = candidate == STATIC_ROOT or candidate.startswith(STATIC_ROOT + os.sep)
        if path and in_static and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(f"{STATIC_DIR}/index.html")
