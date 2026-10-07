// Whole-book reading progress, worked out from where you are INSIDE a chapter.
//
// Readium only knows how to report a position per reading-order item (chapter),
// so on its own a book with a handful of long chapters shows 0% for an hour,
// then jumps. The backend adds each chapter's text length to the manifest
// (`readingOrder[].properties.audexChars` — see epub.py's build_manifest), which
// lets us weight chapters properly: fraction = (text before this chapter + how
// far through it you are × its length) / total text.
//
// That fraction is what's written to Audiobookshelf as `ebookProgress` (and so
// what Codex and the Audex app show), and what the progress slider seeks by.

export interface SpineWeights {
  hrefs: string[]; // reading order, fragment-free
  types: string[];
  /** Text length of each chapter. */
  chars: number[];
  /** Text length BEFORE each chapter (starts[i] + chars[i] === starts[i + 1]). */
  starts: number[];
  total: number;
}

interface RawLink {
  href?: unknown;
  type?: unknown;
  properties?: { audexChars?: unknown };
}

const stripFragment = (href: string) => href.split("#")[0];

/** Null when the server didn't send chapter lengths (an older backend) — callers
 *  then fall back to Readium's own chapter-granular totalProgression. */
export function buildSpineWeights(manifestJson: Record<string, unknown>): SpineWeights | null {
  const order = manifestJson.readingOrder;
  if (!Array.isArray(order) || order.length === 0) return null;
  const hrefs: string[] = [];
  const types: string[] = [];
  const chars: number[] = [];
  for (const raw of order as RawLink[]) {
    const n = Number(raw?.properties?.audexChars);
    if (typeof raw?.href !== "string" || !Number.isFinite(n) || n <= 0) return null;
    hrefs.push(stripFragment(raw.href));
    types.push(typeof raw.type === "string" ? raw.type : "application/xhtml+xml");
    chars.push(n);
  }
  const starts: number[] = [];
  let acc = 0;
  for (const n of chars) {
    starts.push(acc);
    acc += n;
  }
  return { hrefs, types, chars, starts, total: acc };
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Whole-book fraction for "[progression] (0..1) of the way through chapter [href]". */
export function totalFromLocation(w: SpineWeights, href: string, progression: number): number | null {
  const i = w.hrefs.indexOf(stripFragment(href));
  if (i < 0) return null;
  return clamp01((w.starts[i] + clamp01(progression) * w.chars[i]) / w.total);
}

/** The inverse: which chapter, and how far through it, a whole-book fraction lands on. */
export function locationFromTotal(
  w: SpineWeights,
  total: number,
): { href: string; type: string; progression: number; index: number } {
  const target = clamp01(total) * w.total;
  let i = w.hrefs.length - 1;
  for (let k = 0; k < w.hrefs.length; k++) {
    if (target < w.starts[k] + w.chars[k]) {
      i = k;
      break;
    }
  }
  return {
    href: w.hrefs[i],
    type: w.types[i],
    progression: clamp01((target - w.starts[i]) / w.chars[i]),
    index: i,
  };
}
