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
| `font` | `publisher` · `serif` · `sans` · `mono` · `georgia` · `palatino` · `times` · `arial` · `verdana` · `courier` · `custom` | `publisher` (the book's own font) |
| `fontName` | a font name (letters, digits, space, `_`, `'`, `-`; ≤ 60) — used only when `font = custom` | empty |
| `lineSpacing` | 1.0 – 2.5 (step 0.1), or *book's own* | *book's own* (null) |
| `paragraphSpacing` | 0 – 2 (step 0.25), or *book's own* | *book's own* (null) |
| `letterSpacing` | 0 – 0.5 (step 0.05), or *book's own* | *book's own* (null) |
| `wordSpacing` | 0 – 1 (step 0.125), or *book's own* | *book's own* (null) |
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
A drop-down list, each name shown in its own typeface: *Book's own* (leave the book's font alone), *Serif*,
*Sans-serif*, *Monospace*, *Georgia*, *Palatino*, *Times New Roman*, *Arial*, *Verdana*, *Courier New* and
*Other…* (type any font name). `serif` / `sans` / `mono` are the CSS generics `serif` / `sans-serif` /
`monospace`; the named fonts use the font's name with a generic fallback (web) or the bare name (Android).
**Named fonts depend on the device** — one that isn't installed falls back to the device's default for that
kind (Android has no Georgia/Palatino/Times; its Serif and Sans-serif are always there).

### Spacing
Four sliders — *Line*, *Paragraph*, *Letter* and *Word* spacing — each with a **Reset** that returns it to
*the book's own* (the default; nothing is overridden until you move a slider). Values are passed straight to
Readium (`lineHeight`, `paragraphSpacing`, `letterSpacing`, `wordSpacing`). On Android, Readium only honours
these when `publisherStyles = false`, so the app sets that **only while at least one spacing is set**.

## Controls (both apps)
* **A− / A+** always reachable while reading; an **Appearance** panel holds: font size (number box + list +
  A−/A+ + *Normal*), font (list + *Other…* name box), spacing sliders, theme chips (*Auto (device), Light, Sepia, Dark, Custom*), the two colour pickers
  with a live sample, and *Reset to defaults*.
* A change applies to the open book immediately and is saved a moment later.

## Persistence and migration
* **Webdex** — `GET/PUT /api/settings` field `readerAppearance` (object above). The server validates and
  clamps everything. Older saves held a percent (`fontSize`, 100 = normal); it converts as
  `pt = round(percent × 12 / 100)`.
* **Audex** — DataStore keys `reader_font_pt`, `reader_theme2`, `reader_font`, `reader_font_name`,
  `reader_line_spacing`, `reader_para_spacing`, `reader_letter_spacing`, `reader_word_spacing`
  (absent = the book's own), `reader_text_color`, `reader_bg_color`. Migration from the old keys: `reader_font_pct` → `pt = round(pct × 12 / 100)`;
  old theme `SEPIA`/`DARK` → same; old `LIGHT` (it was the default, not a choice) → `auto`.

## Mapping to Readium
| Model | Readium Web (TS) `EpubPreferences` | Readium Kotlin `EpubPreferences` |
|---|---|---|
| size | `fontSize: pt / 12` | `fontSize = pt / 12.0` |
| font | `fontFamily`: the CSS stack for the choice, or `null` | `fontFamily = FontFamily("Georgia")` (bare name) …, or `null` |
| spacing | `lineHeight`, `paragraphSpacing`, `letterSpacing`, `wordSpacing` (null = unset) | same names; plus `publisherStyles = false` while any is set |
| colours | `textColor`, `backgroundColor` (hex strings) | `textColor = Color(0xFF…)`, `backgroundColor = Color(0xFF…)` |
| theme | not used (explicit colours) | not used (explicit colours) |
