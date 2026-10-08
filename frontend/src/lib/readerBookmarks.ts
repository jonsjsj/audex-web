// Reading bookmarks, stored the way the Audex app stores them (docs/BOOKMARKS.md).
//
// Every bookmark lives in AUDIOBOOKSHELF, so Audex, Webdex and Codex all show the same ones, each with the time it
// was made and the app/device it was made on (lib/bookmarkTitle.ts):
//  * a book with an audiobook keeps them on the audio item as seconds: seconds = (how far through the book) ×
//    (audio duration) — the Audex app's own scheme (ReaderViewModel.addReadingBookmark);
//  * a book with no audio has no duration, so they sit on the ebook item as whole numbers:
//    time = round(fraction × EBOOK_SCALE), never 0 (Audiobookshelf refuses 0). Same scale in Audex (EbookBookmarks).
import { api } from "../api/client";
import { parseTitle } from "./bookmarkTitle";

export interface ReaderBookmark {
  /** Opaque, unique within a store (the audio second for ABS, the row id locally). */
  key: string;
  fraction: number; // 0..1 through the whole book
  /** The bookmark's own words (the app/device tag is split off into [origin]). */
  title: string;
  /** "Webdex · Chrome on Linux" — which app and device made it; null for one made by another client. */
  origin: string | null;
  createdAt: number | null;
  /** A "Left off" marker dropped automatically on a big jump, not one you made. */
  auto: boolean;
}

export interface BookmarkStore {
  /** Always true: bookmarks live in Audiobookshelf, so every app shows them. */
  synced: boolean;
  list(): Promise<ReaderBookmark[]>;
  add(fraction: number, title: string): Promise<void>;
  remove(b: ReaderBookmark): Promise<void>;
}

// Same values and wording as the Audex app (ReaderViewModel.kt), so its markers
// and ours are recognised — and pruned — by both.
export const AUTO_PREFIX = "Left off · ";
/** A jump of more than this fraction of the book auto-drops a "Left off" marker. */
export const JUMP_THRESHOLD = 0.015;
const MAX_AUTO = 5;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
export const bookmarkTitle = (fraction: number) => `Bookmark · ${Math.round(fraction * 100)}%`;

/** Scale for a book with no audio: bookmark time = fraction × this. Identical in the Audex app. */
export const EBOOK_SCALE = 100000;

function absBookmarks(itemId: string, scale: number, timeFor: (fraction: number) => number): BookmarkStore {
  return {
    synced: true,
    async list() {
      const rows = await api.bookmarks(itemId);
      return rows.map((b) => {
        const p = parseTitle(b.title);
        return {
          key: String(b.timeS),
          fraction: clamp01(b.timeS / scale),
          title: p.note,
          origin: p.origin,
          createdAt: b.createdAt,
          auto: p.note.startsWith(AUTO_PREFIX),
        };
      });
    },
    async add(fraction, title) {
      await api.addBookmark(itemId, { timeS: timeFor(clamp01(fraction)), title });
    },
    async remove(b) {
      await api.removeBookmark(itemId, Number(b.key));
    },
  };
}

/** A book with an audiobook: bookmarks are audio seconds on the audio item. */
export function absStore(audioItemId: string, durationS: number): BookmarkStore {
  return absBookmarks(audioItemId, durationS, (f) => Math.max(1, Math.floor(f * durationS)));
}

/** A book with no audio: bookmarks sit on the ebook item as fraction × EBOOK_SCALE. */
export function ebookStore(itemId: string): BookmarkStore {
  return absBookmarks(itemId, EBOOK_SCALE, (f) => Math.max(1, Math.round(f * EBOOK_SCALE)));
}

/** Older versions kept an ebook-only book's bookmarks in audex-web's own database, visible to nobody else. Move
 *  them into Audiobookshelf (they take the time they're moved) and clear the local copy. Returns how many moved. */
export async function moveLocalBookmarks(itemId: string, store: BookmarkStore): Promise<number> {
  const local = await api.readerBookmarks(itemId).catch(() => []);
  let moved = 0;
  for (const b of local) {
    try {
      await store.add(b.fraction, b.title);
      await api.removeReaderBookmark(itemId, b.id);
      moved++;
    } catch {
      break; // Audiobookshelf unreachable: keep the rest locally, try again next time
    }
  }
  return moved;
}

/** Drop a "Left off" marker at [from] — where you were before a big jump — unless
 *  one is already close by, then keep only the most recent few. Mirrors the Audex
 *  app (autoBookmark): an accidental slider drag should never lose your place. */
export async function dropLeftOff(store: BookmarkStore, existing: ReaderBookmark[], from: number): Promise<void> {
  if (existing.some((b) => b.auto && Math.abs(b.fraction - from) < JUMP_THRESHOLD)) return;
  await store.add(from, `${AUTO_PREFIX}${Math.round(from * 100)}%`);
  const autos = (await store.list()).filter((b) => b.auto).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const old of autos.slice(0, Math.max(0, autos.length - MAX_AUTO))) {
    await store.remove(old).catch(() => {});
  }
}
