import type { SyncMap, SyncMapEntry } from "../api/client";
import { chapterFor } from "./syncMap";

/** Word-by-word read-along (Audex has the same): while the audiobook plays, the sentence being read is faintly
 *  marked in the book and the word being spoken lights up.
 *
 *  Painted with the browser's CSS Custom Highlight API inside the book's own frame — the book's text is never
 *  changed, so Readium's pages, positions and selections stay exactly as they were. A browser without the API
 *  simply shows no highlight. The map's `words` are [offset within the sentence, audio second]. */

const WORD = "audex-ra-word";
const SENTENCE = "audex-ra-sentence";
const STYLE_ID = "audex-ra-style";

interface Folded {
  text: string; // folded (lower case, one space, plain quotes/dashes)
  at: number[]; // folded index → raw index
}

interface DocIndex {
  raw: string;
  nodes: Text[];
  starts: number[]; // raw index where each text node begins
  folded: Folded;
}

const ZERO_WIDTH = new Set(["⁠", "​", "­"]);

/** The same folding as syncMap.foldForMatch, but remembering where each folded character came from. */
function fold(raw: string): Folded {
  let text = "";
  const at: number[] = [];
  let pendingSpace = -1;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (ZERO_WIDTH.has(c)) continue;
    const ch = c === "‘" || c === "’" ? "'" : c === "“" || c === "”" ? '"' : c === "–" || c === "—" ? "-" : c;
    if (/\s/.test(ch)) {
      if (text.length > 0 && pendingSpace < 0) pendingSpace = i;
      continue;
    }
    if (pendingSpace >= 0) {
      text += " ";
      at.push(pendingSpace);
      pendingSpace = -1;
    }
    const low = ch.toLowerCase();
    for (let k = 0; k < low.length; k++) {
      text += low[k];
      at.push(i);
    }
  }
  return { text, at };
}

const indexes = new WeakMap<Document, DocIndex>();
const sentenceAt = new WeakMap<Document, Map<SyncMapEntry, { sent: Folded; at: number }>>();
let painted: { doc: Document | null; entry: SyncMapEntry | null; word: number; ok: boolean } = {
  doc: null,
  entry: null,
  word: -1,
  ok: false,
};

function indexOf(doc: Document): DocIndex | null {
  const hit = indexes.get(doc);
  if (hit) return hit;
  if (!doc.body) return null;
  const nodes: Text[] = [];
  const starts: number[] = [];
  let raw = "";
  const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n as Text;
    const parent = t.parentElement?.tagName;
    if (parent === "SCRIPT" || parent === "STYLE") continue;
    nodes.push(t);
    starts.push(raw.length);
    raw += t.data;
  }
  const idx = { raw, nodes, starts, folded: fold(raw) };
  indexes.set(doc, idx);
  return idx;
}

/** Raw index → (text node, offset). */
function point(idx: DocIndex, rawAt: number): [Text, number] | null {
  let lo = 0;
  let hi = idx.starts.length - 1;
  if (hi < 0) return null;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (idx.starts[mid] <= rawAt) lo = mid;
    else hi = mid - 1;
  }
  const node = idx.nodes[lo];
  return [node, Math.min(node.data.length, rawAt - idx.starts[lo])];
}

function rangeOf(doc: Document, idx: DocIndex, rawStart: number, rawEnd: number): Range | null {
  const a = point(idx, rawStart);
  const b = point(idx, Math.max(rawStart, rawEnd - 1));
  if (!a || !b) return null;
  const r = doc.createRange();
  r.setStart(a[0], a[1]);
  r.setEnd(b[0], Math.min(b[0].data.length, b[1] + 1));
  return r;
}

/** Where the sentence sits in the frame's folded text: the occurrence nearest to where the map says it is. */
function findSentence(idx: DocIndex, sentence: string, nearFraction: number): number {
  const hay = idx.folded.text;
  if (!sentence || sentence.length < 2) return -1;
  const near = nearFraction * hay.length;
  let best = -1;
  let bestD = Infinity;
  for (let from = 0, n = 0; n < 50; n++) {
    const i = hay.indexOf(sentence, from);
    if (i < 0) break;
    const d = Math.abs(i - near);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
    from = i + 1;
  }
  return best;
}

type HighlightWindow = Window & {
  CSS?: { highlights?: Map<string, unknown> };
  Highlight?: new (...ranges: Range[]) => unknown;
};

