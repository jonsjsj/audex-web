"""Sign-in: SSO (Authentik OIDC) by default, Audiobookshelf credentials as a fallback
— see the plan §6. The browser only ever receives an httpOnly session cookie; every
secret (the OIDC client secret, any ABS token) stays server-side.

SSO identity vs. ABS access are two different things and this file is honest about
that: Authentik tells us WHO you are, but Audex's data (library, progress) lives in
Audiobookshelf, which doesn't share that identity automatically. So an SSO login that
has never been linked to an ABS account gets `abs_linked: false` from /me, and the
frontend prompts once for ABS credentials (POST /auth/link/abs) — submitted straight
to this backend, never exposed to page JS beyond the form submit. Every login after
that is pure SSO.
"""
import secrets
import time
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_identity
from app.core import abs_client, codex_client
from app.core.abs_client import AbsAuthError
from app.core.config import oidc_active, settings
from app.core.database import AbsServer, Identity, WebSession, get_db
from app.core.security import decrypt_value, encrypt_value, new_session_id

router = APIRouter(prefix="/api/auth", tags=["auth"])

# In-memory OIDC state store — fine for a single-instance homelab service (Codex's
# own OIDC login uses the identical approach).
_oidc_states: dict[str, dict] = {}

_SESSION_SECONDS = settings.SESSION_DAYS * 86400


def _set_session_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        key=settings.SESSION_COOKIE,
        value=session_id,
        max_age=_SESSION_SECONDS,
        httponly=True,
        secure=settings.SESSION_COOKIE_SECURE,
        samesite="lax",
        path="/",
    )


async def _start_session(db: AsyncSession, identity: Identity, response: Response) -> None:
    session_id = new_session_id()
    db.add(WebSession(id=session_id, identity_id=identity.id, expires_at=time.time() + _SESSION_SECONDS))
    await db.commit()
    _set_session_cookie(response, session_id)


class AbsLoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login/abs")
async def login_with_abs(body: AbsLoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    """Fallback sign-in: authenticate against Audiobookshelf directly. Creates (or
    updates) an Identity carrying that ABS account and starts a session — one step
    does both what SSO+link would do in two."""
    try:
        abs_user = await abs_client.login(settings.ABS_URL, body.username, body.password)
    except AbsAuthError as e:
        raise HTTPException(401, str(e))

    abs_user_id = str(abs_user["id"])
    identity = (
        await db.execute(select(Identity).where(Identity.abs_user_id == abs_user_id))
    ).scalar_one_or_none()
    if identity is None:
        identity = Identity(abs_user_id=abs_user_id, abs_username=abs_user.get("username"))
        db.add(identity)
    identity.abs_username = abs_user.get("username")
    identity.abs_token_encrypted = encrypt_value(abs_user["token"])
    if not identity.display_name:
        identity.display_name = abs_user.get("username")
    await db.flush()
    await _start_session(db, identity, response)
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(settings.SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(identity: Identity = Depends(get_current_identity)):
    return {
        "id": identity.id,
        "displayName": identity.display_name,
        "email": identity.email,
        "ssoLinked": bool(identity.oidc_sub),
        "absLinked": bool(identity.abs_token_encrypted),
        "absUsername": identity.abs_username,
        "codexLinked": bool(identity.codex_token_encrypted),
        "codexConfigured": bool(settings.CODEX_URL),
    }


class LinkAbsRequest(BaseModel):
    username: str
    password: str


@router.post("/link/abs")
async def link_abs(
    body: LinkAbsRequest,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """One-time step after an SSO-only login: attach an Audiobookshelf account to the
    already-signed-in identity so audex-web can act on your library. Never asked again
    once linked."""
    try:
        abs_user = await abs_client.login(settings.ABS_URL, body.username, body.password)
    except AbsAuthError as e:
        raise HTTPException(401, str(e))
    identity.abs_user_id = str(abs_user["id"])
    identity.abs_username = abs_user.get("username")
    identity.abs_token_encrypted = encrypt_value(abs_user["token"])
    await db.commit()
    return {"ok": True, "absUsername": identity.abs_username}


class LinkCodexRequest(BaseModel):
    token: str


@router.post("/link/codex")
async def link_codex(
    body: LinkCodexRequest,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Optional, same as the mobile app's Settings → Codex sync: paste an API
    key generated from Codex's own Settings → API Keys page. Verified against
    Codex before saving, so a typo'd/expired key fails loudly here instead of
    silently no-opping every future progress push."""
    if not settings.CODEX_URL:
        raise HTTPException(400, "This server hasn't been configured with a Codex instance (CODEX_URL).")
    token = body.token.strip()
    if not token:
        raise HTTPException(400, "Paste your Codex API key.")
    if not await codex_client.verify_token(settings.CODEX_URL, token):
        raise HTTPException(401, "Codex didn't accept that key — check it's current and try again.")
    identity.codex_token_encrypted = encrypt_value(token)
    await db.commit()
    return {"ok": True}


@router.post("/unlink/codex")
async def unlink_codex(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    identity.codex_token_encrypted = None
    await db.commit()
    return {"ok": True}


# ─── Additional Audiobookshelf servers ───────────────────────────────────────
# The deploy's configured ABS_URL is the "primary" connection (its token lives
# on the Identity). Beyond that, a person can connect extra servers here — each
# its own box, url + credentials — and the library views combine them, the way
# the mobile app syncs every enabled server. See app/api/connections.py.

def _host_label(base_url: str) -> str:
    return urlparse(base_url).netloc or base_url


@router.get("/abs/servers")
async def list_abs_servers(identity: Identity = Depends(get_current_identity), db: AsyncSession = Depends(get_db)):
    """Every connected ABS server, primary first. The primary carries key ""
    and can't be removed here (it's the deploy's own ABS_URL, managed by
    sign-in/out); additional ones carry their row id as key."""
    out = []
    if identity.abs_token_encrypted and settings.ABS_URL:
        out.append({
            "key": "",
            "name": _host_label(settings.ABS_URL),
            "url": settings.ABS_URL.rstrip("/"),
            "username": identity.abs_username,
            "primary": True,
        })
    rows = (
        await db.execute(
            select(AbsServer).where(AbsServer.identity_id == identity.id).order_by(AbsServer.id)
        )
    ).scalars().all()
    for r in rows:
        out.append({
            "key": str(r.id),
            "name": r.name or _host_label(r.base_url),
            "url": r.base_url.rstrip("/"),
            "username": r.abs_username,
            "primary": False,
        })
    return out


class AddAbsServerRequest(BaseModel):
    url: str
    username: str
    password: str
    name: str | None = None


@router.post("/abs/servers")
async def add_abs_server(
    body: AddAbsServerRequest,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    """Connect another Audiobookshelf server: its credentials are verified with
    a real login before the token is stored, so a bad url/password fails here
    rather than silently dropping that server out of the combined library."""
    url = body.url.strip().rstrip("/")
    if not url:
        raise HTTPException(400, "Enter the Audiobookshelf server URL.")
    if not (url.startswith("http://") or url.startswith("https://")):
        raise HTTPException(400, "The server URL must start with http:// or https://.")
    # Already the primary, or already added? Point them at what's there rather
    # than stacking a duplicate connection.
    if settings.ABS_URL and url == settings.ABS_URL.rstrip("/"):
        raise HTTPException(400, "That's this deploy's main Audiobookshelf server — it's already connected.")
    existing = (
        await db.execute(
            select(AbsServer).where(AbsServer.identity_id == identity.id, AbsServer.base_url == url)
        )
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(400, "That server is already connected.")
    try:
        abs_user = await abs_client.login(url, body.username, body.password)
    except AbsAuthError as e:
        raise HTTPException(401, str(e))
    row = AbsServer(
        identity_id=identity.id,
        name=(body.name or "").strip() or None,
        base_url=url,
        abs_user_id=str(abs_user["id"]),
        abs_username=abs_user.get("username"),
        token_encrypted=encrypt_value(abs_user["token"]),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return {"ok": True, "key": str(row.id), "name": row.name or _host_label(url), "username": row.abs_username}


@router.delete("/abs/servers/{server_id}")
async def remove_abs_server(
    server_id: int,
    identity: Identity = Depends(get_current_identity),
    db: AsyncSession = Depends(get_db),
):
    row = (
        await db.execute(
            select(AbsServer).where(AbsServer.id == server_id, AbsServer.identity_id == identity.id)
        )
    ).scalar_one_or_none()
    if row:
        await db.delete(row)
        await db.commit()
    return {"ok": True}


# ─── OIDC (Authentik SSO) ────────────────────────────────────────────────────
# Mirrors Codex's proven backend/app/api/auth.py OIDC flow: discovery via an
# internal LAN base for server-to-server calls, the authorize endpoint rewritten
# back to the public URL for the browser redirect, and the id_token's signature
# verified against the IdP's JWKS before any claim in it is trusted.

def _oidc_internal(url: str) -> str:
    if not settings.OIDC_INTERNAL_BASE or not settings.OIDC_ISSUER:
        return url
    pub = urlparse(settings.OIDC_ISSUER)
    return url.replace(f"{pub.scheme}://{pub.netloc}", settings.OIDC_INTERNAL_BASE.rstrip("/"), 1)


def _discovery_url() -> str:
    ipath = urlparse(settings.OIDC_ISSUER).path.rstrip("/")
    if settings.OIDC_INTERNAL_BASE:
        base = settings.OIDC_INTERNAL_BASE.rstrip("/")
    else:
        pub = urlparse(settings.OIDC_ISSUER)
        base = f"{pub.scheme}://{pub.netloc}"
    return f"{base}{ipath}/.well-known/openid-configuration"


@router.get("/oidc/login")
async def oidc_login(request: Request):
    if not oidc_active():
        raise HTTPException(404, "SSO isn't configured on this server.")
    state = secrets.token_urlsafe(32)
    nonce = secrets.token_urlsafe(32)
    _oidc_states[state] = {"nonce": nonce, "at": time.time()}

    redirect_uri = settings.OIDC_REDIRECT_URI or str(request.base_url).rstrip("/") + "/api/auth/oidc/callback"
    params = {
        "response_type": "code",
        "client_id": settings.OIDC_CLIENT_ID,
        "redirect_uri": redirect_uri,
        "scope": settings.OIDC_SCOPES,
        "state": state,
        "nonce": nonce,
    }
    async with httpx.AsyncClient(verify=False) as client:
        disc = await client.get(_discovery_url(), timeout=10)
        disc.raise_for_status()
        disc_data = disc.json()

    auth_endpoint = disc_data["authorization_endpoint"]
    if settings.OIDC_INTERNAL_BASE:
        pub = urlparse(settings.OIDC_ISSUER)
        auth_endpoint = auth_endpoint.replace(
            settings.OIDC_INTERNAL_BASE.rstrip("/"), f"{pub.scheme}://{pub.netloc}", 1,
        )
    return RedirectResponse(f"{auth_endpoint}?{urlencode(params)}")


@router.get("/oidc/callback")
async def oidc_callback(code: str, state: str, request: Request, db: AsyncSession = Depends(get_db)):
    if not oidc_active():
        raise HTTPException(404, "SSO isn't configured on this server.")
    state_data = _oidc_states.pop(state, None)
    if not state_data:
        raise HTTPException(400, "This sign-in link expired — try again.")

    redirect_uri = settings.OIDC_REDIRECT_URI or str(request.base_url).rstrip("/") + "/api/auth/oidc/callback"

    async with httpx.AsyncClient(verify=False) as client:
        disc = await client.get(_discovery_url(), timeout=10)
        disc.raise_for_status()
        disc_data = disc.json()
        token_endpoint = _oidc_internal(disc_data["token_endpoint"])

        token_resp = await client.post(
            token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": redirect_uri,
                "client_id": settings.OIDC_CLIENT_ID,
                "client_secret": settings.OIDC_CLIENT_SECRET,
            },
            timeout=10,
        )
        if token_resp.status_code != 200:
            raise HTTPException(401, "SSO sign-in failed at the token exchange.")
        token_data = token_resp.json()
        id_token = token_data.get("id_token", "")
        access_token_oidc = token_data.get("access_token")

        if id_token:
            jwks_uri = _oidc_internal(disc_data.get("jwks_uri") or "")
            jwks = (await client.get(jwks_uri, timeout=10)).json()
            from jose import jwt as jose_jwt
            try:
                userinfo = jose_jwt.decode(
                    id_token, jwks,
                    algorithms=["RS256", "RS384", "RS512", "ES256"],
                    audience=settings.OIDC_CLIENT_ID,
                    options={"verify_iss": False, "verify_at_hash": False},
                )
            except Exception as e:
                raise HTTPException(401, f"SSO token verification failed: {e}")
            if userinfo.get("nonce") != state_data.get("nonce"):
                raise HTTPException(401, "SSO nonce mismatch — try signing in again.")
        else:
            userinfo_endpoint = _oidc_internal(disc_data["userinfo_endpoint"])
            ui = await client.get(userinfo_endpoint, headers={"Authorization": f"Bearer {access_token_oidc}"}, timeout=10)
            userinfo = ui.json()

    sub = userinfo.get("sub")
    email = userinfo.get("email", "")
    name = userinfo.get("name") or userinfo.get("preferred_username") or email

    identity = (await db.execute(select(Identity).where(Identity.oidc_sub == sub))).scalar_one_or_none()
    if identity is None and email:
        # Same email as an ABS-fallback-created identity? Link them rather than
        # duplicating — one person, one Identity row, regardless of sign-in path.
        identity = (await db.execute(select(Identity).where(Identity.email == email))).scalar_one_or_none()
    if identity is None:
        identity = Identity(oidc_sub=sub, email=email, display_name=name)
        db.add(identity)
        await db.flush()
    else:
        identity.oidc_sub = sub
        identity.email = email or identity.email
        identity.display_name = identity.display_name or name

    response = RedirectResponse(url="/")
    await _start_session(db, identity, response)
    return response
