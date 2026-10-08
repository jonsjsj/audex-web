// Chapter names and numbers for an audiobook's chapter list — the same rules as the Audex app (docs/CHAPTERS.md).
//
// Audiobook chapter lists mix real chapters with front and back matter (opening credits, contents, dedication,
// prologue, epilogue, acknowledgements…). Numbering by list position makes the book's Chapter 25 show as 26.
// Instead each chapter carries the BOOK's number: one it already names ("Chapter 33", "33. The Gate") is kept,
// and an unnumbered one takes the next number after the previous chapter. Front/back matter is its own named
// entry with no number, like the contents of a printed book. The label reads "Chapter 33: The Gate".

export interface LabeledChapter {
  /** The book's chapter number, or null for front/back matter ("Contents", "Prologue"…). */
  number: number | null;
  /** The chapter's own name without any "Chapter N" ("The Gate"); for front/back matter, its title. */
  name: string;
  /** What to show: "Chapter 33: The Gate", "Chapter 33", or the plain title for front/back matter. */
  label: string;
}

const MATTER = new RegExp(
  "^(?:the\\s+)?(?:opening\\s+credits|end\\s+credits|credits|title\\s+page|copyright(?:\\s+page)?|dedication|" +
    "(?:table\\s+of\\s+)?contents|epigraph|foreword|preface|prologue|introduction|intro|maps?|" +
    "acknowledge?ments?|about\\s+the\\s+authors?|authors?'?s?\\s+notes?|epilogue|afterword|glossary|" +
    "cast(?:\\s+of\\s+characters)?|also\\s+by\\b.*|excerpt\\b.*|preview\\b.*|appendix\\b.*|the\\s+end|" +
    "part\\s+(?:\\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\\b.*)?)\\s*[.:!]?$",
  "i",
);

const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/** "25" → 25, "twenty-five" → 25, "Twelve" → 12; null when it isn't a number. */
function parseNumber(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^\d{1,4}$/.test(t)) return Number(t);
  const parts = t.split(/[\s-]+/);
  if (parts.length === 1 && WORDS[parts[0]]) return WORDS[parts[0]];
  if (parts.length === 2 && WORDS[parts[0]] >= 20 && WORDS[parts[1]] && WORDS[parts[1]] < 10) return WORDS[parts[0]] + WORDS[parts[1]];
  return null;
}

const SEP = "\\s*[:.\\-–—]?\\s*";
const CHAPTER_N = new RegExp(`^(?:chapter|ch\\.?)\\s+([a-z0-9-]+(?:\\s[a-z]+)?)${SEP}(.*)$`, "i");
const NUMBER_ONLY = /^(\d{1,4})\s*(?:[:.\-–—]\s*(.*))?$/;

export function labelChapters(titles: string[]): LabeledChapter[] {
  let next = 1;
  return titles.map((raw) => {
    const title = raw.trim();
    if (MATTER.test(title)) return { number: null, name: title, label: title };
    let number: number | null = null;
    let name = title;
    const m = CHAPTER_N.exec(title);
    if (m) {
      // "Chapter 33: The Gate" / "Chapter Thirty-Three". The word list can eat the first word of the name
      // ("Chapter 5 The Gate"), so try the number alone before the number plus one more word.
      const words = m[1].split(/\s+/);
      const alone = parseNumber(words[0]);
      if (alone !== null && words.length > 1) {
        number = alone;
        name = `${words.slice(1).join(" ")}${m[2] ? ` ${m[2]}` : ""}`.trim();
      } else {
        number = parseNumber(m[1]);
        name = m[2].trim();
      }
    } else {
      const n = NUMBER_ONLY.exec(title);
      if (n) {
        number = Number(n[1]);
        name = (n[2] ?? "").trim();
      }
    }
    if (number === null) number = next; // an unnumbered chapter: the next number in the book's own count
    next = number + 1;
    return { number, name, label: name ? `Chapter ${number}: ${name}` : `Chapter ${number}` };
  });
}

/** Index of the chapter playing at [positionS] (the last one that has started), or -1 with no chapters. */
export function chapterIndexAt(chapters: { startS: number }[], positionS: number): number {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].startS <= positionS + 0.001) idx = i;
    else break;
  }
  return idx;
}

/** Where "previous chapter" goes: the start of this chapter, or — within the first few seconds of it — the one
 *  before. Null when there is nowhere to go. */
export function previousChapterStart(chapters: { startS: number }[], positionS: number): number | null {
  const i = chapterIndexAt(chapters, positionS);
  if (i < 0) return null;
  if (positionS - chapters[i].startS > 3 || i === 0) return chapters[i].startS;
  return chapters[i - 1].startS;
}

/** Where "next chapter" goes, or null at the last chapter. */
export function nextChapterStart(chapters: { startS: number }[], positionS: number): number | null {
  const i = chapterIndexAt(chapters, positionS);
  return i >= 0 && i + 1 < chapters.length ? chapters[i + 1].startS : null;
}
