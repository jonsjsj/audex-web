# Anonymous error reporting — cross-repo standard

Canonical, cross-repo reference for how a client app collects and files a
problem report — a user clicking "Report a problem," or an unhandled crash
being captured automatically — without any identifiable media (a book,
movie, game, whatever the app tracks) or personal data leaving the server.
Kept identical across `jonsjsj/codex`, `jonsjsj/codexaudio`, and
`jonsjsj/audex-web` — when one side changes, update all three copies. See
also `docs/SYNC_API.md`, the sibling standard this one is modeled on.

First implemented in audex-web (`backend/app/api/report.py`) as of 2026-09;
this doc is that implementation written up as a portable spec, not a design
proposal — the algorithm below is the one actually running.

---

## 1. The problem this solves

A report needs enough context to be useful ("this book's chapters are in
the wrong order," "the player crashed on this title") without becoming a
privacy leak: what someone in this house is reading/watching/playing is
exactly the kind of thing that shouldn't end up sitting in a public GitHub
issue tracker forever, tied to an account.

The fix isn't "ask nicely for anonymous reports" — it's structural: the
server computes a **one-way identifier** for whatever media item is
involved, and that's the *only* thing that ever represents it in the
outbound report. Nobody triaging the issue, including the app's own
maintainer reading it on GitHub, can reverse the code back to a title
without the server's own secret key.

## 2. The algorithm — `anon_code()`

```python
import hashlib, hmac

def anon_code(item_id: str, secret_key: str) -> str:
    mac = hmac.new(secret_key.encode(), item_id.encode(), hashlib.sha256).hexdigest()
    return str(int(mac[:12], 16) % 10_000_000_000).zfill(10)
```

- **Input**: the app's own internal identifier for the media item (ABS
  library item id for audex-web/codexaudio; Codex's `media_items.id` or
  `user_entries.id` for Codex — whatever id that app already uses
  internally, never a title/ISBN/external id).
- **Key**: derive a report-specific key from whatever secret-derivation
  convention the app already has, rather than introducing a new one.
  audex-web uses `SECRET_KEY` directly (its `security.py` has no HKDF
  layer yet); Codex should instead go through its existing
  `_derive_fernet_key()`-style HKDF-with-domain-separation pattern in
  `core/security.py`, deriving a report-purpose key rather than reusing
  `SECRET_KEY` raw — that's the more careful precedent already established
  in that codebase, and this standard doesn't require byte-identical key
  derivation across apps, only the same HMAC-SHA256→10-digit algorithm on
  top of it. **Never share this key across apps** — a book
  that exists in both Codex and audex-web will (and should) get two
  *different* codes, one per app. The codes are not meant to correlate
  across apps, only across repeat reports *within* one app.
- **Output**: a 10-digit decimal string (zero-padded), e.g. `0041839275`.
  Ten digits is deliberate: short enough to read aloud or paste into a
  support conversation, ~10 billion possible values (`mod 10_000_000_000`
  of a 48-bit slice of a SHA-256 HMAC) — collision-resistant enough that
  two different books in one library landing on the same code is
  practically a non-issue, without needing the full 64-hex-char HMAC.
