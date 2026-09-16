"""Anonymous problem reports — Settings' "Report a problem" button, plus
automatic capture of unhandled frontend errors (see the ErrorBoundary
component). Filed as GitHub issues on REPORT_GITHUB_REPO.

No personal data leaves this server: a book involved in a report is
identified only by anon_code() — a stable 10-digit HMAC-SHA256 of the ABS
item id, keyed by this server's own SECRET_KEY. Same book always yields the
same code (so repeat reports correlate — "this keeps happening on the same
title" is visible), but the code can't be reversed back to the item id, let
alone the title, without SECRET_KEY. Every itemId occurrence in the message/
stack/URL is replaced with this code before the report ever leaves the
process; nothing about who filed it is included either.
"""
import hashlib
import hmac
import time

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.api.deps import get_current_identity
from app.core.config import settings

router = APIRouter(prefix="/api/report", tags=["report"])

# In-memory de-dupe for AUTOMATIC reports only: (book code, message hash) ->
# last-filed epoch seconds. Resets on restart — fine for a homelab-scale
# app; the point is damping a repeat crash from filing a fresh issue every
# time it happens within the window, not perfect cross-restart tracking.
_RECENT: dict[tuple[str, str], float] = {}
_DEDUPE_WINDOW_S = 24 * 3600
_MAX_TRACKED = 500


def anon_code(item_id: str) -> str:
    mac = hmac.new(settings.SECRET_KEY.encode(), item_id.encode(), hashlib.sha256).hexdigest()
    return str(int(mac[:12], 16) % 10_000_000_000).zfill(10)


def _scrub(text: str | None, item_id: str | None, code: str | None) -> str | None:
    if not text:
        return text
    return text.replace(item_id, code or "") if item_id else text


class ReportBody(BaseModel):
    message: str
    note: str | None = None
    itemId: str | None = None
    stack: str | None = None
    url: str | None = None
    automatic: bool = False


@router.get("/available")
async def report_available(identity=Depends(get_current_identity)):
    return {"available": bool(settings.REPORT_GITHUB_TOKEN)}


@router.post("")
async def submit_report(body: ReportBody, identity=Depends(get_current_identity)):
    if not settings.REPORT_GITHUB_TOKEN:
        raise HTTPException(400, "Reporting isn't configured on this server.")

    code = anon_code(body.itemId) if body.itemId else None
    message = _scrub(body.message, body.itemId, code) or ""
    stack = _scrub(body.stack, body.itemId, code)
    url = _scrub(body.url, body.itemId, code) or ""

    dedupe_key = (code or "app", hashlib.sha1(message.encode()).hexdigest()[:12])
    if body.automatic:
        now = time.time()
        last = _RECENT.get(dedupe_key)
        if last and now - last < _DEDUPE_WINDOW_S:
            return {"ok": True, "deduped": True}
        _RECENT[dedupe_key] = now
        if len(_RECENT) > _MAX_TRACKED:
            for k in sorted(_RECENT, key=lambda k: _RECENT[k])[: _MAX_TRACKED // 2]:
                del _RECENT[k]

    title = f"[{'auto' if body.automatic else 'report'}] {message[:80]}"
    lines = [
        f"**{'Automatically captured' if body.automatic else 'User-submitted'} report**",
        "",
        f"- Book code: `{code or 'n/a'}`",
        f"- Page: {url or 'n/a'}",
        "",
        "**Message**",
        "```",
        message,
        "```",
    ]
    if body.note:
        lines += ["", "**Note from reporter**", body.note]
    if stack:
        lines += ["", "<details><summary>Stack trace</summary>", "", "```", stack[:4000], "```", "</details>"]
    lines += [
        "",
        "---",
        "_No personal data included — any book is identified only by the one-way code above; "
        "nothing here identifies who reported it or what they were reading._",
    ]

    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                f"https://api.github.com/repos/{settings.REPORT_GITHUB_REPO}/issues",
                headers={
                    "Authorization": f"Bearer {settings.REPORT_GITHUB_TOKEN}",
                    "Accept": "application/vnd.github+json",
                },
                json={
                    "title": title[:120],
                    "body": "\n".join(lines),
                    "labels": ["auto-report" if body.automatic else "user-report"],
                },
            )
    except httpx.HTTPError:
        raise HTTPException(502, "Couldn't reach GitHub.")
    if r.status_code not in (200, 201):
        raise HTTPException(502, f"GitHub rejected the report (HTTP {r.status_code}).")
    data = r.json()
    return {"ok": True, "issueUrl": data.get("html_url"), "code": code}
