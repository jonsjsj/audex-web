# Changelog

All notable changes to audex-web are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to
follow [Semantic Versioning](https://semver.org/). Pre-1.0, so the API and
data model may still change between releases. `VERSION` at the repo root is
the source of truth CI stamps every image with; bump it alongside an entry
here whenever there's something worth shipping.

## [0.4.4] - 2026-09-17

### Fixed
- **The Reader still crashed on every book with no saved reading position**
  ("Cannot read properties of undefined (reading 'locations')"), even after
  0.3.1's fix — that fix guarded our own code, but the actual crash was in
  `@readium/navigator` itself. Our EPUB manifest never advertised a Readium
  "position-list" link, so the navigator's own position list was always
  empty; its internal fallback (`this.positions[0]` when no initial locator
  is given) landed on `undefined` and crashed reading `.locations` off it —
  which is exactly what happens opening any book you haven't started yet.
  The reader now builds one locator per chapter itself whenever the
  manifest doesn't supply a position list, so the navigator always has
  something to fall back to.

## [0.4.3] - 2026-09-17

### Added
- **Playback now survives navigation.** Audio used to live and die with the
  Player page — clicking anywhere else stopped it. All playback state and
  the `<audio>` element now live above the router, so it keeps playing while
  you browse Library, Series, Authors, Narrators, or Settings.
- **Mini-player** — docked bottom-right on every page except the full Player
  view while something's playing: cover, title, author, play/pause, stop,
  and a progress bar. Tap it to jump back into the full player.
- Author, series, and narrator on the Player page are now clickable, same as
  on a book's detail page.

### Changed
- Bookmark titles now record when and on what they were made — e.g.
  "webaudex win 11 21.42 19.09" — instead of the audio position, which is
  already shown separately in the bookmark list.

## [0.4.2] - 2026-09-17

### Fixed
- **Self-update now actually swaps the container.** The updater's helper uses
  the `curlimages/curl` image, which runs as a non-root user (UID 100) that
  can't open the Docker socket (`root:docker`, mode 660) — so every Docker API
  call from the helper failed. The old `curl -s` hid this (the button silently
  did nothing); 0.4.1's error reporting surfaced it as "Update failed while
  trying to stop." The helper now runs as root (same privilege the app
  container already uses for the socket), so the stop/remove/recreate/start
  sequence completes.

## [0.4.1] - 2026-09-17

### Fixed
- **The self-update button could silently do nothing.** The new image was
  pulled inside a fire-and-forget helper with `curl -s`, which swallowed any
  pull error (private/renamed GHCR package, wrong tag, no network) — the button
  reported "Update started" and then nothing changed, with no way to tell why.
  Now the image is pulled **in-process before the swap**, so a failed pull is
  reported on the Settings page with the actual reason; the recreate helper runs
  each step with `curl -f` and records exactly which step failed; and the page
  polls after the swap and shows **"Updated to vX"** or the failing step instead
  of guessing. A wrong `UPDATE_CONTAINER_NAME` now returns a clear message too.

## [0.4.0] - 2026-09-17

### Added
- **Connect multiple Audiobookshelf servers.** Settings → "Audiobookshelf
  servers" adds any number of servers beyond the deploy-configured one, each
  with its own sign-in; the Library, Series, Authors and Narrators views then
  combine every server into one catalog (the "All libraries" default), the way
  the mobile app syncs every enabled server. The library picker can still
  narrow to a single server's library. Item/library ids from extra servers are
  namespaced internally so nothing collides; the primary server's ids and
  behaviour are unchanged.
- **Settings About panel**: the running build's release date ("last updated")
  next to its version, this version's notes, the next release's name + notes
  when an update is available, and an "Expand to full changelog" view.

### Changed
- **Codex sync** no longer leads with a paragraph — the default view is just a
  "Connected" status, with the explanation behind an ⓘ toggle.

## [0.3.2] - 2026-09-17

### Fixed
- **The library came up empty.** Two causes, both the same root: `hasEbook` was
  derived from `media.ebookFile`, which the Audiobookshelf *list* endpoint
  doesn't include (only the expanded single-item detail does). So every book
  looked audio-only — the "Audio + ebook" filter (the previous default) matched
  nothing, ebook icons never lit, and the read-along eligibility scan found
  nothing. `hasEbook` now keys off `media.ebookFormat`, which is present on the
  list response too, matching the mobile app's own detection.
