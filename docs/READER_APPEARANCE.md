# Reader appearance — one model for Audex (Android) and Webdex (web)

> Kept identical in `jonsjsj/audex-web` (`docs/READER_APPEARANCE.md`) and `jonsjsj/codexaudio`
> (`docs/15-reader-appearance.md`). Change it in both, or neither. If the two apps disagree with this
> file, the apps are wrong.

The ebook reader looks and behaves the same in both apps: the same controls, the same defaults, the
same colours. Each app stores the choice itself (Webdex per person on the server, so every browser
agrees; Audex on the device).

## The model

| Field | Values | Default |
|---|---|---|
| `fontSizePt` | whole points, **9–48** | **12** (the book's normal size) |
| `theme` | `auto` · `light` · `sepia` · `dark` · `custom` | **`auto`** |
| `font` | `publisher` · `serif` · `sans` · `mono` | `publisher` (the book's own font) |
| `textColor` | `#RRGGBB` — used only when `theme = custom` | `#1a1a1a` |
| `backgroundColor` | `#RRGGBB` — used only when `theme = custom` | `#ffffff` |

### Text size
* Points, like a word processor: a **number box you can type into** (any whole size 9–48) plus the
  usual list of sizes, and **A−/A+** that step along that list:
  `9 10 11 12 13 14 15 16 18 20 22 24 28 32 36 40 44 48`.
  From a size between two rungs, A+ goes to the next rung up and A− to the next rung down.
* **Normal** resets to 12 pt. 12 pt is exactly the book's own size (Readium multiplier `1.0`).
* Readium's `fontSize` is a multiplier: `multiplier = fontSizePt / 12` (so 9 pt = 0.75, 48 pt = 4.0 —
  the toolkit's valid range is 0.7–4).
* No percentages anywhere in the UI.

### Colours
* **`auto` follows the device's light/dark setting**, live (the book re-colours when the device
  switches). This is the default — the page is no longer always white.
* Presets (always sent to Readium as explicit colours, never as Readium's own theme enum, so both apps
  render identical colours):

  | Theme | Text | Background |
  |---|---|---|
  | light | `#1a1a1a` | `#ffffff` |
  | sepia | `#433422` | `#f4ecd8` |
  | dark  | `#e4e4e4` | `#121212` |

  `auto` = `dark` when the device is in dark mode, otherwise `light`.
* **Custom**: pick the text colour and the background colour yourself. Choosing *Custom* starts from the
  colours currently shown; changing either colour switches to Custom.

### Font
`publisher` leaves the book's font alone; `serif` / `sans` / `mono` set the CSS generic family
`serif` / `sans-serif` / `monospace`.

## Controls (both apps)
* **A− / A+** always reachable while reading; an **Appearance** panel holds: font size (number box + list +
  A−/A+ + *Normal*), font, theme chips (*Auto (device), Light, Sepia, Dark, Custom*), the two colour pickers
  with a live sample, and *Reset to defaults*.
* A change applies to the open book immediately and is saved a moment later.

## Persistence and migration
* **Webdex** — `GET/PUT /api/settings` field `readerAppearance` (object above). The server validates and
  clamps everything. Older saves held a percent (`fontSize`, 100 = normal); it converts as
  `pt = round(percent × 12 / 100)`.
* **Audex** — DataStore keys `reader_font_pt`, `reader_theme2`, `reader_font`, `reader_text_color`,
  `reader_bg_color`. Migration from the old keys: `reader_font_pct` → `pt = round(pct × 12 / 100)`;
  old theme `SEPIA`/`DARK` → same; old `LIGHT` (it was the default, not a choice) → `auto`.

## Mapping to Readium
| Model | Readium Web (TS) `EpubPreferences` | Readium Kotlin `EpubPreferences` |
|---|---|---|
| size | `fontSize: pt / 12` | `fontSize = pt / 12.0` |
| font | `fontFamily: "serif" \| "sans-serif" \| "monospace" \| null` | `fontFamily = FontFamily("serif") …` or `null` |
| colours | `textColor`, `backgroundColor` (hex strings) | `textColor = Color(0xFF…)`, `backgroundColor = Color(0xFF…)` |
| theme | not used (explicit colours) | not used (explicit colours) |