function ensureStyle(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `::highlight(${SENTENCE}) { background-color: rgba(214, 140, 60, 0.13); }` +
    `::highlight(${WORD}) { background-color: rgba(214, 140, 60, 0.42); }`;
  (doc.head ?? doc.documentElement).appendChild(style);
}

export function clearHighlight(win: Window | null | undefined) {
  const w = win as HighlightWindow | null | undefined;
  painted = { doc: null, entry: null, word: -1, ok: false };
  try {
    w?.CSS?.highlights?.delete(WORD);
    w?.CSS?.highlights?.delete(SENTENCE);
  } catch {
    /* frame gone */
  }
}

/** The word of [entry] being spoken at [seconds]: its [start, end) within the sentence text, or null. */
export function wordSpan(entry: SyncMapEntry, seconds: number): [number, number] | null {
  const words = entry.words;
  const text = entry.text ?? "";
  if (!words || words.length === 0 || !text) return null;
  let i = -1;
  for (let k = 0; k < words.length; k++) {
    if (words[k][1] <= seconds) i = k;
    else break;
  }
  if (i < 0) return null;
  const start = words[i][0];
  let end = i + 1 < words.length ? words[i + 1][0] : text.length;
  while (end > start && /[\s]/.test(text[end - 1])) end--;
  // "fell —": the dash that follows a word isn't part of it.
  const tail = text.slice(start, end).match(/^(\S+)\s+[^\p{L}\p{N}\s]+$/u);
  if (tail) end = start + tail[1].length;
  return start < end ? [start, end] : null;
}

/** Paint the sentence and the spoken word in the frame showing [entry]'s chapter. Returns false when the sentence
 *  isn't on the page in this frame (another chapter, or text the map spells differently). */
export function paintHighlight(win: Window, frameHref: string, map: SyncMap, entry: SyncMapEntry, seconds: number): boolean {
  const w = win as HighlightWindow;
  if (!w.CSS?.highlights || !w.Highlight) return false;
  const chapter = chapterFor(map, frameHref);
  if (!chapter || chapter.href !== chapterFor(map, entry.href)?.href) {
    clearHighlight(win);
    return false;
  }
  const doc = win.document;
  const idx = indexOf(doc);
  if (!idx) return false;
  const word = wordSpan(entry, seconds);
  // Called every frame while playing: only repaint when the sentence or the word changes.
  if (painted.doc === doc && painted.entry === entry && painted.word === (word ? word[0] : -1)) return painted.ok;
  let found = sentenceAt.get(doc)?.get(entry);
  if (!found) {
    const sent = fold(entry.text ?? "");
    const span = chapter.c1 - chapter.c0;
    found = { sent, at: findSentence(idx, sent.text, span > 0 ? (entry.c0 - chapter.c0) / span : 0) };
    let m = sentenceAt.get(doc);
    if (!m) sentenceAt.set(doc, (m = new Map()));
    m.set(entry, found);
  }
  const { sent, at } = found;
  painted = { doc, entry, word: word ? word[0] : -1, ok: at >= 0 };
  if (at < 0) {
    clearHighlight(win);
    return false;
  }
  ensureStyle(doc);
  const rawStart = idx.folded.at[at];
  const rawEnd = idx.folded.at[at + sent.text.length - 1] + 1;
  const sentenceRange = rangeOf(doc, idx, rawStart, rawEnd);
  const highlights = w.CSS.highlights;
  if (sentenceRange) highlights.set(SENTENCE, new w.Highlight(sentenceRange));
  if (!word) {
    highlights.delete(WORD);
    return true;
  }
  // The word's place in the sentence's folded text, then in the frame's raw text.
  let f0 = sent.at.findIndex((r) => r >= word[0]);
  let f1 = sent.at.findIndex((r) => r >= word[1]);
  if (f0 < 0) {
    highlights.delete(WORD);
    return true;
  }
  if (f1 < 0) f1 = sent.text.length;
  if (sent.text[f0] === " ") f0++;
  if (f1 <= f0) {
    highlights.delete(WORD);
    return true;
  }
  const wordRange = rangeOf(doc, idx, idx.folded.at[at + f0], idx.folded.at[at + f1 - 1] + 1);
  if (wordRange) highlights.set(WORD, new w.Highlight(wordRange));
  return true;
}
