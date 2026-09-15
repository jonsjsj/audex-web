# Codex / Audex sync & read-along API reference

Canonical, cross-repo reference for how a client (mobile Audex, audex-web, or
anything else) talks to **Audiobookshelf** for progress, to **Codex** for
cross-device sync, and to **audex-align** for word-sync read-along. Kept
identical across `jonsjsj/codex`, `jonsjsj/codexaudio`, and `jonsjsj/audex-web`
— when one side of an integration changes, update all three copies.

This documents the APIs as they actually work in the deployed services, verified
against the real source (not the original design docs, which drifted from it in
places) as of 2026-09.

---

## 1. Audiobookshelf (ABS) — the source of truth for library + progress

All calls: `Authorization: Bearer <token>` — either a real ABS session token
(from `POST /login`) or a raw ABS API key work identically; ABS validates both
the same way.

### Reading/listening position

| Call | Purpose |
|---|---|
| `GET /api/me/progress/{libraryItemId}` | The saved `MediaProgress` record for one item, or 404 if never opened. Convenience lookup **by library item id**. |
| `PATCH /api/me/progress/{libraryItemId}` | Update `ebookLocation` (opaque epubcfi/page string) + `ebookProgress` (0..1). **This is the sanctioned channel for EBOOK position — never for audio.** |
| `DELETE /api/me/progress/{recordId}` | Clear a progress record. **Keyed on the record's own `id` field (from the GET above), NOT the libraryItemId** — deleting by libraryItemId 404s. This is the *only* reliable way to clear a stuck/wrong position; a PATCH to zero does **not** reliably stick (ABS can keep the old `currentTime`/`isFinished` regardless of what you PATCH). |

### Audio position — sessions, not PATCH

Audio position goes through ABS's session API, never `PATCH /api/me/progress`:

1. `POST /api/items/{id}/play` → opens a session, returns the resume
   `currentTime` ABS already computed, the audio track list (each with a
   `contentUrl` you replay verbatim, e.g. `/api/items/<id>/file/<ino>`), and
   chapters.
2. `POST /api/session/{sessionId}/sync` → periodic position update while
   playing: `{currentTime, timeListened, duration}`.
3. `POST /api/session/{sessionId}/close` → same body, on pause/stop/unload.

### Ebook file / any file

There's no dedicated "download ebook" endpoint — audio tracks and ebook files
are both served the same generic way, by the file's `ino` (from the item's
expanded metadata, `media.ebookFile.ino` / `media.audioFiles[].ino`):

```
GET /api/items/{itemId}/file/{ino}
```

### Bookmarks

`GET /api/me` returns a flat `bookmarks: [{libraryItemId, time, title,
createdAt}]` array on the user record — same place `mediaProgress` lives. Time
is whole seconds (integer).

> **Confidence note**: the write endpoints below were inferred from ABS's
> established `/api/me/item/{id}/...` naming convention, not independently
> re-verified against a live server as of this writing — treat as
> probably-but-not-certainly correct:
> `POST /api/me/item/{id}/bookmark {time, title}` (create),
> `DELETE /api/me/item/{id}/bookmark/{time}` (delete).

### `isFinished` threshold

No client marks a book finished only at *exactly* 100% — the tail is
acknowledgements/credits you'd rarely land on precisely. The convention used
throughout: `finished = duration != null && currentTime >= duration - 1.0`
(within the last second).

---

## 2. Codex — cross-device sync hub

### Pushing progress to Codex (webhook)