- **Stability**: the same item id always produces the same code from the
  same app instance, forever (as long as `SECRET_KEY` doesn't change) — so
  "this keeps happening on the same book" is visible across many reports
  over time, which is the whole point of not just redacting to nothing.

## 3. Scrubbing — where the raw id must never survive

Anonymizing the *shape* of the report (title, author, description fields)
is necessary but not sufficient — the raw item id itself commonly leaks
into places that don't look like "the title field": error messages
("Couldn't load item 3f9a2b1c"), stack traces, and page URLs
(`/play/3f9a2b1c`). The rule: **every raw occurrence of the item id, in
every string field of the outbound report, gets replaced with its
`anon_code()` before the report leaves the process** — not just the
structured "book" field. audex-web's implementation does this as the very
last step before building the GitHub issue body, across `message`, `stack`,
and `url` uniformly, rather than trying to anonymize each field with
field-specific logic.

Free-text a *person* typed (a note field on the manual report form) is
**not** auto-scrubbed — it's presented to the user as "don't include
personal details," a best-effort UI hint, not a guarantee (redacting
arbitrary user-typed prose reliably isn't solvable server-side). Automatic
crash reports never include a free-text field for exactly this reason —
only structured, scrubbed fields (message/stack/url).

## 4. Report shape

Client → server (all fields except `message` optional):

| Field | Meaning |
|---|---|
| `message` | The error text, or a fixed string like `"User-submitted report from Settings"` for manual reports. |
| `note` | Free-typed user text (manual reports only — see §3's caveat). |
| `itemId` | The app's raw internal id for the media item involved, if any. Replaced with its `anon_code()` server-side; never forwarded raw. |
| `stack` | A stack trace (automatic reports). Scrubbed same as `message`. |
| `url` | The page path the report came from. Scrubbed same as `message`. |
| `automatic` | `true` for an unhandled-crash capture, `false`/omitted for a user-clicked report. Gates de-dupe (§5) and the GitHub label. |

Server → client: `{ok, deduped?, issueUrl?, code?}` — `code` is the
`anon_code()` computed, handed back so a UI *could* show "reference
0041839275" to the user for their own records (not required, but harmless
since it's already one-way).

## 5. De-duplication (automatic reports only)

An in-memory map keyed on `(code, sha1(message)[:12])` → last-filed
timestamp, with a 24-hour window: an automatic report for the same error on
the same book (or `"app"` when no item is involved) within 24h of the last
one is silently accepted (`{ok: true, deduped: true}`) without filing a
second GitHub issue. This is **in-process memory, not a DB table** — it
resets on every restart/redeploy. That's an accepted trade-off, not an
oversight: at the scale these apps run at, "don't file 40 duplicate issues
during one bad hour" is the actual goal, and losing the de-dupe window on a
restart costs at most one extra issue, not a functional problem. A DB-backed
version is a reasonable future upgrade if report volume ever justifies it,
but isn't required to meet this standard.

Manual reports (`automatic: false`) are **never** de-duped — a person
clicking "send" expects it to send.

## 6. GitHub issue format

- **Title**: `[auto] <message, truncated to 80 chars>` or `[report] <...>`.
- **Labels**: `auto-report` or `user-report`.
- **Body**: book code, page URL, the message in a fenced block, the user's
  note if present, the stack trace in a collapsed `<details>` block if
  present (capped ~4000 chars), and a closing line stating plainly that no
  personal data is included and any book reference is one-way-coded. Keeping
  that closing line in every report (not just this doc) matters — it's what
  makes the anonymization claim visible/auditable to anyone reading the
  issue later, not just true in the abstract.

## 7. Auth gate, not a public endpoint

The report endpoint requires the caller to be signed in to the app (same
session-cookie gate every other write endpoint uses) — **not** because the
report itself contains anything identifying the person, but because an
unauthenticated report endpoint on a public hostname is an open
GitHub-issue-spam vector. Being signed in only proves "this is a real user
of this install," it is never itself included in the report.

## 8. Configuration keys (same names, every app)

| Key | Meaning |
|---|---|
| `REPORT_GITHUB_TOKEN` | A PAT scoped to `Issues: Read and write` on **only** the one target repo — never a broad `repo`-scope token, regardless of how convenient one already being available is. Blank disables the feature cleanly (`available: false`, no error surfaced to users). |
| `REPORT_GITHUB_REPO` | `owner/repo` to file issues against. Defaults to the app's own repo. |

## 9. Per-app integration notes

- **audex-web**: reference implementation. `backend/app/api/report.py`
  (`anon_code`, `_scrub`, `POST /api/report`, `GET /api/report/available`);
  frontend `components/ErrorBoundary.tsx` (automatic) + a Settings dialog
  (manual) + inline "Report this problem" links on Player/Reader error
  screens (auto-attach that page's `itemId`).
- **Codex**: already has a complete, working, user-facing report system
  predating this standard — `frontend/src/pages/ReportBugPage.jsx` (routed
  at `/report-bug`, a sidebar nav item, not tucked in Settings), `POST
  /bugs` (`backend/app/api/bugs.py`), a `bug_reports` DB table as the
  source of truth, and existing best-effort mirrors to **both** GitHub
  (`BUG_GITHUB_TOKEN`/`BUG_GITHUB_REPO`) and Planka. None of that needs
  rebuilding. What Codex is missing, specifically, is the two things this
  standard actually adds: (1) **automatic** crash capture — there's no
  React error boundary anywhere in that frontend today, reports are 100%
  user-typed; (2) **anonymization** — the existing `context` field sends
  the raw page URL and full user-agent string unscrubbed into GitHub/
  Planka, and there's no media-item reference field on a report at all
  today, so `anon_code()` scrubbing is net-new, not a modification of
  existing redaction (there isn't any). Both slot into the *existing* `POST
  /bugs` endpoint and DB row rather than a parallel system.
- **codexaudio (Android/Kotlin)**: no in-app report UI as of this writing.
  Adopting this standard here at minimum means: if/when one is built, the
  same `anon_code()` algorithm (portable to Kotlin — it's just
  `javax.crypto.Mac` with `HmacSHA256`) keyed on that app's own secret, over
  its own local item id space.