- **Book detail always show both actions.** With ebook detection fixed, a book
  that has both formats now shows both **Listen** and **Read**, however you
  opened it (grid card → detail, or the player/reader's own cross-format jump).
- **Narrators showed "No narrators found."** `/narrators` only read the
  structured `narrators` array, which the list endpoint can omit in favour of
  the flat `narratorName` string — the same shape caveat Series and Authors
  already handled. Added the `narratorName` fallback.

### Added
- **Multiple libraries, combined.** The library, series, authors and narrators
  views now default to **All libraries** — one merged catalog across every book
  library on the server, the way the mobile app syncs. A per-library picker is
  still there when you have more than one.
- **A persistent search bar.** Search now lives in the shell above every browse
  page (Library / Series / Authors / Narrators) and filters each, instead of
  only existing on the Library page.
- An **Unread** quick filter (books you own but haven't started).
- Clicking the **Audex** wordmark returns to the start — Library, All libraries,
  search cleared, sort/filter back to defaults.

### Changed
- The library format filter now defaults to **"All formats"** again (see the fix
  above for why "Audio + ebook" was showing nothing).

## [0.3.1] - 2026-09-16

### Fixed
- **The Reader crashed on every book open** ("Cannot read properties of
  undefined (reading 'locations')"). The `positionChanged` listener reads a
  `nav` closure variable that isn't assigned until `new EpubNavigator(...)`
  returns — if the navigator fires that event synchronously during its own
  construction (which it does), `nav` was still `null` and the event's own
  `locator` argument can also be undefined on that first firing, so the
  fallback chain landed on `undefined` and the very next line dereferenced
  `.locations` on it. All four `.locations` access points in Reader.tsx are
  now guarded.

### Changed
- The library format filter now defaults to **"Audio + ebook"** instead of
  "All formats".

## [0.3.0] - 2026-09-16

### Added
- **Narrators** — a third browsing section alongside Series/Authors ("like
  the author": grid/list toggle, click a name for all their works). ABS has
  no Narrator entity, so no photo/bio is possible there — initials only.
- **Author bios** on the Author detail page, fetched from Audiobookshelf's
  own author record.
- **"Audio + ebook" library filter**, alongside the existing format/progress
  ones — the books eligible for read-along in one place.
- **Read-along status on library cards**: the mobile app's own 3-icon row
  (headphones/book/"W"), plus a small badge to request a build straight
  from the card for a dual-format book that doesn't have one yet.
- **Real update-check**: Settings' "Update now" only appears when there's
  an actual newer `VERSION` on the repo, with that version number and its
  changelog entry shown underneath — previously the button was always
  clickable whenever self-update was technically wired up, regardless of
  whether there was anything to update to.

### Fixed
- Authors still fell back to a book cover when Audiobookshelf had no
  headshot on file for them — direct regression against the "never a book
  cover for a person" fix from 0.2.0 (the fallback logic was shared with
  series tiles, which SHOULD show a cover, and wasn't gated by which kind
  of tile it was). Authors/narrators now show initials in that case, never
  a cover, full stop.

## [0.2.0] - 2026-09-16

### Added
- **Read-along, phase 2**: automatic cross-format carryover — opening the
  Player when you've read further than you've listened (or vice versa)
  silently resumes at the mapped position instead of requiring the manual
  "Jump to text/audio" button from phase 1.
- **Series, Authors, and a book-info page** — grouped from the library's own
  items (not a Hardcover-style fill-in of unowned volumes), each with a
  Grid/List view toggle. The book-info page shows description, narrator,
  publisher, published year, genres, ISBN/ASIN, chapters, and a clickable
  author/series line, plus "Next in series."
- **Library sorting and filtering** (title/author/recently added/duration/
  progress; all formats/audiobook/ebook/in progress).
- **Persistent sidebar** — Library/Series/Authors/Settings/Player/Reader all
  live inside one shell now instead of Settings/Player/Reader being
  standalone full-bleed pages.
- **SSO** via Authentik (OIDC), alongside the existing Audiobookshelf-
  credential sign-in.
- **Self-update** (Settings → "Update now") — pulls the latest GHCR image
  and swaps the running container in place, via a short-lived helper
  container so the app doesn't need to survive stopping itself mid-update.
- **Anonymous problem reports** (Settings → "Report a problem," plus
  automatic crash capture) — filed as GitHub issues; any book involved is
  identified only by a one-way 10-digit code, never its title. See
  `docs/ERROR_REPORTING.md`.
- CI now builds and publishes `ghcr.io/jonsjsj/audex-web` on every push to
  `main`, tagged `latest` + the `VERSION` file's version + the commit sha.

### Changed
- **Player redesigned** to match the native Android Audex app's own player
  screen: full-bleed cover hero with a scrim, scrubber with bookmark dots +
  a decorative waveform, a single filled transport button, a 4-cell utility
  strip (Speed/Sleep/Bookmark/Go To), and Chapters/Bookmarks tabs instead of
  both lists always stacked. New Go To dialog folds in "jump to where
  you're reading"; new Add Bookmark dialog; bookmark removal is now a
  two-tap "Remove" → "Remove?" instead of one click.
- Player/Reader now offer a plain "Read this book"/"Listen to this book"
  link immediately for a same-item book with both formats, rather than only
  once a read-along map exists.
- Settings no longer centers itself as a narrow floating card — sits flush
  against the sidebar like every other page.

### Fixed
- `/api/library/series` always returned empty on some Audiobookshelf
  configs — the list endpoint doesn't always return the structured series
  array `_book_summary` already had a fallback for; `/series` didn't.
- Author tiles showed a stacked-book-cover effect that visually overlapped
  the name label below it at small sizes. Replaced with a single poster
  image; authors now show a real ABS headshot when one exists, or an
  initials avatar — never a book cover standing in for a person.

## [0.1.0] - 2026-09-15

Initial phases: sign-in (SSO scaffold + Audiobookshelf credentials), the
audio player (streaming, chapters, speed, sleep timer, resume, OS media
controls, bookmarks), the ebook reader (in-house EPUB parser feeding
`@readium/navigator`, font size + position sync to ABS), Codex progress
sync, and read-along phase 1 (manual cross-format jump).
