# Changelog

All notable changes to audex-web are recorded here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to
follow [Semantic Versioning](https://semver.org/). Pre-1.0, so the API and
data model may still change between releases. `VERSION` at the repo root is
the source of truth CI stamps every image with; bump it alongside an entry
here whenever there's something worth shipping.

## [Unreleased]

### Added
- **Codex's checked metadata.** Audiobookshelf's metadata is often wrong and gets fixed in Codex. With
  `CODEX_URL` set, the library, series, authors, narrators, search, detail page and now-playing data use
  Codex's author / narrator / series + position / year / description whenever Codex has one (else
  Audiobookshelf's) — so a book Codex moved into a series groups and sorts there. Fetched in batches of 200 via
  Codex's `/audex/meta`, cached for 5 minutes, and any Codex problem (down, slow, older version) silently falls
  back to Audiobookshelf. A hand-picked Codex cover replaces the cover; enriched covers don't.
- **Settings → Codex sync → "Use Codex's metadata"** (per person, on by default).
- **A fix made here reaches Codex too.** Editing a book's title / authors / narrators / series now also sends the
  change to Codex with the person's own linked API key, so Codex (the source of truth) records it and its
  periodic Audiobookshelf correction doesn't undo it. If Codex isn't linked the page says so.
- Docs: `docs/SYNC_API.md` documents `/audex/meta` and the client rule (kept identical across the three repos).
- Tests: `backend/tests` (`python -m unittest discover -s tests`).

## [0.6.0] - 2026-10-06

### Fixed
- **An ebook and its audiobook showed up as two separate cards.** Matching
  compared only the *first-listed* author and a fuzzy whole-title score, so
  "Deverell, Travis, Shirtaloon" vs "Shirtaloon, Travis Deverell" or a title with
  an extra subtitle never matched — while near-misses like *Dune* / *Dune
  Messiah* or *Monsters 12* / *13* could. Matching now compares every author's
  name words, the title part by part (so a longer or shorter subtitle is fine),
  the volume number, and the series position; a Kindle-vs-Audible ASIN mismatch
  no longer blocks a pair. A matched pair is shown as **one book** everywhere
  (library, series, authors, narrators), with both Listen and Read.
- **Progress now carries across the two editions.** The book page, Player and
  Reader see the other edition's saved position, so a book you've listened to
  60% of opens in the Reader at ~60% (exactly, via the read-along map when one
  exists, otherwise by percentage) instead of page one, and vice versa.
- Browser tab title is now "Webdex".
- **A+ / A- never changed the text size.** Readium's font-size setting is a
  multiplier (1 = 100%, valid range 0.7–4), but the Reader handed it the
  percentage (`100`, `112.5`, `175`…); Readium silently drops an out-of-range
  value, so the buttons did nothing. The stored percentage is now converted.
- **The page-turn arrows couldn't be clicked.** The book's frame was sized
  wider than its container and spilled over the right-hand arrow, swallowing
  the click. It's now contained.
- **Reading progress only moved a chapter at a time.** The Reader's position
  list has one entry per chapter, so a book with a few long chapters sat on
  one percentage for hours — which is also all Audiobookshelf (and so Codex)
  was ever told. Progress is now worked out from where you are *inside* the
  chapter (the server sends each chapter's text length with the manifest), so
  the percentage moves page by page and that finer number is what's saved as
  `ebookProgress`.
- **"Request alignment" never showed the result.** After pressing it the page
  said "Building…" forever, because nothing checked on the job again — you only
  saw it finish after a reload. It now watches the job through to the end.
- **A failed alignment said nothing about why.** The alignment service reports
  which phase failed, what happened and what to do about it; the server dropped
  all of that. It's passed through and shown, with a Try again button.
- **Opening a book now resumes at the right place when the saved position came
  from another app.** The Audex app and Codex store their own location format,
  which the web reader can't open — it used to start at page one even though
  the saved percentage was, say, 50%. It now resumes at that percentage.

### Added
- **Edit details (on the book page).** Fix a book's title, subtitle, authors,
  narrators, series, ASIN or ISBN and it's saved **to Audiobookshelf itself**, so
  Audex and Codex see the correction too. A tick-box applies it to the other
  edition as well; giving both editions the same ASIN/ISBN keeps them one book.
- **Merge with another edition (book page).** When Audiobookshelf holds an
  ebook and its audiobook as two items and the automatic matching can't tell,
  pick the other one: its title, authors and series are set to match, and an
  ASIN/ISBN either side has is shared — all **in Audiobookshelf**, so Audex,
  Codex and Webdex (which each match from that same metadata) merge them too.
- **Hide the side menu.** A button next to the Audex logo collapses the side
  menu on every page (and a small ☰ brings it back); it remembers your choice.
- **One page / two pages.** A switch in the Reader header chooses single-page
  or two-page-spread layout (remembered per device).
- **Keyboard paging:** ← → and PageUp / PageDown, plus **Space** (forward) and
  **Shift+Space** (back). These work while focus is inside the book itself, not
  just on the page around it.
- **A bottom bar that appears when you mouse over the bottom of the Reader**
  with a progress slider you can drag or click to jump anywhere in the book,
  a **Chapters** list (current chapter highlighted) built from the book's table
  of contents, **Bookmarks**, and **Read-along**.
- **Bookmarks**, stored the way the Audex app stores them. A book with an
  audiobook edition (its own, or a paired one) keeps them in Audiobookshelf as
  a point in the audio — so they show up in the Audex app too, and the other
  way round. A book with no audiobook has no audio to hang one on, so those are
  kept by audex-web itself (on this server only; the panel says so). Add one
  with the **＋ Bookmark** button or the **B** key; tick marks on the slider show
  where they are. Jumping more than ~1.5% of the book with the slider, a chapter
  or a bookmark also drops an automatic **"Left off"** marker at the place you
  left (the newest five are kept), so an accidental jump never loses your spot.
- **Read-along in the Reader.** A Read-along button shows whether the book is
  aligned, and lets you **request alignment** with live progress (phase, percent,
  time left) and — if it fails — what went wrong and what to try. Once aligned,
  **"Follow the audiobook while it plays"** turns the page to keep up with the
  narration; turning a page yourself pauses that for a few seconds, and it can be
  switched off. (It follows by page — it doesn't highlight the sentence being
  read yet.)
- The chapter name in the Reader's header now comes from the book's table of
  contents, so it stays correct after a jump; and the "resumed from your
  listening progress" message is a brief overlay instead of a line that resized
  the book when it appeared.

## [0.5.3] - 2026-10-06

### Added
- **Full-screen reading.** A new button in the Reader header (or press **F**)
  hides the side navigation, the mobile menu button and the mini-player so the
  book gets the whole window, and also asks the browser for real fullscreen to
  hide its own toolbars. **Esc** (or the same button) brings everything back.
  Browsers that refuse fullscreen (iPhone Safari, notably) still get the
  in-app layout with the library hidden. Leaving the Reader always restores
  the normal layout.

## [0.5.2] - 2026-09-22

### Fixed
- **Local (Audiobookshelf username/password) login didn't persist when
  reached over the direct LAN IP** (http://\<host\>:8420) — the login call
  itself succeeded, but the session cookie was marked Secure (needed for
  the public HTTPS domain) and browsers silently drop Secure cookies over
  plain HTTP, so you'd land right back at the sign-in screen. The cookie
  now decides Secure per-request from the scheme actually used, so both
  the HTTPS domain and the plain-HTTP LAN address work.

## [0.5.1] - 2026-09-18

### Fixed
- The Library's "Audio + ebook" filter didn't count cross-item pairs (0.5.0)
  — a paired book showed both format icons on its card but still never
  matched this filter.

## [0.5.0] - 2026-09-18

### Added
- **Cross-item format pairing.** Audiobookshelf sometimes catalogs a book's
  audiobook and ebook as two separate library items instead of one with
  both files — previously each showed only its own format, with no way to
  toggle and inconsistent icons. Now matched using the same identity
  cascade proven in the Audex mobile app's catalog engine (ASIN → ISBN-13
  → fuzzy title+author), so a book split like this gets a real Listen/Read
  toggle, matching format icons on both library cards, and a shared
  read-along/word-align build between the two.

### Known limits
- Listening/reading progress still only reflects the item you're currently
  on — a book you've made progress on via its paired edition may show
  "Listen"/"Read" instead of "Resume listening"/"Resume reading".

## [0.4.7] - 2026-09-17

### Added
- **Sorting on Series, Authors, and Narrators** — previously always
  alphabetical with no way to change it. Series: Latest release / Name /
  Author. Authors/Narrators: Name / Latest release / Most books. Persists
  per page, like the existing grid/list toggle.
- **Library sort gained "Release date"**, alongside the existing
  Title/Author/Recently added/Duration/Progress options.

### Changed
- **Switching between listening and reading is now a primary, always-visible
  button** — a "Read" pill on the Player and a "Listen" button in the
  Reader header — instead of a small link buried below the transport
  controls that was easy to miss.

## [0.4.6] - 2026-09-17

### Fixed
- **Reader chapters rendered unstyled**, with the console showing "Refused
  to apply style ... MIME type ('text/html')" for stylesheet.css and
  page_styles.css. The manifest's `self` link (fixed for CSP in 0.4.5)
  pointed one directory too high — chapter text loads through a separately
  configured path and was unaffected, but each chapter's own relative
  references (stylesheets, images) resolve against that `self` link's
  stripped base, so they landed outside where resources are actually
  served and silently caught the SPA's catch-all page instead. Now points
  inside the resource route so both resolve to the same root.

## [0.4.5] - 2026-09-17

### Fixed
- **The Reader loaded chapter content but never showed it** — stuck on
  "Loading…" forever, right after the 0.4.4 crash fix. Our EPUB manifest's
  `self` link was a bare path (`/api/read/{id}/manifest`), not an absolute
  URL; `@readium/navigator` feeds that straight into each reading iframe's
  Content-Security-Policy as an allowed domain, and a relative value isn't
  valid there — the browser silently drops it, which starves the policy
  down to `blob:`/inline-only and leaves every chapter frame unable to
  reveal itself. The manifest endpoint now returns a proper absolute URL.
  This was very likely broken for every book, not just freshly-opened
  ones — the 0.4.4 crash just meant nobody got far enough to hit it.

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
