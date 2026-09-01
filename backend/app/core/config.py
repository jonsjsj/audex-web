"""audex-web configuration — env-driven, matching the alignment-service/Codex pattern:
no config UI in v0, edit the .env and restart. Everything the app needs to talk to
Audiobookshelf, Codex, and an OIDC identity provider lives here."""
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    APP_VERSION: str = "0.1.0"

    # ── Audiobookshelf — the library + progress source of truth ────────────
    ABS_URL: str = ""  # e.g. http://192.168.68.250:13378 (LAN, server-side only)

    # ── Codex — sync parity target (see the plan §4: /api/progress pushes here) ──
    CODEX_URL: str = ""  # e.g. https://codex.bellaybestia.no
    CODEX_WEBHOOK_TOKEN: str = ""

    # ── audex-align gateway (read-along maps), reached via Codex or directly ──
    ALIGN_GATEWAY_URL: str = ""  # defaults to f"{CODEX_URL}/audex/align" when blank

    # ── Session + credential encryption ─────────────────────────────────────
    SECRET_KEY: str = "change-me-dev-only"
    SESSION_COOKIE: str = "audexweb_session"
    SESSION_DAYS: int = 30
    # Cookies need Secure=false on plain-HTTP local dev; true behind HTTPS (prod).
    SESSION_COOKIE_SECURE: bool = True

    # ── OIDC (Authentik) — SSO is the default sign-in; see core/oidc.py ─────
    OIDC_ISSUER: str = ""
    OIDC_CLIENT_ID: str = ""
    OIDC_CLIENT_SECRET: str = ""
    OIDC_REDIRECT_URI: str = ""  # defaults to <origin>/api/auth/oidc/callback
    OIDC_SCOPES: str = "openid email profile"
    # LAN-direct base for server-side discovery/token/userinfo calls (avoids a
    # round-trip through the public reverse proxy for backend-to-IdP traffic).
    OIDC_INTERNAL_BASE: str = ""

    DATABASE_URL: str = "sqlite+aiosqlite:////data/audexweb.db"
    DATA_DIR: str = "/data"


settings = Settings()


def oidc_active() -> bool:
    return bool(settings.OIDC_ISSUER and settings.OIDC_CLIENT_ID and settings.OIDC_CLIENT_SECRET)


def align_gateway_url() -> str:
    return (settings.ALIGN_GATEWAY_URL or f"{settings.CODEX_URL.rstrip('/')}/audex/align").rstrip("/")