Any client can push a live progress update to Codex immediately (instead of
waiting for Codex's own periodic ABS poll, default every 5 minutes):

```
POST {codexUrl}/webhooks/abs?token=<codex-api-key>
Content-Type: application/json

{
  "event": "user_mediaProgressUpdated",
  "data": {
    "progress": {
      "libraryItemId": "<abs-library-item-id>",
      "currentTime": 1234.5,
      "isFinished": false
    }
  }
}
```

- `token` is a **real Codex API key** (Codex → Settings → API Keys →
  Generate), sent as a query param, not a header. Codex validates it the same
  way a normal `Authorization: Bearer` session token is validated — the two
  are interchangeable for anything gated by Codex's own `get_current_user`.
- **This key is per-person, never shared/server-wide.** A single token used
  by multiple people attributes everyone's progress to whichever one Codex
  account it belongs to — this is a real bug class Codex's own ABS sync hit
  in production (a "household fold" that let one account's stale
  `isFinished` silently overwrite a different person's correct progress) and
  had to be fixed by scoping every sync strictly to the connection's own
  `/api/me`, never `/api/users`. Don't reintroduce the shared-token version
  of the same mistake at the client-integration layer.
- Best-effort / fire-and-forget: a Codex outage must never disrupt playback.
  Swallow the response, don't retry, don't block on it.
- Ebook progress is **not** pushed here — no client does this. Reading
  position already goes straight to ABS (§1), and Codex's own periodic ABS
  sync picks it up from there on its normal interval. The webhook is
  audio-only.

### Verifying a Codex API key

`GET {codexUrl}/api/auth/me` with the key as `Authorization: Bearer` — 200 if
valid. Useful to validate a pasted key before saving it, rather than
discovering it's wrong on the first silent-failed push.

### Codex's own cross-edition reconciliation (background, for context)

Codex tracks each ABS/Goodreads/Kavita "edition" of a work as a separate
`MediaItem`, grouped by a dupe-key (same series+position, or same normalized
title+author). `sync_book_positions()` picks the edition with the furthest
progress as the "winner" and propagates that position to the others —
**including pushing it back out to their own source services**. Two
correctness rules this depends on, learned the hard way:

1. `_edition_fraction()` treats a `completed` status as an unconditional
   `1.0` — so a `completed` status must stay **revisable**. If nothing ever
   downgrades it when the source stops reporting it finished, that edition
   becomes a permanent "furthest" winner that keeps re-pushing 100% onto
   every sibling forever, regardless of what any client does. `sync_abs()`
   downgrades `completed` → `reading`/`in_library` when ABS no longer
   reports the item finished, but **only when the completion was itself
   ABS-sourced** (checked via the entry's own history) — never for a
   manual/Goodreads-sourced completion, which ABS has no business revising.
2. **Never fold multiple people's progress together.** Codex's `/api/users`
   admin endpoint can list every ABS account's `mediaProgress`, which is
   tempting to use for "always show the furthest progress across the
   household" — don't. It's how one unused/stale account silently
   overwrote a different person's real progress, repeatedly, since every
   sync re-derived "furthest" from the same stuck value. Each connection
   syncs strictly its own `/api/me`.

---

## 3. audex-align — forced-alignment (word-sync read-along)

Transcribes the audiobook, aligns it against the EPUB's text, and serves a
per-book timing map: audio-seconds ↔ book-char-range. One-time, server-side,
per book — not something a client computes.

### Reaching it: through Codex, not directly

**Prefer routing through Codex** rather than talking to the align service
directly — it's a private LAN box; Codex's gateway makes it reachable off-LAN
and lets clients address books by their **ABS item id** without ever knowing
the align service's own book-key scheme:

```
GET  {codexUrl}/audex/align/health
GET  {codexUrl}/audex/align/map/{absItemId}       → the map JSON, or 404
GET  {codexUrl}/audex/align/status/{absItemId}    → {configured, available, state, progress, eta_seconds}
POST {codexUrl}/audex/align/build/{absItemId}     → kick off a build; body: {ebook_item_id?}
```

**These routes are PUBLIC — no Codex auth token required.** Codex fetches the
book itself using its own stored ABS connection (any enabled one; the
caller's own connection is preferred if it can be identified, but isn't
required). This exists specifically so a client with only a Codex *URL*
configured (no login) can still use read-along.

`status`'s `state` is one of the align service's own coarse phases (`queued`,
`downloading`, `extracting`, `transcribing`, `aligning`, `done`, `error`);
`progress`/`eta_seconds` are best-effort estimates Codex derives from phase +
elapsed time + the audiobook's duration — the align service itself doesn't
report a percentage, only phases (transcription is real per-chunk progress
when available).

### Talking to the align service directly (fallback, same-LAN only)

```
POST /jobs/abs        {serverUrl, token, libraryItemId, ebookLibraryItemId?}  → {jobId, bookKey}
GET  /jobs/{jobId}     → {state, bookKey, createdAt, detail, entries?}
GET  /maps/{bookKey}   → the map JSON, or 404
GET  /health           → {ok, device, model, compute, maps, jobs: {id: state}}
POST /batch            {serverUrl, token, items: [{audioItemId, ebookItemId?}]}  — bulk, resumable across restarts
GET  /batch            → progress of the registered batch
```

`bookKey = sha1(f"{serverUrl}|{libraryItemId}")[:16]` — **must be computed
from the exact same `serverUrl` string** the align service (or Codex, on its
behalf) used when building the map, or the same book resolves to a different
key and looks unaligned. This is precisely why the Codex gateway is
preferred: it computes the key from *its own* stored connection, so a client
never needs to match Codex's server-URL string byte-for-byte — it only ever
needs the ABS item id.

### The map format

```jsonc
{
  "version": 1,
  "model": "small",
  "device": "cpu",
  "durationS": 53677.17,
  "totalChars": 812345,
  "chapters": [
    { "href": "OEBPS/chapter1.xhtml", "c0": 0, "c1": 8213 },
    // ...one per spine document, in reading order
  ],
  "entries": [
    {
      "t0": 12.34,        // audio seconds this sentence starts being narrated
      "t1": 15.02,        // audio seconds it ends
      "c0": 401,          // char offset of the sentence in the flattened book text (see below)
      "c1": 512,
      "p": 0.000634,      // progression through the WHOLE book, 0..1 (c0 / totalChars)
      "href": "OEBPS/chapter1.xhtml",
      "text": "The first line of the sentence…",   // truncated to 600 chars
      "words": [[0, 12.34], [4, 12.51], [11, 12.9]] // [char-offset-WITHIN-sentence, audio-second], one per word
    }
    // one entry per SENTENCE, not per word — the reader follows the page
    // sentence-by-sentence and moves a highlight word-by-word using `words`
  ]
}
```

Anchors are sentence-level (not per-word) because per-word ASR timestamps are
too slow to produce at scale (would ~triple transcription time on CPU); words
within a sentence get their timing by interpolating between the dense
sentence-level anchors, which is accurate enough for a moving highlight.
Front/back matter with no spoken counterpart (cover, TOC, copyright page) is
excluded — only sentences within the aligned span get an anchor.

### Reproducing the flattened-text char-offset scheme

**This is the part most likely to bite a new implementation.** `c0`/`c1`
index into a single flattened string built from the EPUB, not into any one
XHTML file's raw markup — a renderer that wants to turn a char range into a
DOM selection/highlight has to reproduce the *exact* same flattening, or the
offsets land in the wrong place. The algorithm (`alignment-service/app/epub_text.py`):

1. Walk the EPUB **spine, in order** (reading order — not the manifest order).
2. For each spine document: parse as HTML, remove `<script>`, `<style>`, and
   `<nav>` elements, then take `text_content()` — the concatenation of every
   remaining text node, in document order, with **no** separator inserted at
   element boundaries (so `<p>Hello</p><p>World</p>` with no whitespace
   between the tags in the source becomes `"HelloWorld"`, not `"Hello
   World"` — whitespace only survives where it existed in the source, e.g. a
   newline between sibling tags).
3. Collapse all whitespace runs (spaces, tabs, newlines) to a single space,
   then strip the ends.
4. Each document's cleaned text is one "part"; join all parts with a single
   space between them (`" ".join(parts)`). Record each document's
   `[char_start, char_end)` range in this joined string as it goes — that's
   the `chapters` array.

A client that only needs the **coarse position** (which chapter, roughly
where in it) doesn't need to reproduce this exactly — `p` (whole-book
progression) and the `chapters` ranges are usually enough to scroll/seek
close. A client that wants **precise sentence/word highlighting** inside the
real rendered DOM does need to either reproduce this text-flattening per
resource (then map the resulting char offset to a DOM Range by walking the
same text nodes), or use `entries[].text` for a fuzzy text-search match
against the rendered page instead of trusting raw offsets blindly (more
robust to minor extraction differences, at some cost in precision).

### Client integration pattern (what a reader should actually do)

Mirrors `codexaudio`'s `AlignmentRepository` interface:

1. **Availability**: read-along needs both an audio *and* an ebook edition of
   the same work, and either a Codex URL (preferred) or a direct align
   service URL configured. Hide the feature entirely otherwise.
2. **Status**: poll `GET .../status/{itemId}` while a build might be running;
   show phase + estimated progress/ETA.
3. **Build**: `POST .../build/{itemId}` once, idempotent — a second call
   while one's already running/done just reports the existing job/map rather
   than enqueuing a duplicate.
4. **Map**: `GET .../map/{itemId}` once available; cache it (client-side —
   it's static per book, and large books produce large maps). Binary-search
   `entries` by `t0` to find "what's being narrated at audio second N", or by
   `p`/`c0` to find "what audio second corresponds to reading position N" —
   both directions are needed (audio→text for highlighting while listening,
   text→audio for "jump to audio" from wherever you're reading).
5. Cross-format position: **furthest-progress-wins** between the two
   editions of the same work, same principle as Codex's own cross-edition
   sync (§2) — don't let the map turn into a second, competing source of
   truth for "where you are"; it's a *lookup table* between two already-
   synced positions, not a third position store.
