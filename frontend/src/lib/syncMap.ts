import { SyncMap } from "../api/client";

// Mirrors codexaudio's domain/reader/Alignment.kt SyncMap extension functions
// exactly (progressionAt/timeAtProgression) — same binary search, same
// interpolation, same edge-case handling — so a book's read-along behaves
// identically whether you're on the phone or in the browser. See
// docs/SYNC_API.md §3 for the map format itself.

/** The audio second at which book progression [p] (0..1 of the whole text)
 *  is narrated — for jumping the AUDIOBOOK to where you're READING. */
export function timeAtProgression(map: SyncMap, p: number): number | null {
  const entries = map.entries;
  if (entries.length === 0) return null;
  if (p <= entries[0].p) return entries[0].t0;
  if (p >= entries[entries.length - 1].p) return entries[entries.length - 1].t0;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].p <= p) lo = mid;
    else hi = mid;
  }
  const a = entries[lo];
  const b = entries[hi];
  const span = b.p - a.p;
  if (span <= 0) return a.t0;
  const f = clamp((p - a.p) / span, 0, 1);
  return a.t0 + (b.t0 - a.t0) * f;
}

/** Book progression (0..1) at audio second [seconds] — for following the
 *  page while LISTENING, or jumping the reader to where the audio is. */
export function progressionAt(map: SyncMap, seconds: number): number | null {
  const entries = map.entries;
  if (entries.length === 0) return null;
  if (seconds <= entries[0].t0) return entries[0].p;
  if (seconds >= entries[entries.length - 1].t0) return entries[entries.length - 1].p;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t0 <= seconds) lo = mid;
    else hi = mid;
  }
  const a = entries[lo];
  const b = entries[hi];
  const span = b.t0 - a.t0;
  if (span <= 0) return a.p;
  const f = clamp((seconds - a.t0) / span, 0, 1);
  return a.p + (b.p - a.p) * f;
}

/** The entry being narrated at [seconds] (nearest at-or-before by start
 *  time) — the anchor to highlight while audio is playing. */
export function entryAt(map: SyncMap, seconds: number): SyncMapEntryOrNull {
  const entries = map.entries;
  if (entries.length === 0 || seconds < entries[0].t0) return null;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].t0 <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return entries[lo];
}

type SyncMapEntry = SyncMap["entries"][number];
type SyncMapEntryOrNull = SyncMapEntry | null;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

// ── Exact positions (mirrors Alignment.kt's chapterFor / charAt / timeAtPage / titledChapterStarts) ───────────────

type SyncChapter = SyncMap["chapters"][number];

/** The map chapter for a reader [href] (tolerates a leading slash, a fragment and directory prefixes). */
export function chapterFor(map: SyncMap, href: string): SyncChapter | null {
  const chapters = map.chapters;
  if (!chapters || chapters.length === 0) return null;
  const want = href.split("#")[0].replace(/^\/+/, "");
  const trim = (h: string) => h.replace(/^\/+/, "");
  return (
    chapters.find((c) => trim(c.href) === want) ??
    chapters.find((c) => {
      const h = trim(c.href);
      return h.endsWith(`/${want}`) || want.endsWith(`/${h}`);
    }) ??
    chapters.find((c) => c.href.split("/").pop() === want.split("/").pop()) ??
    null
  );
}

/** The global character offset of [progression] (0..1) through chapter [href], or null with no matching chapter. */
export function charAt(map: SyncMap, href: string, progression: number): number | null {
  const chapter = chapterFor(map, href);
  if (!chapter) return null;
  const span = chapter.c1 - chapter.c0;
  if (span <= 0) return null;
  return chapter.c0 + Math.floor(clamp(progression, 0, 1) * span);
}

/** The audio second at which global character [c] is narrated (the map's `p` is c0 / totalChars). */
export function timeAtChar(map: SyncMap, c: number): number | null {
  if (!(map.totalChars > 0)) return null;
  return timeAtProgression(map, c / map.totalChars);
}

const PAGE_KEY_CHARS = 60;
const MIN_PAGE_KEY_CHARS = 10;

/** Text as the reader and the map may spell it differently: curly vs straight quotes, dashes, no-width marks,
 *  spacing, case. */
export function foldForMatch(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const raw of text) {
    if (raw === "⁠" || raw === "​" || raw === "­") continue;
    const ch =
      raw === "‘" || raw === "’" ? "'" : raw === "“" || raw === "”" ? '"' : raw === "–" || raw === "—" ? "-" : raw;
    if (/\s/.test(ch) || ch === " ") {
      if (out.length > 0) pendingSpace = true;
    } else {
      if (pendingSpace) {
        out += " ";
        pendingSpace = false;
      }
      out += ch.toLowerCase();
    }
  }
  return out;
}

