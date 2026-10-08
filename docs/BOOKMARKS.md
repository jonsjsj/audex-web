# Bookmarks — one set for Audex (Android), Webdex (web) and Codex

> Kept identical in `jonsjsj/audex-web` (`docs/BOOKMARKS.md`) and `jonsjsj/codexaudio`
> (`docs/16-bookmarks.md`). Change it in both, or neither.

Every bookmark lives in **Audiobookshelf**, so every app shows the same ones. Each carries **when** it was made
and **where** (which app, on which device).

## Where a bookmark is stored

An Audiobookshelf bookmark is `{libraryItemId, time, title, createdAt}` (`POST /api/me/item/{id}/bookmark`
`{time, title}`; listed in `/api/me` → `bookmarks`; deleted by `time`). `time` is a whole number, identifies the
bookmark within its item, and **must not be 0**.

| The book has | Bookmarks sit on | `time` is |
|---|---|---|
| an audiobook (also when it is a separate, paired audio item) | the **audio** item | seconds: `floor(fraction × duration)` (min 1) |
| no audio at all | the **ebook** item | `round(fraction × 100000)` (min 1) |

`fraction` is how far through the book (0..1). Showing a bookmark in the text: `fraction = time / duration`
(audio) or `time / 100000` (ebook only). An audio bookmark can also jump through the word-sync map for an exact
spot.

Before this was written down, Webdex kept an ebook-only book's bookmarks in its own database (visible to nobody
else) and Audex made none. Webdex moves old ones into Audiobookshelf the next time that book is opened.

## When and where: the title

The time is Audiobookshelf's own `createdAt`. The app and device are appended to the title:

```
<note> [via <app> · <unit>]
```

* `<app>` — `Audex`, `Webdex` (another client may write its own name, or nothing).
* `<unit>` — the device, optional: Audex `Google Pixel 8`; Webdex `Chrome on Linux`.
  `[`, `]` and `·` are not allowed in it (they are replaced by a space).
* Reading: the tag is the trailing `[via …]`; everything before it is the note. A title without a tag came from a
  client that doesn't tag — show it as is, with no origin.
* Show the note, the position, the date/time, and `via <app> · <unit>`; never the raw tag.
* Regex (both apps): `\s*\[via ([^\]·]+?)(?:\s*·\s*([^\]]+?))?\s*\]\s*$`

Notes: a reading bookmark is `Bookmark · 42%`; the automatic "you were here" marker dropped before a big jump
(more than 1.5 % of the book) is `Left off · 42%` — the `Left off · ` prefix marks it (at most the latest 5 are
kept). Both apps write and prune these the same way.

## Tests

Both repos test the same cases: tagging (with/without device), parsing an untagged title, tagging twice not
stacking, brackets in a device name, the `Left off · ` prefix surviving, and the ebook-only scale never giving 0.
