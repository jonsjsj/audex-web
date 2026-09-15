"""audex-web backend — serves the SPA and owns /api/*. See the plan: this process
holds sign-in state (SSO or ABS) and proxies Audiobookshelf + Codex so the browser
never sees a raw credential (§6) and gets a real, documented API to run on (§4)."""
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api import auth, library, play, read
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

app.include_router(auth.router)
app.include_router(library.router)
app.include_router(play.router)
app.include_router(play.stream_router)
app.include_router(read.router)
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
# hard refresh — the same pattern Codex's backend uses for its own SPA.
STATIC_DIR = "/app/static"
if os.path.isdir(STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=f"{STATIC_DIR}/assets"), name="assets")

    @app.get("/{path:path}")
    async def serve_spa(path: str):
        return FileResponse(f"{STATIC_DIR}/index.html")
