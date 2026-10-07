"""The activity log (Settings → Activity): one line per thing that happened when Webdex talked to
Audiobookshelf, Codex or GitHub, with the failure reason when it didn't work.

`record()` never raises — logging must not be able to break the thing being logged — and uses its own
database session so it works from anywhere (including after a request's own session is done).
"""
import time

import httpx
from sqlalchemy import delete, func, select

from app.core.database import ActivityLog, AsyncSessionLocal

KEEP_PER_IDENTITY = 500
_recent: dict[tuple, float] = {}


def describe_error(exc: BaseException) -> str:
    """A plain-language reason for a failed network call (what to look at, not a stack trace)."""
    if isinstance(exc, httpx.ConnectTimeout) or isinstance(exc, httpx.ReadTimeout) or isinstance(exc, httpx.TimeoutException):
        return "timed out — the server is slow or not answering"
    if isinstance(exc, httpx.ConnectError):
        text = str(exc).lower()
        if "name or service not known" in text or "nodename" in text or "temporary failure in name" in text or "getaddrinfo" in text:
            return "couldn't find that address (DNS) — check the URL, or that this container can resolve it"
        if "certificate" in text or "ssl" in text:
            return "the secure connection failed (certificate/SSL problem)"
        if "refused" in text:
            return "connection refused — nothing is listening there (wrong address or port, or it's down)"
        return f"couldn't connect ({str(exc) or exc.__class__.__name__})"
    if isinstance(exc, httpx.HTTPStatusError):
        return f"answered HTTP {exc.response.status_code}"
    if isinstance(exc, httpx.HTTPError):
        return f"network error ({exc.__class__.__name__}: {exc})"
    return f"{exc.__class__.__name__}: {exc}"


def describe_status(status: int) -> str:
    hints = {
        401: "HTTP 401 — the token was rejected (relink it in Settings)",
        403: "HTTP 403 — refused (a firewall/Cloudflare rule, or no permission)",
        404: "HTTP 404 — that address/path doesn't exist (wrong URL, or an older version)",
        429: "HTTP 429 — too many requests, try again shortly",
    }
    if status in hints:
        return hints[status]
    if status >= 500:
        return f"HTTP {status} — the server had an error"
    return f"HTTP {status}"


async def record(identity_id: int | None, area: str, action: str, ok: bool, message: str = "", *, dedupe_s: float = 0) -> None:
    """Add a log line. `dedupe_s` skips an identical line seen within that many seconds (stops a failing
    15-second sync from writing the same failure forever)."""
    try:
        key = (identity_id, area, action, ok, message)
        now = time.time()
        if dedupe_s and now - _recent.get(key, 0) < dedupe_s:
            return
        _recent[key] = now
        if len(_recent) > 500:
            for k in [k for k, t in _recent.items() if now - t > 3600]:
                _recent.pop(k, None)
        async with AsyncSessionLocal() as db:
            db.add(ActivityLog(identity_id=identity_id, at=now, area=area, action=action, ok=ok, message=(message or "")[:600]))
            await db.commit()
            count = (await db.execute(select(func.count()).select_from(ActivityLog).where(ActivityLog.identity_id == identity_id))).scalar() or 0
            if count > KEEP_PER_IDENTITY + 50:
                cutoff = (await db.execute(
                    select(ActivityLog.id).where(ActivityLog.identity_id == identity_id)
                    .order_by(ActivityLog.id.desc()).offset(KEEP_PER_IDENTITY).limit(1)
                )).scalar()
                if cutoff:
                    await db.execute(delete(ActivityLog).where(ActivityLog.identity_id == identity_id, ActivityLog.id <= cutoff))
                    await db.commit()
    except Exception:  # noqa: BLE001 — logging must never break the caller
        pass