/** The map sentence in [href]'s chapter whose text begins with [pageText], nearest to character [nearChar]. */
function sentenceStartingWith(map: SyncMap, href: string, pageText: string, nearChar: number): SyncMapEntry | null {
  const chapter = chapterFor(map, href);
  if (!chapter) return null;
  const key = foldForMatch(pageText).slice(0, PAGE_KEY_CHARS);
  if (key.length < MIN_PAGE_KEY_CHARS) return null;
  const entries = map.entries;
  let lo = 0;
  let hi = entries.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (entries[mid].c0 < chapter.c0) lo = mid + 1;
    else hi = mid;
  }
  let best: SyncMapEntry | null = null;
  let bestDistance = Infinity;
  for (let i = lo; i < entries.length && entries[i].c0 < chapter.c1; i++) {
    // A page often begins with a short sentence ("Yes."): read on into the next ones.
    let run = "";
    for (let j = i; j < entries.length && j < i + 8 && run.length < key.length; j++) {
      if (run) run += " ";
      run += foldForMatch(entries[j].text ?? "");
    }
    if (run.startsWith(key)) {
      const distance = Math.abs(entries[i].c0 - nearChar);
      if (distance < bestDistance) {
        best = entries[i];
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** PAGE-exact reading → audio: the second at which the page starting with [pageText] (the first text that begins on
 *  screen) is narrated. [progression] only picks between repeats of the same text and is the fallback when the text
 *  can't be found. A page's progression is a position in the rendered chapter, not in its characters, so on its own
 *  it lands tens of seconds off. */
export function timeAtPage(map: SyncMap, href: string, progression: number, pageText: string | null | undefined): number | null {
  const near = charAt(map, href, progression);
  if (near === null) return null;
  const exact = pageText ? sentenceStartingWith(map, href, pageText, near) : null;
  return exact ? exact.t0 : timeAtChar(map, near);
}

/** Where the narration at [seconds] sits in the text: the chapter file, how far through it (by characters) and the
 *  sentence being read — for opening the reader on the word being spoken. */
export function textTargetAt(map: SyncMap, seconds: number): { href: string; progression: number; text: string | null } | null {
  const entry = entryAt(map, seconds) ?? (map.entries.length > 0 ? map.entries[0] : null);
  if (!entry) return null;
  const chapter = chapterFor(map, entry.href);
  const span = chapter ? chapter.c1 - chapter.c0 : 0;
  const progression = chapter && span > 0 ? clamp((entry.c0 - chapter.c0) / span, 0, 1) : 0;
  // A one-word sentence ("Yes.") matches the wrong place in a chapter: lead with the next few sentences too.
  let text = (entry.text ?? "").trim();
  const i = map.entries.indexOf(entry);
  for (let j = i + 1; text.length < 40 && j < map.entries.length && j <= i + 4 && map.entries[j].href === entry.href; j++) {
    text = `${text} ${(map.entries[j].text ?? "").trim()}`.trim();
  }
  return { href: entry.href, progression, text: text || null };
}

export interface TitledStart {
  startS: number;
  title: string;
}

/** The audio's chapters named by the ebook's table of contents ([titles] = chapter file → name): each ebook chapter
 *  that is narrated starts where the map says its first sentence is spoken. Several contents entries that start at
 *  the same second (copyright, contents and a recap in one stretch of audio) become one chapter, named after the
 *  longest. Text that is never narrated (the appendices after the last sentence) is left out, and audio before the
 *  first chapter (the opening credits) is added as "Opening Credits". Empty when nothing could be placed. */
export function titledChapterStarts(map: SyncMap, titles: Record<string, string>, minChars = 1500): TitledStart[] {
  if (!map.chapters?.length || map.entries.length === 0 || Object.keys(titles).length === 0) return [];
  const narratedUntilS = map.entries[map.entries.length - 1].t0;
  const found: { startS: number; span: number; title: string }[] = [];
  for (const chapter of map.chapters) {
    const span = chapter.c1 - chapter.c0;
    if (span < minChars) continue;
    const title = titles[chapter.href.split("#")[0].split("/").pop() ?? ""];
    if (!title) continue;
    const start = timeAtChar(map, chapter.c0);
    if (start === null || start >= narratedUntilS) continue;
    found.push({ startS: start, span, title });
  }
  const out: TitledStart[] = [];
  let i = 0;
  while (i < found.length) {
    let j = i;
    let best = found[i];
    while (j + 1 < found.length && found[j + 1].startS - found[i].startS < 1.0) {
      j++;
      if (found[j].span > best.span) best = found[j];
    }
    if (out.length === 0 || best.startS > out[out.length - 1].startS + 1.0) out.push({ startS: found[i].startS, title: best.title });
    i = j + 1;
  }
  if (out.length > 0 && out[0].startS > 3.0) out.unshift({ startS: 0, title: "Opening Credits" });
  return out;
}
