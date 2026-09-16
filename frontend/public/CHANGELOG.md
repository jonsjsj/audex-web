# Changelog

All notable changes to audex-web are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to
follow [Semantic Versioning](https://semver.org/). Pre-1.0, so the API and
data model may still change between releases. `VERSION` at the repo root is
the source of truth CI stamps every image with; bump it alongside an entry
here whenever there's something worth shipping.

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
